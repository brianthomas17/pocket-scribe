/**
 * Voice messages and audio files sent to the bot, filed like Pocket recordings.
 *
 * For when the Pocket is the wrong microphone: talking while walking, or a
 * better mic recording through the phone. Hold the mic button in Telegram, or
 * send an audio file; a caption is read as part of what was said.
 *
 * A note is filed straight away, and also queued in KV until it is: the work
 * runs after Telegram has had its reply, where the Worker can be cut off, so
 * the poll picks up anything that did not finish.
 */

import { CAPTURE_LOG, log, processCapture, type PlanContext } from './capture'
import { sendPlain } from './notify'
import { store } from './store'
import { isHandled, markHandled, recordFailure } from './state'
import { speechToText } from './transcribe'
import type { VoiceNote } from './voice-note'

export { TELEGRAM_MAX_BYTES, voiceNoteFrom, type TelegramMessage, type VoiceNote } from './voice-note'

/** The poll leaves a note this long to the attempt made when it arrived. */
const SWEEP_AFTER_MS = 3 * 60 * 1000
const MAX_ATTEMPTS = 3
const QUEUE = 'voice:queue'

async function queued(env: Env): Promise<VoiceNote[]> {
  return JSON.parse((await env.STATE.get(QUEUE)) ?? '[]') as VoiceNote[]
}

export async function queueVoiceNote(env: Env, note: VoiceNote): Promise<void> {
  const notes = await queued(env)
  if (!notes.some((n) => n.id === note.id)) await env.STATE.put(QUEUE, JSON.stringify([...notes, note]))
}

async function dequeue(env: Env, id: string): Promise<void> {
  const notes = await queued(env)
  if (notes.some((n) => n.id === id)) await env.STATE.put(QUEUE, JSON.stringify(notes.filter((n) => n.id !== id)))
}

async function download(env: Env, fileId: string): Promise<ArrayBuffer> {
  const api = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}`
  const meta = (await (await fetch(`${api}/getFile?file_id=${encodeURIComponent(fileId)}`)).json()) as {
    ok: boolean
    result?: { file_path?: string }
    description?: string
  }
  if (!meta.ok || !meta.result?.file_path) throw new Error(`telegram getFile: ${meta.description ?? 'no file_path'}`)
  const res = await fetch(`https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${meta.result.file_path}`)
  if (!res.ok) throw new Error(`telegram file download → ${res.status}`)
  return res.arrayBuffer()
}

/** What happened, in a line: the planner's own question already covers an Unrouted note. */
async function tellOutcome(env: Env, note: VoiceNote): Promise<void> {
  const [row] = await store(env).list(CAPTURE_LOG, { where: [{ field: 'Recording ID', equals: note.id }], limit: 1 })
  if (!row) return
  const status = String(row.fields.Status ?? '')
  const heard = String(row.fields['Raw Transcript'] ?? '')
  const quote = heard.length > 120 ? `${heard.slice(0, 120)}…` : heard
  if (status === 'Written') await sendPlain(env, `✅ Filed in ${row.fields['Target Table']}: “${quote}”`)
  else if (status === 'Ignored') await sendPlain(env, `Nothing to file in that one. I heard: “${quote}”`)
  else if (status !== 'Unrouted') await sendPlain(env, `⚠️ That one is in Capture Log as ${status}. I heard: “${quote}”`)
}

/** Transcribe a note and file it. Never throws: a failure is retried by the poll, up to MAX_ATTEMPTS. */
export async function fileVoiceNote(env: Env, note: VoiceNote, workerUrl: string, context?: PlanContext): Promise<void> {
  if (await isHandled(env, note.id)) return dequeue(env, note.id)
  let transcript: string
  try {
    transcript = await speechToText(env, await download(env, note.fileId), note.mime, note.seconds)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('voice.transcribe_failed', { id: note.id, message })
    if ((await recordFailure(env, `stt-${note.id}`)) < MAX_ATTEMPTS) return
    await markHandled(env, note.id)
    await dequeue(env, note.id)
    await sendPlain(env, `⚠️ I couldn't transcribe your voice message from ${note.at.slice(0, 16).replace('T', ' ')} UTC after ${MAX_ATTEMPTS} tries.\n\n${message.slice(0, 200)}`)
    return
  }
  if (!transcript && !note.caption) {
    await markHandled(env, note.id)
    await dequeue(env, note.id)
    await sendPlain(env, "I couldn't hear anything in that voice message.")
    return
  }
  // A caption is part of what was said: "journal", typed under a voice note, routes it.
  const text = [note.caption, transcript].filter(Boolean).join('\n\n')
  await processCapture(env, { recordingId: note.id, recordedAt: note.at, transcript: text }, workerUrl, context)
  if (await isHandled(env, note.id)) {
    await dequeue(env, note.id)
    await tellOutcome(env, note).catch((err) => log('voice.outcome_failed', { message: String(err) }))
  }
}

/** Notes the immediate attempt did not finish, oldest first. One KV read when there are none. */
export async function voiceNotesToSweep(env: Env, now = Date.now()): Promise<VoiceNote[]> {
  return (await queued(env)).filter((n) => now - Date.parse(n.at) >= SWEEP_AFTER_MS)
}
