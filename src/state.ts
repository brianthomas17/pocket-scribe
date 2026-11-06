/**
 * Small, fast state in KV: which recordings are handled or in flight, which
 * once-a-day jobs have run, and which Telegram message asked which question.
 * Records themselves live in D1.
 */

/** A claim older than this is assumed dead and may be retried. */
const CLAIM_STALE_MS = 15 * 60 * 1000

const SEEN = 'seen:'
const CLAIM = 'claim:'
const FAILED = 'failed:'

/** Recording ids already handled. Returns true if this call won the claim. */
export async function claimRecording(env: Env, id: string): Promise<boolean> {
  const seen = await env.STATE.get(SEEN + id)
  if (seen) return false

  const claim = await env.STATE.get(CLAIM + id)
  if (claim && Date.now() - Number(claim) < CLAIM_STALE_MS) return false

  // Claim expires on its own, so a crash cannot wedge a recording forever.
  await env.STATE.put(CLAIM + id, String(Date.now()), { expirationTtl: CLAIM_STALE_MS / 1000 })
  return true
}

export async function markHandled(env: Env, id: string): Promise<void> {
  // No TTL: a handled recording stays handled. Pocket's list is bounded, so
  // this set cannot grow faster than recordings are made.
  // The claim is left to expire rather than deleted. KV is eventually
  // consistent across locations, so for up to a minute another location can
  // still read seen: as missing — the claim is what turns it away meanwhile.
  await env.STATE.put(SEEN + id, '1')
}

/** Count a failed attempt; returns the total so far. */
export async function recordFailure(env: Env, id: string): Promise<number> {
  const n = Number((await env.STATE.get(FAILED + id)) ?? 0) + 1
  await env.STATE.put(FAILED + id, String(n), { expirationTtl: 7 * 24 * 60 * 60 })
  return n
}

const HOLD = 'stt-hold:'
/** After a failed transcription here, how long before the next try. */
const HOLD_SECONDS = 30 * 60

/** Back off a recording whose transcription here just failed. */
export async function holdTranscription(env: Env, id: string): Promise<void> {
  await env.STATE.put(HOLD + id, String(Date.now()), { expirationTtl: HOLD_SECONDS })
}

export async function transcriptionHeld(env: Env, id: string): Promise<boolean> {
  return (await env.STATE.get(HOLD + id)) !== null
}

export async function isHandled(env: Env, id: string): Promise<boolean> {
  return (await env.STATE.get(SEEN + id)) !== null
}

/** Has today's once-a-day housekeeping already run? `day` defaults to today in UTC. */
export async function claimDailyRun(env: Env, name: string, day?: string): Promise<boolean> {
  const today = day ?? new Date().toISOString().slice(0, 10)
  const key = `daily:${name}`
  if ((await env.STATE.get(key)) === today) return false
  await env.STATE.put(key, today, { expirationTtl: 48 * 60 * 60 })
  return true
}

/**
 * Claim something that must happen once, ever (or until `ttlDays` pass).
 * Returns true the first time for a key. Used for reminders, whose due window
 * spans several days but whose message must go out exactly once.
 */
export async function claimOnce(env: Env, key: string, ttlDays = 400): Promise<boolean> {
  const k = `once:${key}`
  if ((await env.STATE.get(k)) !== null) return false
  await env.STATE.put(k, new Date().toISOString(), { expirationTtl: ttlDays * 24 * 60 * 60 })
  return true
}

/** Give a claim back, so a send that failed is tried again. */
export async function releaseOnce(env: Env, key: string): Promise<void> {
  await env.STATE.delete(`once:${key}`)
}

/**
 * Which capture a Telegram question was about.
 *
 * A reply arrives carrying the id of the message it answers, so the question
 * has to be remembered to make sense of "burning man 26" three messages later.
 */
export async function rememberQuestion(env: Env, messageId: number, captureLogId: string) {
  await env.STATE.put(`msg:${messageId}`, captureLogId, { expirationTtl: 30 * 24 * 60 * 60 })
}

export async function questionFor(env: Env, messageId: number): Promise<string | null> {
  return env.STATE.get(`msg:${messageId}`)
}

/** The last question asked, for a reply that did not use Telegram's reply feature. */
export async function rememberLastQuestion(env: Env, captureLogId: string) {
  await env.STATE.put('msg:last', captureLogId, { expirationTtl: 7 * 24 * 60 * 60 })
  // Which kind of question is newest, so a plain typed message answers it
  // (event questions are in events.ts).
  await env.STATE.put('ask:last', JSON.stringify({ kind: 'capture' }), { expirationTtl: 7 * 24 * 60 * 60 })
}

export async function lastQuestion(env: Env): Promise<string | null> {
  return env.STATE.get('msg:last')
}

/**
 * Forget the last question once it is answered, so a later message that is
 * not a reply — "thanks", a stray note — cannot re-file a settled capture.
 */
export async function clearLastQuestion(env: Env, captureLogId: string): Promise<void> {
  if ((await lastQuestion(env)) === captureLogId) await env.STATE.delete('msg:last')
}
