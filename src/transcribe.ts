/**
 * Speech to text, for audio that arrives without a transcript: recordings
 * Pocket left untranscribed, and voice messages sent to the bot.
 *
 * Both models run in your own Cloudflare account through the AI binding, with
 * no key to set up. Deepgram Nova-3 is the better of the two on speech
 * recorded on the move, but its free allowance is only about 20 minutes of
 * audio a day; Whisper's is several hours. So short audio goes to Nova-3, and
 * long audio, or anything Nova-3 fails on (an exhausted allowance included),
 * goes to Whisper.
 */

import { Buffer } from 'node:buffer'
import { getAudioUrl, type NormalizedRecording } from './pocket'

const NOVA = '@cf/deepgram/nova-3'
const WHISPER = '@cf/openai/whisper-large-v3-turbo'
/** Longer than this goes straight to Whisper, so one long recording cannot use up a day of Nova-3. */
const NOVA_MAX_SECONDS = 5 * 60

const log = (event: string, data: Record<string, unknown>) => console.log(JSON.stringify({ event, ...data }))

/** The transcript ('' when there was nothing to hear). Throws when neither model could transcribe it. */
export async function speechToText(env: Env, audio: ArrayBuffer, contentType: string, seconds: number): Promise<string> {
  if (seconds <= NOVA_MAX_SECONDS) {
    try {
      const out = (await (env.AI as any).run(NOVA, {
        audio: { body: new Response(audio).body, contentType },
        smart_format: true,
        punctuate: true,
      })) as { results?: { channels?: Array<{ alternatives?: Array<{ transcript?: string }> }> } }
      const text = out.results?.channels?.[0]?.alternatives?.[0]?.transcript
      if (typeof text !== 'string') throw new Error(`unexpected response: ${JSON.stringify(out).slice(0, 200)}`)
      log('stt', { model: 'nova-3', seconds, chars: text.length })
      return text.trim()
    } catch (err) {
      log('stt.nova_failed', { seconds, message: err instanceof Error ? err.message : String(err) })
    }
  }
  const out = (await env.AI.run(WHISPER, { audio: Buffer.from(audio).toString('base64') })) as { text?: string }
  log('stt', { model: 'whisper', seconds, chars: (out.text ?? '').length })
  return (out.text ?? '').trim()
}

/** A Pocket recording's transcript, made here; null when there was nothing to hear. */
export async function transcribeHere(
  env: Env,
  summary: { id: string; recording_at: string; duration?: number | null }
): Promise<NormalizedRecording | null> {
  const audio = await fetch(await getAudioUrl(env, summary.id))
  if (!audio.ok) throw new Error(`audio download → ${audio.status}`)
  const transcript = await speechToText(env, await audio.arrayBuffer(), 'audio/mpeg', summary.duration ?? Infinity)
  if (!transcript) return null
  return { recordingId: summary.id, recordedAt: new Date(summary.recording_at).toISOString(), transcript }
}
