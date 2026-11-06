/**
 * Learning from corrections.
 *
 * The planner starts out generic and this is what makes it yours. Three
 * signals, in ascending order of how much they tell us:
 *
 *   1. A field you fixed in the app — you corrected the content.
 *   2. A tap on a clarify notification — you named the table it belonged in.
 *   3. A Redo tick — you overruled a decision it had already committed to.
 *
 * All three land in the Corrections table, which the planner reads back as
 * few-shot examples on every run. Nothing here is allowed to fail loudly: a
 * correction that cannot be recorded is a missed lesson, not a lost capture.
 */

import { store } from './store'
import type { Schema } from './planner'

const CORRECTIONS = 'Corrections'
const CAPTURE_LOG = 'Capture Log'


const log = (event: string, data: Record<string, unknown> = {}) =>
  console.log(JSON.stringify({ event, ...data }))

/**
 * Where a recording actually went last time.
 *
 * Not simply Target Table: that field doubles as the box you type an override
 * into, so by the time a Redo is swept it already holds the *new* destination
 * and the correction looks like a no-op. The snapshot records what was really
 * written, and the planner output records what was really chosen — both
 * survive the override.
 */
export function previousTableOf(
  fields: Record<string, unknown>,
  schema: Schema
): string {
  try {
    const snapshot = JSON.parse(String(fields['Field Snapshot'] ?? '[]')) as SnapshotEntry[]
    if (Array.isArray(snapshot) && snapshot[0]?.table) return snapshot[0].table
  } catch {
    /* fall through */
  }
  try {
    const output = JSON.parse(String(fields['Planner Output'] ?? '{}'))
    // Written rows are wrapped as { plan, applied, failures }; Unrouted and
    // Ignored rows store the bare Plan. Reading only the wrapped shape meant
    // this always came back empty for exactly the rows a tap lands on.
    const operations = output?.plan?.operations ?? output?.operations
    const key = operations?.find((o: { op: string }) => o.op !== 'ignore')?.table
    if (key) return schema.tables.find((t) => t.key === key)?.name ?? String(key)
  } catch {
    /* fall through */
  }
  return ''
}

export interface SnapshotEntry {
  table: string
  recordId: string
  fields: Record<string, unknown>
}

function short(v: unknown, max = 400): string {
  // An emptied field is absent from the record. Rendering that as
  // a pair of quote marks teaches nothing; name it instead.
  if (v === undefined || v === null || v === '') return '(cleared)'
  const s = typeof v === 'string' ? v : JSON.stringify(v ?? '')
  const clean = String(s).replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

async function write(
  env: Env,
  row: {
    summary: string
    source: 'Voice' | 'Notification' | 'Manual edit'
    sourceTable: string
    sourceRecordId: string
    field: string
    from: unknown
    to: unknown
    transcript: string
  }
): Promise<boolean> {
  try {
    await store(env).create(CORRECTIONS, {
      Summary: short(row.summary, 200),
      Source: row.source,
      'Source Table': row.sourceTable,
      'Source Record ID': row.sourceRecordId,
      Field: row.field,
      'Original Value': short(row.from),
      'Corrected Value': short(row.to),
      'Raw Transcript': short(row.transcript, 2000),
      'Detected At': new Date().toISOString(),
      'Use As Example': true,
    })
    log('correction.recorded', { source: row.source, field: row.field })
    return true
  } catch (err) {
    // Losing a lesson is survivable; silently baselining it as correct is not,
    // so the caller needs to know this failed and leave the snapshot alone.
    log('correction.write_failed', { message: String(err) })
    return false
  }
}

/**
 * Record that a recording belonged somewhere other than where it was put.
 *
 * Routing is the correction that matters most: getting the table wrong makes
 * everything downstream wrong, and it is the mistake a generic planner makes
 * most often against someone's private vocabulary.
 */
export async function recordRoutingCorrection(
  env: Env,
  args: {
    transcript: string
    fromTable: string
    toTable: string
    source: 'Notification' | 'Manual edit'
    captureLogId: string
  }
): Promise<void> {
  if (args.fromTable === args.toTable) return
  await write(env, {
    summary: `Routed to ${args.toTable || 'nothing'}, not ${args.fromTable || 'nothing'}`,
    source: args.source,
    sourceTable: CAPTURE_LOG,
    sourceRecordId: args.captureLogId,
    field: 'table',
    from: args.fromTable || '(ignored)',
    to: args.toTable || '(ignored)',
    transcript: args.transcript,
  })
}

/**
 * Record a field someone fixed by hand, at the moment they fixed it.
 *
 * The app knows exactly what changed when you save, so it reports it directly
 * instead of leaving it for the nightly sweep to rediscover by diffing. The
 * caller decides what counts — only fields the planner wrote, minus lifecycle
 * fields — using the capture's Field Snapshot, the same rule the sweep uses.
 */
export async function recordFieldCorrection(
  env: Env,
  args: { table: string; recordId: string; field: string; from: unknown; to: unknown; transcript: string }
): Promise<boolean> {
  return write(env, {
    summary: `${args.table}.${args.field} corrected by hand`,
    source: 'Manual edit',
    sourceTable: args.table,
    sourceRecordId: args.recordId,
    field: args.field,
    from: args.from,
    to: args.to,
    transcript: args.transcript,
  })
}
