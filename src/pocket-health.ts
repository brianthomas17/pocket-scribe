/**
 * What is wrong at Pocket's end, worked out from the recordings list alone,
 * so it can be tested without a Worker. capture.ts sends the messages.
 */

/** Quiet this long before saying nothing has arrived. A daily nudge on ordinary quiet days is noise. */
const SILENT_DAYS = 3
/** Unfinished this long, and not transcribed here either, before it is worth mentioning. */
const STUCK_HOURS = 6
/** Pocket gets this long to transcribe a recording before it is transcribed here instead. */
export const TRANSCRIBE_AFTER_MINUTES = 10
/**
 * Longer than this is left to Pocket (tap Summarize in its app). Workers AI's
 * free allowance is a few hours of audio a day; one long meeting would use it up.
 */
export const TRANSCRIBE_MAX_MINUTES = 60

export interface PocketHealth {
  /** Whole days since anything at all reached Pocket, when that is SILENT_DAYS or more. */
  silentDays: number | null
  /** Recordings Pocket has had for STUCK_HOURS or more without finishing, oldest first. */
  stuck: Array<{ id: string; recordingAt: string; state: string; tooLong: boolean }>
}

type Listed = { id: string; state: string; recording_at: string; duration?: number | null }

const tooLong = (r: Listed) => (r.duration ?? 0) > TRANSCRIBE_MAX_MINUTES * 60

/**
 * Should this recording be transcribed here? Since late October 2026 Pocket
 * often leaves recordings "pending" until you tap Summarize in its app, and its
 * API has no way to ask for a transcript. The audio can be downloaded, though,
 * so after a short wait the recording is transcribed with Workers AI instead.
 */
export function shouldTranscribeHere(r: Listed, now = Date.now()): boolean {
  if (r.state === 'completed' || !r.recording_at || tooLong(r)) return false
  return now - Date.parse(r.recording_at) >= TRANSCRIBE_AFTER_MINUTES * 60 * 1000
}

/**
 * What is wrong at Pocket's end, from the list the poll already fetched.
 *
 * Two different problems, which the old check ran together: nothing reaching
 * Pocket at all (the device → phone → cloud sync has stalled), and a recording
 * that reached Pocket but was never transcribed (it sits "pending", and the
 * poll only takes finished ones). Counting only finished recordings reported
 * the second as the first: "no new recordings" while one was waiting there.
 */
export function pocketHealth(recordings: Listed[], now = Date.now()): PocketHealth {
  const newest = recordings.map((r) => r.recording_at).filter(Boolean).sort().pop()
  const days = newest ? Math.floor((now - Date.parse(newest)) / (24 * 60 * 60 * 1000)) : 0
  const stuck = recordings
    .filter((r) => r.state !== 'completed' && r.recording_at && now - Date.parse(r.recording_at) >= STUCK_HOURS * 60 * 60 * 1000)
    .sort((a, b) => a.recording_at.localeCompare(b.recording_at))
    .map((r) => ({ id: r.id, recordingAt: r.recording_at, state: r.state, tooLong: tooLong(r) }))
  // No recordings at all is a new account, not a stalled sync.
  return { silentDays: newest && days >= SILENT_DAYS ? days : null, stuck }
}
