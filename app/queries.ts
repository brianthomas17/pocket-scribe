/**
 * The reads the app needs that the Worker's store does not: a day's entries,
 * newest-first browsing with search, the review queue, and a record's history.
 *
 * Writes always go through the store, so every change lands in `edits`.
 */

import type { StoreRecord } from '../src/store'

interface Row {
  id: string
  fields: string
  created_at: string
}

const toRecord = (r: Row): StoreRecord => ({ id: r.id, fields: JSON.parse(r.fields), createdTime: r.created_at })

/** Every record of these tables dated on this day. */
export async function onDay(db: D1Database, tableKeys: string[], day: string): Promise<Map<string, StoreRecord[]>> {
  const out = new Map<string, StoreRecord[]>(tableKeys.map((k) => [k, []]))
  if (!tableKeys.length) return out
  const { results } = await db
    .prepare(
      `SELECT id, table_key, fields, created_at FROM records
       WHERE entry_date = ? AND table_key IN (${tableKeys.map(() => '?').join(', ')})
       ORDER BY created_at ASC`
    )
    .bind(day, ...tableKeys)
    .all<Row & { table_key: string }>()
  for (const r of results ?? []) out.get(r.table_key)?.push(toRecord(r))
  return out
}

/**
 * Records of a table dated on this month and day in earlier years, newest
 * first — "on this day", computed live rather than frozen in a field.
 */
export async function sameDayEarlierYears(db: D1Database, tableKey: string, day: string): Promise<StoreRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT id, fields, created_at FROM records
       WHERE table_key = ? AND substr(entry_date, 6) = ? AND entry_date < ?
       ORDER BY entry_date DESC`
    )
    .bind(tableKey, day.slice(5), day)
    .all<Row>()
  return (results ?? []).map(toRecord)
}

/** Escape LIKE's wildcards so a search for "50%" means fifty percent. */
const likeTerm = (q: string) => `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`

export const PAGE = 50

/**
 * A table, newest first by its date, then by when the record was made.
 * The search matches any text value in the record, not its field names.
 */
export async function browse(
  db: D1Database,
  tableKey: string,
  opts: { q?: string; page?: number }
): Promise<{ records: StoreRecord[]; more: boolean }> {
  const binds: unknown[] = [tableKey]
  let where = 'table_key = ?'
  if (opts.q?.trim()) {
    where += ` AND EXISTS (SELECT 1 FROM json_each(records.fields) AS j WHERE j.type = 'text' AND j.value LIKE ? ESCAPE '\\')`
    binds.push(likeTerm(opts.q.trim()))
  }
  const page = Math.max(0, opts.page ?? 0)
  binds.push(PAGE + 1, page * PAGE)
  const { results } = await db
    .prepare(
      `SELECT id, fields, created_at FROM records WHERE ${where}
       ORDER BY entry_date DESC NULLS LAST, created_at DESC LIMIT ? OFFSET ?`
    )
    .bind(...binds)
    .all<Row>()
  const rows = (results ?? []).map(toRecord)
  return { records: rows.slice(0, PAGE), more: rows.length > PAGE }
}

export async function count(db: D1Database, tableKey: string): Promise<number> {
  const row = await db.prepare('SELECT COUNT(*) AS n FROM records WHERE table_key = ?').bind(tableKey).first<{ n: number }>()
  return row?.n ?? 0
}

export const NEEDS_YOU = ['Unrouted', 'Needs review', 'Failed']

/** Captures waiting on a person: not filed, not yet resolved. Newest first. */
export async function reviewQueue(db: D1Database): Promise<StoreRecord[]> {
  const { results } = await db
    .prepare(
      `SELECT id, fields, created_at FROM records
       WHERE table_key = 'capture_log'
         AND json_extract(fields, '$."Status"') IN (${NEEDS_YOU.map(() => '?').join(', ')})
         AND COALESCE(json_extract(fields, '$."Resolved"'), 0) = 0
       ORDER BY json_extract(fields, '$."Recorded At"') DESC, created_at DESC
       LIMIT 100`
    )
    .bind(...NEEDS_YOU)
    .all<Row>()
  return (results ?? []).map(toRecord)
}

export async function reviewCount(db: D1Database): Promise<number> {
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS n FROM records
       WHERE table_key = 'capture_log'
         AND json_extract(fields, '$."Status"') IN (${NEEDS_YOU.map(() => '?').join(', ')})
         AND COALESCE(json_extract(fields, '$."Resolved"'), 0) = 0`
    )
    .bind(...NEEDS_YOU)
    .first<{ n: number }>()
  return row?.n ?? 0
}

/** The capture that wrote this record, if one did. */
export async function captureFor(db: D1Database, recordId: string): Promise<StoreRecord | null> {
  const row = await db
    .prepare(
      `SELECT id, fields, created_at FROM records
       WHERE table_key = 'capture_log' AND instr(COALESCE(json_extract(fields, '$."Target Record ID"'), ''), ?) > 0
       ORDER BY created_at DESC LIMIT 1`
    )
    .bind(recordId)
    .first<Row>()
  return row ? toRecord(row) : null
}

export interface Edit {
  field: string
  before: unknown
  after: unknown
  by: string
  at: string
}

export async function history(db: D1Database, recordId: string): Promise<Edit[]> {
  const { results } = await db
    .prepare('SELECT field, before, after, by, at FROM edits WHERE record_id = ? ORDER BY id DESC LIMIT 200')
    .bind(recordId)
    .all<{ field: string; before: string | null; after: string | null; by: string; at: string }>()
  const parse = (v: string | null) => (v === null ? null : JSON.parse(v))
  return (results ?? []).map((e) => ({ ...e, before: parse(e.before), after: parse(e.after) }))
}
