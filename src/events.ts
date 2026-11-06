/**
 * Which recurring event a new adventure belongs to.
 *
 * Event reminders group adventures by their event, so an adventure with no
 * event, or a misspelled one, silently drops out of next year's reminder. So
 * every adventure the planner creates is checked:
 *
 *   - its event already exists              → nothing to do (Send Reminder? is
 *                                              copied from that event if blank)
 *   - no event, but its name minus the year
 *     names an existing one ("Big Stick 27") → filed there, silently
 *   - otherwise                             → one Telegram question: which event,
 *                                              a new one, or a one-off
 *
 * The answer comes by button or in words: an existing event's name picks it,
 * "one-off" marks it as one, and anything else creates a new event by that name.
 */

import type { Schema } from './planner'
import type { EventReminderConfig } from './reminders'
import { store, type StoreRecord } from './store'
import { acknowledgeButton, sendPlain, sendWithButtons } from './notify'

export const EVENT_CALLBACK = 'evt:'

/** Existing events offered as buttons, most recent first. */
const MAX_EXISTING = 6

type Answer = { kind: 'existing' | 'new'; name: string } | { kind: 'oneoff' }

interface Question {
  recordId: string
  adventure: string
  options: Answer[]
}

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }))
const norm = (v: unknown) => String(v ?? '').trim()
const key = (s: string) => norm(s).toLowerCase()

/** "Desert Hearts 26" → "Desert Hearts"; "Las Vegas 6/26" → "Las Vegas"; "Burning Man 2027" → "Burning Man". */
export function eventNameFrom(adventureName: string): string {
  return norm(adventureName)
    .replace(/\s+(?:'?\d{2}|\d{4}|\d{1,2}\/\d{2,4})$/, '')
    .trim()
}

export interface KnownEvent {
  name: string
  latest: string
  optIn: unknown
}

/** Every event in use, keyed case-insensitively, with its newest adventure's date and opt-in. */
export function knownEvents(c: EventReminderConfig, records: StoreRecord[], except?: string): Map<string, KnownEvent> {
  const out = new Map<string, KnownEvent>()
  for (const r of records) {
    if (r.id === except) continue
    const name = norm(r.fields[c.eventField])
    if (!name) continue
    const date = norm(r.fields[c.dateField]).slice(0, 10)
    const prev = out.get(key(name))
    if (!prev || date > prev.latest) out.set(key(name), { name, latest: date, optIn: r.fields[c.optInField] })
  }
  return out
}

/** What to do about a newly created adventure: nothing, file it, or ask. */
export function decide(
  c: EventReminderConfig,
  adventure: StoreRecord,
  events: Map<string, KnownEvent>
): { action: 'none' } | { action: 'assign'; event: KnownEvent } | { action: 'ask'; options: Answer[] } {
  const named = norm(adventure.fields[c.eventField])
  if (named && events.has(key(named))) return { action: 'none' }

  const guess = eventNameFrom(norm(adventure.fields[c.nameField]))
  if (!named && guess && events.has(key(guess))) return { action: 'assign', event: events.get(key(guess))! }

  const proposed = named || guess
  const existing = [...events.values()]
    .filter((e) => key(e.name) !== key(proposed))
    .sort((a, b) => b.latest.localeCompare(a.latest))
    .slice(0, MAX_EXISTING)
  return {
    action: 'ask',
    options: [
      ...(proposed ? [{ kind: 'new' as const, name: proposed }] : []),
      ...existing.map((e) => ({ kind: 'existing' as const, name: e.name })),
      { kind: 'oneoff' as const },
    ],
  }
}

/** Read a typed answer against the events that exist. */
export function interpretReply(text: string, events: Map<string, KnownEvent>): Answer {
  const t = norm(text)
  if (/^(one[\s-]?off|none|no event|not an event|n\/a|skip)$/i.test(t)) return { kind: 'oneoff' }
  const hit = events.get(key(t))
  return hit ? { kind: 'existing', name: hit.name } : { kind: 'new', name: t }
}

/** The fields an answer writes: the event, and whether next year reminds. */
export function fieldsFor(c: EventReminderConfig, schema: Schema, answer: Answer, events: Map<string, KnownEvent>): Record<string, unknown> {
  const table = schema.tables.find((t) => t.key === c.table || t.name === c.table)
  const checkbox = table?.fields.find((f) => f.name === c.optInField)?.type === 'checkbox'
  const yes = checkbox ? true : (c.optInValues?.[0] ?? 'Yes')
  const no = checkbox ? false : (c.optOutValue ?? 'No')
  if (answer.kind === 'oneoff') return { [c.eventField]: null, [c.optInField]: no }
  if (answer.kind === 'new') return { [c.eventField]: answer.name, [c.optInField]: yes }
  const known = events.get(key(answer.name))
  const copied = known?.optIn !== undefined && known?.optIn !== null && known?.optIn !== '' ? known.optIn : yes
  return { [c.eventField]: known?.name ?? answer.name, [c.optInField]: copied }
}

const label = (a: Answer) => (a.kind === 'oneoff' ? 'One-off (no event)' : a.kind === 'new' ? `🆕 New event: ${a.name}` : a.name)

function config(schema: Schema) {
  const c = schema.reminders?.events
  const table = c && schema.tables.find((t) => t.key === c.table || t.name === c.table)
  return c && table ? { c, table } : null
}

// ------------------------------------------------------------ the check ----

/** Run after the planner creates an adventure. Never throws: a capture is already saved. */
export async function checkNewAdventure(env: Env, schema: Schema, recordId: string): Promise<void> {
  const cfg = config(schema)
  if (!cfg) return
  const { c, table } = cfg
  try {
    const s = store(env)
    const adventure = await s.get(table.name, recordId)
    const events = knownEvents(c, await s.list(table.name), recordId)
    const d = decide(c, adventure, events)

    if (d.action === 'none') {
      // The event exists; make sure next year's reminder follows it.
      const optIn = adventure.fields[c.optInField]
      if (optIn === undefined || optIn === null || optIn === '') {
        const named = norm(adventure.fields[c.eventField])
        await s.update(table.name, recordId, fieldsFor(c, schema, { kind: 'existing', name: named }, events), 'system')
      }
      return
    }
    if (d.action === 'assign') {
      await s.update(table.name, recordId, fieldsFor(c, schema, { kind: 'existing', name: d.event.name }, events), 'system')
      log('event.assigned', { recordId, name: d.event.name })
      return
    }

    const name = norm(adventure.fields[c.nameField]) || 'this adventure'
    const text = `Which event is “${name}” for?\n\nPick one, or reply with the event's name. A new name starts a new yearly event, with a reminder a month before next year's.`
    const messageId = await sendWithButtons(
      env,
      text,
      d.options.map((o, i) => ({ text: label(o), callback_data: `${EVENT_CALLBACK}${i}` }))
    )
    if (messageId === null) return
    const q: Question = { recordId, adventure: name, options: d.options }
    await env.STATE.put(`evq:${messageId}`, JSON.stringify(q), { expirationTtl: 30 * 24 * 60 * 60 })
    await env.STATE.put('ask:last', JSON.stringify({ kind: 'event', messageId }), { expirationTtl: 7 * 24 * 60 * 60 })
    log('event.asked', { recordId, options: d.options.length })
  } catch (err) {
    log('event.check_failed', { recordId, message: err instanceof Error ? err.message : String(err) })
  }
}

// -------------------------------------------------------------- answers ----

async function applyAnswer(env: Env, schema: Schema, q: Question, answer: Answer): Promise<string> {
  const cfg = config(schema)
  if (!cfg) return 'Event reminders are not configured'
  const { c, table } = cfg
  const s = store(env)
  const events = knownEvents(c, await s.list(table.name), q.recordId)
  await s.update(table.name, q.recordId, fieldsFor(c, schema, answer, events), 'you')
  log('event.answered', { recordId: q.recordId, kind: answer.kind })
  if (answer.kind === 'oneoff') return `${q.adventure}: a one-off, no yearly reminder`
  if (answer.kind === 'new') return `${q.adventure}: new event “${answer.name}”, reminder on for next year`
  return `${q.adventure}: filed under ${events.get(key(answer.name))?.name ?? answer.name}`
}

export const isEventTap = (data: string) => data.startsWith(EVENT_CALLBACK)

export async function handleEventTap(
  env: Env,
  schema: Schema,
  tap: {
    id: string
    data: string
    message: { message_id: number; chat: { id: number }; reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> } }
  }
): Promise<void> {
  let text = 'That question has expired'
  let keyboard: Array<Array<{ text: string; callback_data?: string }>> = []
  const stored = await env.STATE.get(`evq:${tap.message.message_id}`)
  if (stored) {
    const q = JSON.parse(stored) as Question
    const answer = q.options[Number(tap.data.slice(EVENT_CALLBACK.length))]
    if (answer) {
      try {
        text = await applyAnswer(env, schema, q, answer)
        await forget(env, tap.message.message_id)
      } catch (err) {
        text = 'Could not save that — try again'
        keyboard = tap.message.reply_markup?.inline_keyboard ?? []
        log('event.tap_failed', { message: err instanceof Error ? err.message : String(err) })
      }
    }
  }
  // Answered: every button goes, since one question has one answer.
  await acknowledgeButton(env, {
    callbackQueryId: tap.id,
    chatId: tap.message.chat.id,
    messageId: tap.message.message_id,
    text,
    keyboard,
    tapped: tap.data,
  })
  await sendPlain(env, `✅ ${text}`)
}

/**
 * A typed message that answers an event question: a reply to one, or the next
 * message after one was asked. Returns false when there is no open event
 * question, so the caller can treat the text as anything else.
 */
export async function handleEventReply(env: Env, schema: Schema, text: string, replyTo?: number): Promise<boolean> {
  // A reply names its question. A plain message answers whichever question
  // was asked last — but only if that was an event question.
  let messageId = replyTo
  if (messageId === undefined) {
    const last = JSON.parse((await env.STATE.get('ask:last')) ?? 'null') as { kind: string; messageId?: number } | null
    if (last?.kind !== 'event' || last.messageId === undefined) return false
    messageId = last.messageId
  }
  const stored = await env.STATE.get(`evq:${messageId}`)
  if (!stored) return false
  const cfg = config(schema)
  if (!cfg) return false

  const q = JSON.parse(stored) as Question
  const events = knownEvents(cfg.c, await store(env).list(cfg.table.name), q.recordId)
  const result = await applyAnswer(env, schema, q, interpretReply(text, events))
  await forget(env, messageId)
  await sendPlain(env, `✅ ${result}`)
  return true
}

async function forget(env: Env, messageId: number): Promise<void> {
  await env.STATE.delete(`evq:${messageId}`)
  const last = JSON.parse((await env.STATE.get('ask:last')) ?? 'null') as { kind: string; messageId?: number } | null
  if (last?.kind === 'event' && last.messageId === messageId) await env.STATE.delete('ask:last')
}
