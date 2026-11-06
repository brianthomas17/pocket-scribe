/**
 * The capture path: one transcript in, writes to the tables out.
 *
 * Shared by all three entry points — the webhook, the cron poller, and a
 * notification button tap — so a recording is handled identically however it
 * arrived.
 */

import { store, type StoreRecord, type StoreTable } from './store'
import { applyOperation, type AppliedOperation } from './apply'
import { notifyClarify, type ClarifyOption } from './notify'
import { plan, type Correction, type Operation, type Plan, type Schema } from './planner'
import { previousTableOf, recordRoutingCorrection, type SnapshotEntry } from './corrections'
import { COST, type Budget } from './budget'
import { checkNewAdventure } from './events'
import { pocketHealth } from './pocket-health'
import {
  claimDailyRun,
  claimOnce,
  claimRecording,
  isHandled,
  markHandled,
  rememberLastQuestion,
  rememberQuestion,
  recordFailure,
  transcriptionHeld,
} from './state'
import rawSchema from '../schema.json'

export const schema = rawSchema as unknown as Schema

export const CAPTURE_LOG = 'Capture Log'
const CORRECTIONS = 'Corrections'
const MAX_CORRECTION_EXAMPLES = 20

export const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...data }))

export interface Capture {
  recordingId: string
  recordedAt: string
  transcript: string
}

// -------------------------------------------------------------- context ----

async function loadCorrections(env: Env): Promise<Correction[]> {
  try {
    const rows = await store(env).list(CORRECTIONS, {
      where: [{ field: 'Use As Example', truthy: true }],
      limit: MAX_CORRECTION_EXAMPLES,
      sort: 'Detected At',
    })
    return rows
      .map((r) => ({
        transcript: String(r.fields['Raw Transcript'] ?? ''),
        field: String(r.fields['Field'] ?? ''),
        from: String(r.fields['Original Value'] ?? ''),
        to: String(r.fields['Corrected Value'] ?? ''),
      }))
      .filter((c) => c.transcript && c.field)
  } catch (err) {
    // Few-shot examples are an enhancement — never let them block a capture.
    log('corrections.unavailable', { message: String(err) })
    return []
  }
}

/** Records the planner may append to or update, so it resolves against real ids. */
async function loadCandidates(env: Env) {
  const out: Record<string, StoreRecord[]> = {}
  for (const table of schema.tables) {
    const wantsTarget = table.operations.includes('append') || table.operations.includes('update')
    // A table lists candidates when it names how to match one (resolveBy) or
    // what to show for one (candidateFields). To-Dos has the second but not the
    // first: matching new tasks by title would merge "buy milk" into last
    // month's finished one.
    if (!wantsTarget || !(table.resolveBy?.length || table.candidateFields?.length)) continue
    try {
      out[table.key] = await store(env).list(table.name, {
        fields: table.candidateFields ?? table.resolveBy,
        // Journal has a row per day going back years; only the recent ones can
        // plausibly be the target. Adventures has no limit — you append to a
        // trip from months ago.
        ...(table.candidateLimit ? { limit: table.candidateLimit } : {}),
        ...(table.candidateSort ? { sort: table.candidateSort } : {}),
      })
    } catch (err) {
      log('candidates.unavailable', { table: table.name, message: String(err) })
    }
  }
  return out
}

// ------------------------------------------------------------ execution ----

function tableLabel(key: string): string {
  return schema.tables.find((t) => t.key === key)?.name ?? key
}

/**
 * The parts of the planner's context that are safe to share across a batch.
 *
 * Cloudflare caps an invocation at 50 subrequests, so this is built once per
 * poll rather than per recording. Resolution candidates are deliberately NOT
 * in here: they change as the batch writes. Sharing them meant two journal
 * entries recorded the same day, processed three seconds apart in one poll,
 * both saw a candidate list captured before either existed — so the second
 * created a duplicate row instead of updating the first. Consolidation only
 * works if each recording sees what the previous one just wrote.
 */
export interface PlanContext {
  live: StoreTable[]
  corrections: Correction[]
}

export async function buildContext(env: Env): Promise<PlanContext> {
  const [live, corrections] = await Promise.all([store(env).schema(), loadCorrections(env)])
  return { live, corrections }
}

/**
 * Plan a capture and apply it.
 *
 * `entryId` is the Capture Log row to update when one already exists (a Redo,
 * or a notification tap). For a fresh capture it is null and the row is
 * created once at the end with its final state; dedupe lives in KV, so no
 * placeholder row is needed while the planner runs.
 */
async function runPlan(
  env: Env,
  capture: Capture,
  entryId: string | null,
  forceTable: string | undefined,
  workerUrl: string,
  context: PlanContext,
  hint?: string
): Promise<void> {
  const put = async (fields: Record<string, unknown>): Promise<string> => {
    if (entryId) {
      await store(env).update(CAPTURE_LOG, entryId, fields)
      return entryId
    }
    const created = await store(env).create(CAPTURE_LOG, {
      'Recording ID': capture.recordingId,
      'Raw Transcript': capture.transcript,
      'Recorded At': capture.recordedAt,
      ...fields,
    })
    return created.id
  }

  const { live, corrections } = context
  // Re-read every time: the row this recording should merge into may have been
  // created moments ago by the previous recording in the same batch.
  const candidates = await loadCandidates(env)

  const result: Plan = await plan(env, {
    transcript: capture.transcript,
    recordedAt: capture.recordedAt,
    schema,
    live,
    candidates,
    corrections,
    forceTable,
    hint,
  })

  const operations = result.operations.filter((o) => o.op !== 'ignore')
  const confidence = operations.length ? Math.min(...operations.map((o) => o.confidence)) : 1

  log('planned', {
    recordingId: capture.recordingId,
    classifierHeard: result.classifier_heard,
    operations: operations.map((o) => `${o.op}:${o.table}`),
    alternatives: result.alternatives,
    confidence,
    forced: forceTable ?? null,
  })

  // An ignore the planner is not confident about is worth a question. Pocket
  // records by accident often enough that asking about every dropped recording
  // would train you to stop reading the questions — at which point the real
  // ones get missed too. So this only fires when it is genuinely unsure the
  // recording was not meant for you.
  // Substantial content raises the bar for dropping something silently. It does
  // not force a question — a long meeting is still an obvious ignore and the
  // planner says so at 0.95+ — but it means a long recording has to be a
  // clearer non-capture than a two-second one before it disappears without
  // trace. Losing a ten-minute thought is a real loss; losing a stray blip is
  // not, so they should not need the same amount of certainty.
  // When a table was forced, the routing question has already been answered by
  // a person. Re-running the confidence gates would ask them again — which is
  // exactly what happened: a tap on "Adventure Learnings" came back Unrouted
  // because the planner was still unsure *which* adventure. Uncertainty about
  // the details is not a reason to refuse an instruction.
  const decided = Boolean(forceTable || hint)

  const ignoreOp = result.operations.find((o) => o.op === 'ignore')
  const isLong = capture.transcript.length >= (schema.routing.confirmIgnoreAboveChars ?? Infinity)
  const confirmBelow = isLong
    ? (schema.routing.confirmIgnoreBelowWhenLong ?? schema.routing.confirmIgnoreBelow ?? 0)
    : (schema.routing.confirmIgnoreBelow ?? 0)
  if (!decided && !operations.length && ignoreOp && ignoreOp.confidence < confirmBelow) {
    const options: ClarifyOption[] = (result.alternatives ?? [])
      .filter((k) => schema.tables.some((t) => t.key === k && t.operations.length))
      .map((k) => ({ label: tableLabel(k), tableKey: k }))

    const rowId = await put({
      Status: 'Unrouted',
      Operation: 'none',
      Confidence: ignoreOp.confidence,
      Reason: 'Unknown classifier',
      'Planner Output': JSON.stringify(result, null, 2),
    })

    const asked = await notifyClarify(env, {
      captureLogId: rowId,
      transcript: capture.transcript,
      heard: result.classifier_heard,
      options,
      kind: 'confirm-ignore',
    })
    if (asked) {
      await rememberQuestion(env, asked, rowId)
      await rememberLastQuestion(env, rowId)
    }
    log('ignore.confirming', {
      recordingId: capture.recordingId,
      confidence: ignoreOp.confidence,
      chars: capture.transcript.length,
      long: isLong,
      threshold: confirmBelow,
      asked: Boolean(asked),
    })
    // If the question could not be sent, drop it rather than leaving it parked
    // in triage waiting on a prompt that never arrived.
    if (asked) return
  }

  // Recordings that never addressed the system stop here. The row stays as the
  // audit trail that the drop rule is working; Status keeps it out of triage.
  //
  // Being unsure is not grounds for dropping. If a classifier was heard, the
  // person was talking to the system, and a low score means ask — not bin it
  // silently, which is the one failure mode that loses a real capture without
  // leaving anything to notice. The confidence floor only applies when nothing
  // addressed the system in the first place.
  const addressed = Boolean(result.classifier_heard.trim())
  if (!operations.length || (!decided && !addressed && confidence < schema.routing.ignoreBelowConfidence)) {
    await put({
      Status: 'Ignored',
      Operation: 'none',
      Confidence: confidence,
      'Planner Output': JSON.stringify(result, null, 2),
    })
    return
  }

  if (!decided && confidence < schema.routing.minConfidenceToWrite) {
    const options: ClarifyOption[] = [
      ...new Set([operations[0].table, ...(result.alternatives ?? [])]),
    ]
      .filter((k) => schema.tables.some((t) => t.key === k && t.operations.length))
      .map((k) => ({ label: tableLabel(k), tableKey: k }))

    const rowId = await put({
      Status: 'Unrouted',
      Operation: 'none',
      Confidence: confidence,
      Reason: 'Low confidence',
      'Proposed Action': JSON.stringify(result.operations, null, 2),
      'Planner Output': JSON.stringify(result, null, 2),
    })

    const asked = await notifyClarify(env, {
      captureLogId: rowId,
      transcript: capture.transcript,
      heard: result.classifier_heard,
      options,
    })
    if (asked) {
      await rememberQuestion(env, asked, rowId)
      await rememberLastQuestion(env, rowId)
    }
    log('unrouted', { recordingId: capture.recordingId, confidence, asked: Boolean(asked), options: options.map((o) => o.tableKey) })
    return
  }

  const applied: AppliedOperation[] = []
  const failures: string[] = []
  for (const op of operations as Operation[]) {
    try {
      applied.push(await applyOperation(env, schema, live, op, { recordedAt: capture.recordedAt }))
    } catch (err) {
      failures.push(`${op.op} ${op.table}: ${String(err)}`)
    }
  }

  // The snapshot is what the sweep diffs live records against to notice hand
  // edits — but only `create` is snapshotted, because only a created record is
  // one this capture exclusively owns.
  //
  // An append stores just the added bullet while the record receives the whole
  // merged list, so the two can never compare equal and every append would
  // invent a correction. An update targets a shared row — the day's Journal
  // entry — which a later capture is *supposed* to change, so the system's own
  // writes would read as manual edits against the earlier transcript. Both
  // would teach the planner from fabricated lessons, which is worse than
  // learning nothing.
  const snapshot: SnapshotEntry[] = applied
    .filter((a) => a.op === 'create')
    .map((a) => ({ table: a.table, recordId: a.recordId, fields: a.fields }))

  await put({
    Status: failures.length ? (applied.length ? 'Needs review' : 'Failed') : 'Written',
    Operation: applied[0]?.op ?? 'none',
    'Target Table': applied.map((a) => a.table).join(', '),
    'Target Record ID': applied.map((a) => a.recordId).join(', '),
    Confidence: confidence,
    'Planner Output': JSON.stringify({ plan: result, applied, failures }, null, 2),
    'Field Snapshot': JSON.stringify(snapshot, null, 2),
    ...(failures.length ? { Reason: 'Write failed', 'Proposed Action': failures.join('\n') } : {}),
  })

  log('applied', { recordingId: capture.recordingId, applied, failures })

  // A new adventure needs its recurring event, or next year's reminder will
  // not find it: filed silently when obvious, asked about on Telegram when not.
  const events = schema.reminders?.events
  const eventsTable = events && schema.tables.find((t) => t.key === events.table || t.name === events.table)
  for (const a of applied) {
    if (eventsTable && a.op === 'create' && a.table === eventsTable.name) await checkNewAdventure(env, schema, a.recordId)
  }
}



/** Attempts before a failing recording is set aside rather than retried. */
const MAX_ATTEMPTS = 3

export async function processCapture(
  env: Env,
  capture: Capture,
  workerUrl: string,
  context?: PlanContext
): Promise<void> {
  if (!capture.recordingId || !capture.transcript.trim()) {
    log('skip.incomplete', { recordingId: capture.recordingId })
    return
  }

  // Dedupe in KV. Delivery is at-least-once, the poller overlaps the webhook,
  // and Pocket retries after a timeout — three ways to arrive twice. The claim
  // expires on its own, so a crash cannot wedge a recording permanently.
  if (!(await claimRecording(env, capture.recordingId))) {
    log('skip.duplicate', { recordingId: capture.recordingId })
    return
  }

  try {
    await runPlan(env, capture, null, undefined, workerUrl, context ?? (await buildContext(env)))
    await markHandled(env, capture.recordingId)
  } catch (err) {
    log('process.error', {
      recordingId: capture.recordingId,
      message: err instanceof Error ? err.message : String(err),
    })
    // Leave the claim to expire rather than releasing it: the claim's lifetime
    // is the backoff, so a transient failure is retried about fifteen minutes
    // later instead of on the very next poll. A failure that repeats is not
    // transient — retrying it every pass would, if anything had been written
    // before it failed, write it again each time. So after a few attempts it stops, is logged
    // as Failed for a person to look at, and says so.
    const attempts = await recordFailure(env, capture.recordingId)
    if (attempts < MAX_ATTEMPTS) return
    await markHandled(env, capture.recordingId)
    await store(env).create(CAPTURE_LOG, {
      'Recording ID': capture.recordingId,
      'Raw Transcript': capture.transcript,
      'Recorded At': capture.recordedAt,
      Status: 'Failed',
      Reason: 'Write failed',
      'Proposed Action': String(err),
    }).catch(() => {})
    const { sendPlain } = await import('./notify')
    await sendPlain(
      env,
      `A recording failed ${attempts} times and was set aside — it is in Capture Log as Failed.\n\n${String(err).slice(0, 300)}`
    )
  }
}

/**
 * Apply a person's answer to a "where does this go?" notification.
 *
 * Re-plans against the chosen table rather than forcing the earlier operations
 * into it: the fields the planner proposed were shaped for a different table,
 * and bending them would produce a half-filled row. A second planner call is
 * cheaper than a wrong record someone has to find and fix.
 */
export async function resolveCapture(
  env: Env,
  args: {
    captureLogId: string
    tableKey: string
    workerUrl: string
    /** A tap answers a question we asked; a Redo overrules an answer we gave. */
    source?: 'Notification' | 'Manual edit'
    /** Free-text steer from a Telegram reply, e.g. "burning man 26". */
    hint?: string
  }
): Promise<{ ok: boolean; message: string }> {
  const entry = await store(env).get(CAPTURE_LOG, args.captureLogId)
  const transcript = String(entry.fields['Raw Transcript'] ?? '')
  if (!transcript) return { ok: false, message: 'no transcript on that row' }

  // What the planner had wanted, so an override can be learned from.
  const previousTable = previousTableOf(entry.fields, schema)

  if (!args.tableKey && !args.hint) {
    await store(env).update(CAPTURE_LOG, args.captureLogId, {
      Status: 'Ignored',
      Reason: 'Unknown classifier',
      Resolved: true,
    })
    await recordRoutingCorrection(env, {
      transcript,
      fromTable: previousTable,
      toTable: '',
      source: args.source ?? 'Notification',
      captureLogId: args.captureLogId,
    })
    return { ok: true, message: 'Ignored' }
  }

  const table = schema.tables.find((t) => t.key === args.tableKey)
  if (args.tableKey && !table) return { ok: false, message: `unknown table "${args.tableKey}"` }

  const capture: Capture = {
    recordingId: String(entry.fields['Recording ID'] ?? ''),
    recordedAt: String(entry.fields['Recorded At'] ?? new Date().toISOString()),
    transcript,
  }

  await runPlan(
    env,
    capture,
    args.captureLogId,
    args.tableKey,
    args.workerUrl,
    await buildContext(env),
    args.hint
  )
  await store(env).update(CAPTURE_LOG, args.captureLogId, { Resolved: true }).catch(() => {})
  if (table) {
    await recordRoutingCorrection(env, {
      transcript,
      fromTable: previousTable,
      toTable: table.name,
      source: args.source ?? 'Notification',
      captureLogId: args.captureLogId,
    })
  }
  return { ok: true, message: table ? `Filed in ${table.name}` : 'Filed' }
}

/**
 * Re-file recordings ticked Redo in the Capture Log.
 *
 * The planner will sometimes get a routing wrong, and until now the only way
 * to correct it was to retype the entry by hand — which means the misfiled
 * ones just stay misfiled. Ticking Redo hands it back: optionally put a table
 * name in Target Table to force the destination, or leave it blank to let the
 * planner try again with whatever it has learned since.
 */
export async function sweepRedos(env: Env, context: PlanContext, budget?: Budget): Promise<void> {
  const rows = await store(env).list(CAPTURE_LOG, { where: [{ field: 'Redo', truthy: true }], limit: 10 })
  if (!rows.length) return
  log('redo.found', { count: rows.length })

  for (const row of rows) {
    if (budget && !budget.tryClaim(COST.redo)) {
      log('redo.deferred', { remaining: budget.remaining })
      return
    }
    const transcript = String(row.fields['Raw Transcript'] ?? '')
    if (!transcript) {
      await store(env).update(CAPTURE_LOG, row.id, { Redo: false }).catch(() => {})
      continue
    }

    // Target Table accepts either the table name or the schema key, matched
    // loosely — this is a field a person types into, not an enum.
    const wanted = String(row.fields['Target Table'] ?? '').trim().toLowerCase()
    const forced = schema.tables.find(
      (t) => t.operations.length && (t.name.toLowerCase() === wanted || t.key.toLowerCase() === wanted)
    )

    // A row that already wrote somewhere will produce a second record rather
    // than moving the first; nothing can know the old one is stale.
    const previousTable = previousTableOf(row.fields, schema)
    const previous = String(row.fields['Target Record ID'] ?? '')
    if (previous) {
      log('redo.previous_record', { captureLogId: row.id, previous, note: 'old record is left in place — delete it if this supersedes it' })
    }

    try {
      await store(env).update(CAPTURE_LOG, row.id, {
        Redo: false,
        Status: null,
        Reason: null,
        ...(forced ? {} : { 'Target Table': '' }),
      })
      await runPlan(
        env,
        {
          recordingId: String(row.fields['Recording ID'] ?? ''),
          recordedAt: String(row.fields['Recorded At'] ?? new Date().toISOString()),
          transcript,
        },
        row.id,
        forced?.key,
        env.WORKER_URL ?? '',
        context
      )
      if (forced) {
        await recordRoutingCorrection(env, {
          transcript,
          fromTable: previousTable,
          toTable: forced.name,
          // A Redo overrules a decision already committed to, which is a
          // stronger signal than answering a question we asked.
          source: 'Manual edit',
          captureLogId: row.id,
        })
      }
      log('redo.done', { captureLogId: row.id, forced: forced?.key ?? null })
    } catch (err) {
      log('redo.failed', { captureLogId: row.id, message: err instanceof Error ? err.message : String(err) })
      await store(env).update(CAPTURE_LOG, row.id, { Redo: false, Status: 'Failed' }).catch(() => {})
    }
  }
}

const META = 'Pocket Meta'

async function metaGet(env: Env, key: string): Promise<{ id: string; value: string } | null> {
  const rows = await store(env).list(META, { where: [{ field: 'Key', equals: key }], limit: 1 })
  if (!rows.length) return null
  return { id: rows[0].id, value: String(rows[0].fields['Value'] ?? '') }
}

/**
 * Tell us when the webhook has stopped delivering.
 *
 * The poller makes a dead webhook survivable, which is exactly why it can stay
 * dead unnoticed — captures keep arriving, just ten minutes late. If the
 * poller is picking up recordings old enough that the webhook had every chance
 * to deliver them, the webhook is not working, and that is worth saying once a
 * day rather than never.
 */
export async function checkWebhookHealth(env: Env, staleRecordings: number): Promise<void> {
  if (!staleRecordings) return
  try {
    const row = await metaGet(env, 'webhook_alert_at')
    const lastAlert = row?.value ? Date.parse(row.value) : 0
    if (Date.now() - lastAlert < 24 * 60 * 60 * 1000) return

    const { sendPlain } = await import('./notify')
    const sent = await sendPlain(
      env,
      `Heads up: the Pocket webhook does not appear to be delivering — the poller just picked up ${staleRecordings} recording(s) it should have sent.\n\nNothing is lost; captures are arriving up to 10 minutes late instead of instantly. Re-create the webhook in the Pocket app when convenient.`
    )
    const stamp = new Date().toISOString()
    if (row) await store(env).update(META, row.id, { Value: stamp, 'Updated At': stamp })
    else await store(env).create(META, { Key: 'webhook_alert_at', Value: stamp, 'Updated At': stamp })
    log('webhook.stale', { staleRecordings, notified: sent })
  } catch (err) {
    log('webhook.health_check_failed', { message: String(err) })
  }
}

const whenLocal = (iso: string, tz: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(new Date(iso))

/** Tell you when Pocket has stalled: silence at most once a day, and each stuck recording once. Free: KV and Telegram only. */
export async function checkPocketHealth(
  env: Env,
  recordings: Array<{ id: string; state: string; recording_at: string; duration?: number | null }>
): Promise<void> {
  const health = pocketHealth(recordings)
  const tz = env.TIMEZONE || 'UTC'
  const { sendPlain } = await import('./notify')

  if (health.silentDays !== null && (await claimDailyRun(env, 'silence-alert'))) {
    await sendPlain(
      env,
      `Nothing has reached Pocket in ${health.silentDays} days.\n\nIf you have recorded since then, open the Pocket app and let it sync — anything still on the device is invisible to everything downstream.`
    )
    log('silence.alerted', { days: health.silentDays })
  }

  // Unfinished recordings are transcribed here, so one is only worth a
  // message when it is too long for that, or when an attempt here has failed.
  // Not merely for being old: this check runs before the poll transcribes
  // anything, and a backlog would otherwise be reported moments before it is
  // filed. Each is mentioned once, not every day it stays stuck.
  const tell: typeof health.stuck = []
  for (const s of health.stuck) {
    if (await isHandled(env, s.id)) continue
    if (!s.tooLong && !(await transcriptionHeld(env, s.id))) continue
    if (await claimOnce(env, `stuck:${s.id}`, 60)) tell.push(s)
  }
  for (const s of tell) {
    const when = whenLocal(s.recordingAt, tz)
    await sendPlain(
      env,
      s.tooLong
        ? `Pocket hasn't transcribed your recording from ${when}, and it is too long to transcribe here.\n\nOpen it in the Pocket app and tap Summarize; it is filed a few minutes after that.`
        : `Your recording from ${when} couldn't be transcribed — not by Pocket, and not here either. It is retried every half hour.\n\nTapping Summarize on it in the Pocket app also works.`
    )
    log('stuck.alerted', { recordingId: s.id, tooLong: s.tooLong })
  }
}
