/**
 * Reminders: what the Airtable automations used to do, over Telegram.
 *
 *   Event reminders   A month before a recurring event, everything you learned
 *                     at every past year of it. Replaces "Learning Reminder":
 *                     an event whose newest adventure is opted in triggers
 *                     `monthsAfter` months after that adventure's date, and
 *                     every year after on the same day; the message
 *                     gathers every adventure under the same event, newest
 *                     first — one message per event, not one per past year.
 *
 *   On this day       The journal entry from exactly N years ago. Replaces
 *                     "This Day 1 Year".
 *
 * Both are configured in schema.json under `reminders`, so they work on any
 * install whose tables are named differently, and both are pure functions of
 * the records and the date — the cron decides when, these decide what.
 */

import type { SchemaTable } from './planner'
import type { StoreRecord } from './store'

export interface EventReminderConfig {
  table: string
  /** Names the recurring event an adventure belongs to ("Burning Man"). */
  eventField: string
  nameField: string
  dateField: string
  bodyField: string
  /** The adventure is opted in when this field is true or one of optInValues. */
  optInField: string
  optInValues?: string[]
  /** What a one-off gets in optInField, when it is not a checkbox. Defaults to "No". */
  optOutValue?: string
  /** Months after an adventure's date that the reminder for the next one goes out. */
  monthsAfter: number
}

export interface OnThisDayConfig {
  table: string
  dateField: string
  /** Which anniversaries get a message: [1] is "one year ago today". */
  years: number[]
}

export interface RemindersConfig {
  events?: EventReminderConfig
  onThisDay?: OnThisDayConfig
}

/** Telegram's limit is 4096; leave room for the part header. */
const MESSAGE_MAX = 3800

/**
 * A reminder is due when its mark falls within the last few days. The
 * tolerance covers a day or two of the Worker not running without ever
 * re-sending: each event and mark is claimed once (by the caller).
 */
export const EVENT_WINDOW_DAYS = 3

const norm = (v: unknown) => String(v ?? '').trim()
const dayOf = (v: unknown) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null)

/** Add calendar months, clamping to the month's last day (Jan 31 + 1 month = Feb 28). */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number)
  const total = y * 12 + (m - 1) + months
  const year = Math.floor(total / 12)
  const month = total % 12
  const last = new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(Math.min(d, last)).padStart(2, '0')}`
}

const addDays = (day: string, n: number) => {
  const t = new Date(`${day}T00:00:00Z`)
  t.setUTCDate(t.getUTCDate() + n)
  return t.toISOString().slice(0, 10)
}

export const prettyDay = (day: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(
    new Date(`${day}T00:00:00Z`)
  )

/** Split text into Telegram-sized messages on paragraph breaks, then lines, then hard. */
export function chunk(text: string, max = MESSAGE_MAX): string[] {
  if (text.length <= max) return [text]
  const out: string[] = []
  let current = ''
  for (const para of text.split(/\n(?=\n)/)) {
    if ((current + para).length <= max) {
      current += para
      continue
    }
    if (current) out.push(current.trim())
    current = ''
    let rest = para
    while (rest.length > max) {
      const cut = rest.lastIndexOf('\n', max) > max / 2 ? rest.lastIndexOf('\n', max) : max
      out.push(rest.slice(0, cut).trim())
      rest = rest.slice(cut)
    }
    current = rest
  }
  if (current.trim()) out.push(current.trim())
  return out.length > 1 ? out.map((m, i) => `(${i + 1}/${out.length}) ${m}`) : out
}

// ------------------------------------------------------------- events ----

export interface DueEvent {
  event: string
  /** The day the reminder became due: the newest opted-in adventure's date + monthsAfter. */
  mark: string
  /** Every adventure under this event, newest first. */
  adventures: StoreRecord[]
}

const optedIn = (c: EventReminderConfig, r: StoreRecord) => {
  const v = r.fields[c.optInField]
  if (v === true) return true
  return (c.optInValues ?? ['Yes']).some((x) => x.toLowerCase() === norm(v).toLowerCase())
}

/** Events whose reminder falls due within the window ending today. */
export function dueEvents(c: EventReminderConfig, records: StoreRecord[], today: string): DueEvent[] {
  const byEvent = new Map<string, StoreRecord[]>()
  for (const r of records) {
    const event = norm(r.fields[c.eventField])
    if (!event || !dayOf(r.fields[c.dateField])) continue
    const key = event.toLowerCase()
    byEvent.set(key, [...(byEvent.get(key) ?? []), r])
  }
  const earliest = addDays(today, -(EVENT_WINDOW_DAYS - 1))
  const due: DueEvent[] = []
  for (const list of byEvent.values()) {
    list.sort((a, b) => dayOf(b.fields[c.dateField])!.localeCompare(dayOf(a.fields[c.dateField])!))
    // Only the newest adventure decides: older ones' marks passed long ago,
    // and a newer adventure that opted out means the event was dropped.
    const newest = list[0]
    if (!optedIn(c, newest)) continue
    // The event recurs yearly whether or not last year's was recorded, so the
    // mark rolls forward a year at a time from the newest adventure. Opting
    // the newest one out is how an event is dropped.
    const anchor = dayOf(newest.fields[c.dateField])!
    const yearsSince = Math.max(0, Number(today.slice(0, 4)) - Number(anchor.slice(0, 4)) - 1)
    for (let k = yearsSince; k <= yearsSince + 2; k++) {
      const mark = addMonths(anchor, c.monthsAfter + 12 * k)
      if (mark >= earliest && mark <= today) {
        due.push({ event: norm(newest.fields[c.eventField]), mark, adventures: list })
        break
      }
    }
  }
  return due
}

export function eventMessages(c: EventReminderConfig, due: DueEvent): string[] {
  const sections = due.adventures
    .filter((r) => norm(r.fields[c.bodyField]))
    .map((r) => {
      const name = norm(r.fields[c.nameField]) || due.event
      const day = dayOf(r.fields[c.dateField])
      return `${name}${day ? ` (${prettyDay(day)})` : ''}\n${norm(r.fields[c.bodyField])}`
    })
  const head = `Things to remember for ${due.event}\n\nIt's that time of year again: about a month out from ${due.event}. Here's what you wanted to remember, newest first.`
  return chunk(sections.length ? `${head}\n\n${sections.join('\n\n')}` : `${head}\n\n(No learnings were recorded.)`)
}

// -------------------------------------------------------- on this day ----

/** The same date N years earlier; Feb 29 falls back to Feb 28. */
export function yearsBefore(day: string, n: number): string {
  return addMonths(day, -12 * n)
}

export function onThisDay(c: OnThisDayConfig, records: StoreRecord[], today: string): Array<{ years: number; record: StoreRecord }> {
  const out: Array<{ years: number; record: StoreRecord }> = []
  for (const years of [...c.years].sort((a, b) => a - b)) {
    const target = yearsBefore(today, years)
    for (const r of records) if (dayOf(r.fields[c.dateField]) === target) out.push({ years, record: r })
  }
  return out
}

/**
 * The entry as a message: short fields on one line under the header, then
 * each long one as its own paragraph — the shape the Airtable email had.
 */
export function onThisDayMessage(t: SchemaTable, c: OnThisDayConfig, years: number, r: StoreRecord): string[] {
  const day = dayOf(r.fields[c.dateField])!
  const short: string[] = []
  const long: string[] = []
  for (const f of t.fields) {
    if (f.name === c.dateField) continue
    const v = r.fields[f.name]
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue
    const text = Array.isArray(v) ? v.map(norm).join(', ') : norm(v)
    if (f.type === 'multilineText' || f.type === 'richText') long.push(text)
    else if (f.type !== 'checkbox' && f.type !== 'number') short.push(text)
  }
  const head = `This day ${years} year${years === 1 ? '' : 's'} ago: ${prettyDay(day)}`
  return chunk([head, short.join(' — '), ...long].filter(Boolean).join('\n\n'))
}
