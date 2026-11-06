/**
 * Entry points.
 *
 *   cron            polls Pocket's API every two minutes — the primary path
 *   POST /          Pocket webhook — a bonus when it happens to be working
 *   POST /telegram  a button tap or a typed reply
 *
 * All three funnel into the same capture path.
 *
 *   npx wrangler tail    watch it work
 */
import {
  schema,
  buildContext,
  checkPocketHealth,
  checkWebhookHealth,
  processCapture,
  resolveCapture,
  sweepRedos,
  log,
} from './capture'
import { getRecording, listRecordings } from './pocket'
import { claimDailyRun, holdTranscription, isHandled, markHandled, transcriptionHeld, lastQuestion, clearLastQuestion, questionFor } from './state'
import { acknowledgeTap, decodeCallback, sendPlain } from './notify'
import { handleTaskTap, isTaskTap, runNightlyBackup, sendMorningReminders, sendTaskDigest } from './digest'
import { handleEventReply, handleEventTap, isEventTap } from './events'
import { Budget, COST, POLL_CEILING } from './budget'
import { shouldTranscribeHere } from './pocket-health'
import { transcribeHere } from './transcribe'
import { fileVoiceNote, queueVoiceNote, TELEGRAM_MAX_BYTES, voiceNoteFrom, voiceNotesToSweep, type TelegramMessage } from './voice'
/** Pocket signs `${timestamp}.${rawBody}` with HMAC-SHA256. */
const SIGNATURE_HEADER = 'x-heypocket-signature'
const TIMESTAMP_HEADER = 'x-heypocket-timestamp'
/** Reject replays. Pocket's timestamp is milliseconds since epoch. */
const MAX_SKEW_MS = 5 * 60 * 1000
/** Webhook payloads are small; anything larger is not from Pocket. */
const MAX_BODY_BYTES = 1_000_000
/**
 * Every Pocket event carries the full transcript, so subscribing to more than
 * one means the same thought arrives four or five times.
 */
const HANDLED_EVENT = 'transcription.completed'
/** How far back a polling pass looks. Dedupe makes overlap free. */
const POLL_LIMIT = 25
/**
 * Cap per pass, on top of the subrequest budget. The cron runs every two
 * minutes, so a backlog drains on its own rather than needing a bigger batch.
 */
const MAX_PER_POLL = 4
type VerifyResult =
  | { status: 'valid' }
  | { status: 'unconfigured' }
  | { status: 'rejected'; reason: string }
interface PocketWebhookPayload {
  event?: string
  recording?: { id?: string }
}
// ------------------------------------------------------------- signature ----
function hexToBytes(hex: string): Uint8Array | null {
  const clean = hex.trim().replace(/^sha256=/i, '')
  if (clean.length === 0 || clean.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(clean)) return null
  const out = new Uint8Array(clean.length / 2)
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16)
  return out
}
/**
 * A missing signature is a rejection, never a pass: Pocket's docs note that
 * legacy webhooks can deliver unsigned until they are rotated, and treating
 * "no header" as "nothing to check" would leave the endpoint open to anyone
 * who learns the URL.
 */
async function verifySignature(
  secret: string | undefined,
  rawBody: string,
  headers: Headers
): Promise<VerifyResult> {
  if (!secret) return { status: 'unconfigured' }
  const signature = headers.get(SIGNATURE_HEADER)
  const timestamp = headers.get(TIMESTAMP_HEADER)
  if (!signature) return { status: 'rejected', reason: 'missing signature header' }
  if (!timestamp) return { status: 'rejected', reason: 'missing timestamp header' }
  const sentAt = Number(timestamp)
  if (!Number.isFinite(sentAt)) return { status: 'rejected', reason: 'unparseable timestamp' }
  const skew = Math.abs(Date.now() - sentAt)
  if (skew > MAX_SKEW_MS) return { status: 'rejected', reason: `timestamp skew ${Math.round(skew / 1000)}s` }
  const provided = hexToBytes(signature)
  if (!provided) return { status: 'rejected', reason: 'signature is not hex' }
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  )
  // subtle.verify compares in constant time, so there is no separate compare.
  const valid = await crypto.subtle.verify(
    'HMAC',
    key,
    provided as BufferSource,
    new TextEncoder().encode(`${timestamp}.${rawBody}`)
  )
  return valid ? { status: 'valid' } : { status: 'rejected', reason: 'signature mismatch' }
}
// ----------------------------------------------------------------- poll ----
/**
 * The primary capture path.
 *
 * Not a safety net any more: Pocket's webhook has broken repeatedly, their app
 * shows no delivery log, and their API exposes no webhook endpoints — so it can
 * be neither observed nor repaired from here. Polling every two minutes makes
 * that irrelevant rather than fatal.
 */
export async function poll(env: Env, workerUrl: string): Promise<void> {
  // "Is there anything new?" is answered from Pocket's list and the handled
  // set in KV, so an idle poll is two cheap reads and nothing else.
  const recordings = await listRecordings(env, POLL_LIMIT)
  // Finished at Pocket, or left unfinished long enough to transcribe here.
  const now = Date.now()
  const ready = recordings.filter((r) => r.state === 'completed' || shouldTranscribeHere(r, now))
  const skip = await Promise.all(
    ready.map(async (r) => (await isHandled(env, r.id)) || (r.state !== 'completed' && (await transcriptionHeld(env, r.id))))
  )
  const pending = ready.filter((_, i) => !skip[i])
  // Free: the list is already fetched, and the check is KV + Telegram only.
  await checkPocketHealth(env, recordings)
  const housekeepingDue = await claimDailyRun(env, 'sweeps')
  const voiceNotes = await voiceNotesToSweep(env)
  if (!pending.length && !housekeepingDue && !voiceNotes.length) return
  log('poll', { pending: pending.length, housekeepingDue })
  const budget = new Budget(POLL_CEILING)
  budget.tryClaim(COST.pollSetup)
  try {
    if (pending.length) {
      const context = await buildContext(env)
      // Anything older than this had every chance to arrive by webhook, so its
      // presence here is evidence the webhook is not delivering.
      const WEBHOOK_GRACE_MS = 15 * 60 * 1000
      // Only finished recordings: Pocket's webhook never fires for the others.
      const stale = pending.filter((r) => r.state === 'completed' && Date.now() - Date.parse(r.recording_at) > WEBHOOK_GRACE_MS).length
      await checkWebhookHealth(env, stale)
      // Oldest first, so a backlog is worked through in the order it happened.
      pending.sort((a, b) => String(a.recording_at).localeCompare(String(b.recording_at)))
      const batch = pending.slice(0, MAX_PER_POLL)
      if (pending.length > batch.length) {
        log('poll.deferred', { deferred: pending.length - batch.length, note: 'picked up next pass' })
      }
      for (const summary of batch) {
        const here = summary.state !== 'completed'
        if (!budget.tryClaim(COST.capture + (here ? COST.transcribe : 0))) {
          log('poll.budget_exhausted', { note: 'remaining recordings picked up next pass' })
          break
        }
        try {
          let normalized
          try {
            normalized = here ? await transcribeHere(env, summary) : await getRecording(env, summary.id)
          } catch (err) {
            // Tried again in half an hour, so a failing transcription is not
            // retried every two minutes.
            if (here) await holdTranscription(env, summary.id)
            throw err
          }
          if (here) log('poll.transcribed_here', { recordingId: summary.id, chars: normalized?.transcript.length ?? 0 })
          if (!normalized) {
            // Nothing to hear in it. Mark it handled in KV so it does not
            // reappear as pending on every future poll — no Capture Log row
            // needed, since there is nothing to route or review.
            await markHandled(env, summary.id)
            log('poll.no_transcript', { recordingId: summary.id })
            continue
          }
          // recording_at is when they actually spoke; created_at is when Pocket
          // finished syncing, which can be the next day and would file a
          // journal entry under the wrong date.
          if (summary.recording_at) {
            normalized.recordedAt = new Date(summary.recording_at).toISOString()
          }
          await processCapture(env, normalized, workerUrl, context)
        } catch (err) {
          log('poll.error', {
            recordingId: summary.id,
            message: err instanceof Error ? err.message : String(err),
          })
        }
      }
    }
    // Voice messages whose filing did not finish when they arrived.
    for (const note of voiceNotes.slice(0, MAX_PER_POLL)) {
      if (!budget.tryClaim(COST.capture + COST.transcribe)) break
      await fileVoiceNote(env, note, workerUrl)
    }
    // Housekeeping (re-filing rows ticked Redo) is once a day: a tick waits at
    // most a day, and the poll stays cheap the rest of the time.
    if (housekeepingDue) {
      const context = await buildContext(env)
      await sweepRedos(env, context, budget).catch((err) => log('redo.sweep_failed', { message: String(err) }))
    }
  } finally {
    log('poll.done', budget.toJSON())
  }
}
// ------------------------------------------------------------------ HTTP ----
/**
 * Handle a tapped inline button.
 *
 * Telegram echoes the secret we registered with setWebhook on every call, so
 * an unauthenticated POST to this public URL cannot file anything. It also
 * retries non-2xx, so the response is always 200 once the tap is accepted —
 * a retried tap would re-plan and write a second row.
 */
async function handleTelegram(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  const secret = request.headers.get('x-telegram-bot-api-secret-token') ?? ''
  if (!env.TELEGRAM_WEBHOOK_SECRET || secret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('unauthorized\n', { status: 401 })
  }
  const update = (await request.json().catch(() => ({}))) as {
    callback_query?: {
      id: string
      data?: string
      message?: {
        message_id: number
        chat: { id: number }
        reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }
      }
    }
    message?: TelegramMessage & {
      text?: string
      reply_to_message?: { message_id: number }
    }
  }

  // The secret header proves the update came from Telegram, not who sent it.
  // Anyone can find a bot and message it, so anything not from the owner's
  // chat is dropped before it can steer a capture.
  const fromChat = update.message?.chat.id ?? update.callback_query?.message?.chat.id
  if (fromChat === undefined || String(fromChat) !== String(env.TELEGRAM_CHAT_ID)) {
    log('telegram.foreign_chat', { chatId: fromChat ?? null })
    return new Response('ok\n')
  }

  // A voice message or an audio file: transcribed and filed like a Pocket recording.
  const note = update.message ? voiceNoteFrom(update.message) : null
  if (note) {
    if (note.bytes > TELEGRAM_MAX_BYTES) {
      await sendPlain(env, "That file is over Telegram's 20 MB limit for bots, so I can't download it. Send it as a voice message, or a shorter or compressed file.")
      return new Response('ok\n')
    }
    await queueVoiceNote(env, note)
    ctx.waitUntil(fileVoiceNote(env, note, new URL(request.url).origin))
    return new Response('ok\n')
  }

  // A typed reply. People answer questions in words — being told to tap a
  // button instead is the kind of friction that makes a system not get used,
  // and words carry more than a button can ("burning man 26" names both the
  // table and the record).
  if (update.message?.text) {
    const msg = update.message
    const text = msg.text!.trim()
    if (!text || text.startsWith('/')) return new Response('ok\n')

    // An answer to "which event is this adventure for?" comes first: it is
    // either a reply to that question or the next thing typed after it.
    if (await handleEventReply(env, schema, text, msg.reply_to_message?.message_id)) return new Response('ok\n')

    const captureLogId =
      (msg.reply_to_message ? await questionFor(env, msg.reply_to_message.message_id) : null) ??
      (await lastQuestion(env))

    if (!captureLogId) {
      await sendPlain(env, 'Nothing is waiting on an answer right now.')
      return new Response('ok\n')
    }

    ctx.waitUntil(
      (async () => {
        let reply = '⚠️ Something went wrong — it is still waiting in Capture Log'
        try {
          const result = await resolveCapture(env, {
            captureLogId,
            tableKey: '',
            workerUrl: new URL(request.url).origin,
            source: 'Notification',
            hint: text,
          })
          reply = result.ok ? `✅ ${result.message}` : `⚠️ ${result.message}`
          if (result.ok) await clearLastQuestion(env, captureLogId)
        } catch (err) {
          log('telegram.reply_failed', { message: err instanceof Error ? err.message : String(err) })
        }
        await sendPlain(env, reply)
      })()
    )
    return new Response('ok\n')
  }

  const q = update.callback_query
  if (!q?.data || !q.message) return new Response('ok\n')
  if (isEventTap(q.data)) {
    ctx.waitUntil(handleEventTap(env, schema, { id: q.id, data: q.data, message: q.message }))
    return new Response('ok\n')
  }
  if (isTaskTap(q.data)) {
    ctx.waitUntil(handleTaskTap(env, schema, { id: q.id, data: q.data, message: q.message }))
    return new Response('ok\n')
  }
  const { captureLogId, tableKey } = decodeCallback(q.data)
  log('telegram.tap', { captureLogId, tableKey })
  // Telegram shows a spinner until answerCallbackQuery, and times the webhook
  // out well before a re-plan finishes — so acknowledge immediately and do the
  // work behind it.
  ctx.waitUntil(
    (async () => {
      let text = 'Something went wrong'
      try {
        const result = await resolveCapture(env, {
          captureLogId,
          tableKey,
          workerUrl: new URL(request.url).origin,
        })
        text = result.message
        if (result.ok) await clearLastQuestion(env, captureLogId)
      } catch (err) {
        log('telegram.resolve_failed', { message: err instanceof Error ? err.message : String(err) })
      }
      await acknowledgeTap(env, {
        callbackQueryId: q.id,
        chatId: q.message!.chat.id,
        messageId: q.message!.message_id,
        text,
      })
    })()
  )
  return new Response('ok\n')
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url)
    if (request.method === 'GET') {
      return new Response('pocket-scribe is listening\n', {
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    }
    if (request.method !== 'POST') {
      return new Response('method not allowed\n', { status: 405, headers: { allow: 'GET, POST' } })
    }
    if (url.pathname === '/telegram') {
      try {
        return await handleTelegram(request, env, ctx)
      } catch (err) {
        log('telegram.error', { message: err instanceof Error ? err.message : String(err) })
        return new Response('ok\n')
      }
    }
    try {
      const declared = Number(request.headers.get('content-length') ?? '0')
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return new Response('payload too large\n', { status: 413 })
      }
      // Read the raw text before anything parses it: the signature covers the
      // exact bytes received, and re-serialized JSON will not match.
      const rawBody = await request.text()
      if (rawBody.length > MAX_BODY_BYTES) {
        return new Response('payload too large\n', { status: 413 })
      }
      const verdict = await verifySignature(env.POCKET_WEBHOOK_SECRET, rawBody, request.headers)
      if (verdict.status === 'rejected') {
        console.warn(JSON.stringify({ event: 'webhook.rejected', reason: verdict.reason }))
        return new Response('invalid signature\n', { status: 401 })
      }
      if (verdict.status === 'unconfigured') {
        console.warn(
          JSON.stringify({
            event: 'webhook.unverified',
            note: 'POCKET_WEBHOOK_SECRET is not set — accepting unverified deliveries.',
          })
        )
      }
      let payload: PocketWebhookPayload
      try {
        payload = JSON.parse(rawBody)
      } catch {
        return new Response('bad json\n', { status: 400 })
      }
      log('webhook.received', {
        verified: verdict.status === 'valid',
        pocketEvent: payload.event,
        recordingId: payload.recording?.id,
      })
      if (payload.event !== HANDLED_EVENT || !payload.recording?.id) {
        return new Response('ok\n')
      }
      // The webhook is a trigger, not a source. Its payload carries only
      // `createdAt` — when Pocket finished syncing — with no field for when
      // the recording was actually made, so trusting it stamped a week of
      // backlogged recordings with the moment they happened to upload. The
      // API has `recording_at`, and it is free and unmetered, so the id is
      // the only thing taken from the payload and everything else is fetched.
      // That also means the two paths can never diverge in shape.
      const recordingId = payload.recording.id
      ctx.waitUntil(
        (async () => {
          const capture = await getRecording(env, recordingId)
          if (!capture) {
            log('webhook.no_transcript', { recordingId })
            return
          }
          await processCapture(env, capture, url.origin)
        })()
          .catch((err) => log('process.unhandled', { message: err instanceof Error ? err.message : String(err) }))
      )
      return new Response('ok\n')
    } catch (err) {
      console.error(
        JSON.stringify({ event: 'webhook.error', message: err instanceof Error ? err.message : String(err) })
      )
      return new Response('internal error\n', { status: 500 })
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      poll(env, env.WORKER_URL ?? '').catch((err) =>
        log('poll.unhandled', { message: err instanceof Error ? err.message : String(err) })
      )
    )
    ctx.waitUntil(
      sendTaskDigest(env, schema).catch((err) =>
        log('digest.failed', { message: err instanceof Error ? err.message : String(err) })
      )
    )
    ctx.waitUntil(
      runNightlyBackup(env).catch((err) => log('backup.unhandled', { message: err instanceof Error ? err.message : String(err) }))
    )
    ctx.waitUntil(
      sendMorningReminders(env, schema).catch((err) =>
        log('reminders.failed', { message: err instanceof Error ? err.message : String(err) })
      )
    )
  },
} satisfies ExportedHandler<Env>
