/**
 * A complete copy of everything: every record, its whole edit history, and
 * the trackers they belong to (schema.json, which lives only on your computer
 * otherwise).
 *
 * One gzipped JSON file, readable without this code. `scripts/restore.mjs`
 * puts a copy back into a D1 database. The format is versioned so a backup
 * taken today can still be restored after the code has moved on.
 */

import schema from '../schema.json'

export const BACKUP_FORMAT = 1

export interface Backup {
  format: number
  exportedAt: string
  records: Array<{ id: string; table_key: string; fields: unknown; entry_date: string | null; created_at: string; updated_at: string }>
  edits: Array<{ id: number; record_id: string; table_key: string; field: string; before: unknown; after: unknown; by: string; at: string }>
  /** schema.json as deployed. Absent from backups made before it was added. */
  schema?: unknown
}

/** Rows read per query, so a large database is read in pieces. */
const PAGE = 500

async function all<T>(db: D1Database, sql: string): Promise<T[]> {
  const out: T[] = []
  for (let offset = 0; ; offset += PAGE) {
    const { results } = await db.prepare(`${sql} LIMIT ? OFFSET ?`).bind(PAGE, offset).all<T>()
    out.push(...(results ?? []))
    if (!results || results.length < PAGE) return out
  }
}

const parse = (v: string | null) => (v === null ? null : JSON.parse(v))

export async function exportAll(db: D1Database): Promise<Backup> {
  const records = await all<{ id: string; table_key: string; fields: string; entry_date: string | null; created_at: string; updated_at: string }>(
    db,
    'SELECT id, table_key, fields, entry_date, created_at, updated_at FROM records ORDER BY id'
  )
  const edits = await all<{ id: number; record_id: string; table_key: string; field: string; before: string | null; after: string | null; by: string; at: string }>(
    db,
    'SELECT id, record_id, table_key, field, before, after, by, at FROM edits ORDER BY id'
  )
  return {
    format: BACKUP_FORMAT,
    exportedAt: new Date().toISOString(),
    records: records.map((r) => ({ ...r, fields: JSON.parse(r.fields) })),
    edits: edits.map((e) => ({ ...e, before: parse(e.before), after: parse(e.after) })),
    schema,
  }
}

/** The backup as a gzipped JSON body. */
export function gzipped(backup: Backup): ReadableStream<Uint8Array> {
  return new Blob([JSON.stringify(backup)]).stream().pipeThrough(new CompressionStream('gzip'))
}

export const backupFilename = (day: string) => `pocket-scribe-backup-${day}.json.gz`

// ------------------------------------------------------------- nightly ----

/** Nightly copies kept; older ones are deleted. One per month is kept forever. */
export const KEEP_DAILY = 30
/** A one-time warning above this much backup storage — far below R2's free 10 GB. */
const WARN_BYTES = 1024 ** 3

const dailyKey = (day: string) => `daily/${day}.json.gz`
const monthlyKey = (day: string) => `monthly/${day.slice(0, 7)}.json.gz`

/** Which nightly copies to delete: everything older than KEEP_DAILY days before today. */
export function expiredDaily(keys: string[], today: string): string[] {
  const cutoff = new Date(`${today}T00:00:00Z`)
  cutoff.setUTCDate(cutoff.getUTCDate() - KEEP_DAILY)
  const oldest = cutoff.toISOString().slice(0, 10)
  return keys.filter((k) => {
    const day = k.match(/^daily\/(\d{4}-\d{2}-\d{2})\.json\.gz$/)?.[1]
    return day !== undefined && day < oldest
  })
}

async function listAll(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
  const out: R2Object[] = []
  let cursor: string | undefined
  do {
    const page = await bucket.list({ prefix, cursor })
    out.push(...page.objects)
    cursor = page.truncated ? page.cursor : undefined
  } while (cursor)
  return out
}

/**
 * Copy everything to R2, once a night. Returns what it did, for the log; the
 * caller tells you on Telegram only when it fails.
 */
export async function nightlyBackup(
  env: Pick<Env, 'DB' | 'BACKUPS'>,
  day: string
): Promise<{ key: string; bytes: number; monthly: boolean; deleted: number; totalBytes: number }> {
  const body = await new Response(gzipped(await exportAll(env.DB))).arrayBuffer()
  const meta = { httpMetadata: { contentType: 'application/gzip' } }

  const key = dailyKey(day)
  await env.BACKUPS.put(key, body, meta)
  // The first backup of each month is also kept as that month's copy.
  const monthly = !(await env.BACKUPS.head(monthlyKey(day)))
  if (monthly) await env.BACKUPS.put(monthlyKey(day), body, meta)

  const daily = await listAll(env.BACKUPS, 'daily/')
  const expired = expiredDaily(
    daily.map((o) => o.key),
    day
  )
  if (expired.length) await env.BACKUPS.delete(expired)

  const all = [...daily.filter((o) => !expired.includes(o.key)), ...(await listAll(env.BACKUPS, 'monthly/'))]
  const totalBytes = all.reduce((n, o) => n + o.size, 0)
  return { key, bytes: body.byteLength, monthly, deleted: expired.length, totalBytes }
}

export const BACKUP_WARN_BYTES = WARN_BYTES
