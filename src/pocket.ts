/**
 * Pocket's public API.
 *
 * The webhook is the fast path, but it is not a reliable one: Pocket's app
 * shows no delivery log, so when it stops sending there is nothing to inspect
 * and no way to notice except an empty table. Polling this API on a cron makes
 * the system self-healing — anything the webhook dropped gets picked up on the
 * next pass, and a webhook outage costs latency rather than data.
 */

const BASE = 'https://public.heypocketai.com/api/v1'

export interface RecordingSummary {
  id: string
  state: string
  recording_at: string
  duration: number | null
  title?: string
}

export interface NormalizedRecording {
  recordingId: string
  recordedAt: string
  transcript: string
}

async function call(env: Env, path: string): Promise<any> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { Authorization: `Bearer ${env.POCKET_API_KEY}` },
  })
  const text = await res.text()
  if (!res.ok) throw new Error(`pocket GET ${path} → ${res.status}: ${text.slice(0, 200)}`)
  return JSON.parse(text)
}

export async function listRecordings(env: Env, limit = 25): Promise<RecordingSummary[]> {
  const res = await call(env, `/public/recordings?limit=${limit}`)
  return (res.data ?? []) as RecordingSummary[]
}

/** A short-lived link to a recording's audio (an mp3), for transcribing it here. */
export async function getAudioUrl(env: Env, id: string): Promise<string> {
  const res = await call(env, `/public/recordings/${id}/audio-url?expires_in=600`)
  const url = res.data?.signed_url
  if (typeof url !== 'string') throw new Error(`pocket audio-url for ${id}: no signed_url`)
  return url
}

/**
 * Fetch one recording's verbatim transcript.
 *
 * The API and the webhook disagree on shape — the webhook sends `transcript`
 * as a bare segment array, the API wraps it in an object with a joined `text`.
 * Both are normalized here so the capture path never has to care which route a
 * recording arrived by.
 */
export async function getRecording(env: Env, id: string): Promise<NormalizedRecording | null> {
  const res = await call(env, `/public/recordings/${id}?include_transcript=true&include_summarizations=false`)
  const d = res.data
  if (!d) return null

  const transcript: string =
    typeof d.transcript?.text === 'string' && d.transcript.text.trim()
      ? d.transcript.text
      : (d.transcript?.segments ?? [])
          .map((s: { text?: string }) => (s.text ?? '').trim())
          .filter(Boolean)
          .join(' ')

  if (!transcript.trim()) return null

  return {
    recordingId: d.id,
    recordedAt: new Date(d.recording_at ?? d.created_at ?? Date.now()).toISOString(),
    transcript: transcript.trim(),
  }
}
