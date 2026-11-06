/**
 * Store backed by Cloudflare D1.
 *
 * Every schema.json table shares one `records` table (see
 * migrations/0001_records.sql): a row per record, its fields as JSON under the
 * names schema.json uses. Conditions become json_extract comparisons; updates
 * are applied field by field inside SQLite, so two writers touching different
 * fields of one record cannot lose each other's change.
 */

import type { Schema, SchemaTable } from '../planner'
import type { Actor, Query, Store, StoreRecord, StoreTable, Where } from './types'

const SELECT_TYPES = new Set(['singleSelect', 'multipleSelects'])

/** JSON path for a field name, quoted so spaces and punctuation are safe. */
export const path = (field: string) => `$."${field.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

/** 'rec' + 14 random characters — the same shape as the ids imported from Airtable, so all ids look alike. */
export function newId(): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
  const bytes = crypto.getRandomValues(new Uint8Array(14))
  return `rec${Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')}`
}

/** The field that dates a record: its date role, else its first date-like field. */
export function dateFieldOf(table: SchemaTable): string | undefined {
  return table.roles?.date ?? table.fields.find((f) => f.type === 'date' || f.type === 'dateTime')?.name
}

/** Empty fields are left out of a record rather than stored as blanks. */
const isEmpty = (v: unknown) => v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)

function condition(w: Where): { sql: string; binds: unknown[] } {
  const p = path(w.field)
  if ('truthy' in w) {
    return {
      sql: `(json_type(fields, ?) = 'true'
             OR (json_type(fields, ?) = 'text' AND json_extract(fields, ?) <> '')
             OR (json_type(fields, ?) IN ('integer', 'real') AND json_extract(fields, ?) <> 0)
             OR (json_type(fields, ?) = 'array' AND json_array_length(fields, ?) > 0))`,
      binds: [p, p, p, p, p, p, p],
    }
  }
  if ('equals' in w) return { sql: `json_extract(fields, ?) = ?`, binds: [p, w.equals] }
  if ('equalsIgnoringCase' in w) {
    return { sql: `LOWER(TRIM(json_extract(fields, ?))) = ?`, binds: [p, w.equalsIgnoringCase.trim().toLowerCase()] }
  }
  if ('sameDay' in w) return { sql: `substr(json_extract(fields, ?), 1, 10) = ?`, binds: [p, w.sameDay.trim().slice(0, 10)] }
  return { sql: `COALESCE(json_extract(fields, ?), '') <> ''`, binds: [p] }
}

interface Row {
  id: string
  fields: string
  created_at: string
}

const toRecord = (r: Row): StoreRecord => ({ id: r.id, fields: JSON.parse(r.fields), createdTime: r.created_at })

export function d1Store(db: D1Database, schema: Schema): Store {
  const tableOf = (name: string): SchemaTable => {
    const wanted = name.toLowerCase()
    const t = schema.tables.find((t) => t.name.toLowerCase() === wanted || t.key.toLowerCase() === wanted)
    if (!t) throw new Error(`no table "${name}" in schema.json`)
    return t
  }

  async function get(table: string, id: string): Promise<StoreRecord> {
    const t = tableOf(table)
    const row = await db
      .prepare('SELECT id, fields, created_at FROM records WHERE id = ? AND table_key = ?')
      .bind(id, t.key)
      .first<Row>()
    if (!row) throw new Error(`${t.name} has no record ${id}`)
    return toRecord(row)
  }

  return {
    async schema(): Promise<StoreTable[]> {
      // Choices are schema.json's plus every value already in use. A select is
      // just text, so a new choice exists the moment it is written.
      const lookups: Array<{ table: SchemaTable; field: string; stmt: D1PreparedStatement }> = []
      for (const t of schema.tables) {
        for (const f of t.fields) {
          if (!SELECT_TYPES.has(f.type)) continue
          const stmt =
            f.type === 'multipleSelects'
              ? db
                  .prepare(`SELECT DISTINCT j.value AS v FROM records, json_each(records.fields, ?) AS j WHERE records.table_key = ?`)
                  .bind(path(f.name), t.key)
              : db
                  .prepare(`SELECT DISTINCT json_extract(fields, ?) AS v FROM records WHERE table_key = ? AND json_extract(fields, ?) IS NOT NULL`)
                  .bind(path(f.name), t.key, path(f.name))
          lookups.push({ table: t, field: f.name, stmt })
        }
      }
      const results = lookups.length ? await db.batch<{ v: unknown }>(lookups.map((l) => l.stmt)) : []
      const used = new Map<string, string[]>()
      lookups.forEach((l, i) => {
        used.set(`${l.table.key}.${l.field}`, (results[i].results ?? []).map((r) => String(r.v)).filter(Boolean))
      })

      return schema.tables.map((t) => ({
        id: t.key,
        name: t.name,
        primaryFieldId: t.fields[0]?.name ?? '',
        fields: t.fields.map((f) => {
          if (!SELECT_TYPES.has(f.type)) return { id: f.name, name: f.name, type: f.type }
          const declared = (f.options?.choices ?? []).map((c) => c.name)
          const names = [...new Set([...declared, ...(used.get(`${t.key}.${f.name}`) ?? [])])]
          return { id: f.name, name: f.name, type: f.type, options: { choices: names.map((n) => ({ id: n, name: n })) } }
        }),
      }))
    },

    get,

    async list(table: string, q: Query = {}): Promise<StoreRecord[]> {
      const t = tableOf(table)
      const parts = (q.where ?? []).map(condition)
      const where = ['table_key = ?', ...parts.map((p) => p.sql)].join(' AND ')
      const binds: unknown[] = [t.key, ...parts.flatMap((p) => p.binds)]
      let order = 'created_at ASC, id ASC'
      if (q.sort) {
        const dir = q.direction === 'asc' ? 'ASC' : 'DESC'
        order = `json_extract(fields, ?) ${dir}, created_at ${dir}`
        binds.push(path(q.sort))
      }
      let sql = `SELECT id, fields, created_at FROM records WHERE ${where} ORDER BY ${order}`
      if (q.limit) {
        sql += ' LIMIT ?'
        binds.push(q.limit)
      }
      const { results } = await db.prepare(sql).bind(...binds).all<Row>()
      return (results ?? []).map(toRecord)
    },

    async create(table: string, fields: Record<string, unknown>, by: Actor = 'system'): Promise<StoreRecord> {
      const t = tableOf(table)
      const clean = Object.fromEntries(Object.entries(fields).filter(([, v]) => !isEmpty(v)))
      const id = newId()
      const now = new Date().toISOString()
      const dateField = dateFieldOf(t)
      const day = dateField && typeof clean[dateField] === 'string' ? (clean[dateField] as string).slice(0, 10) : null
      const json = JSON.stringify(clean)
      await db.batch([
        db
          .prepare('INSERT INTO records (id, table_key, fields, entry_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .bind(id, t.key, json, day, now, now),
        db
          .prepare(`INSERT INTO edits (record_id, table_key, field, before, after, by, at) VALUES (?, ?, '(created)', NULL, ?, ?, ?)`)
          .bind(id, t.key, json, by, now),
      ])
      return { id, fields: clean, createdTime: now }
    },

    async update(table: string, id: string, fields: Record<string, unknown>, by: Actor = 'system'): Promise<StoreRecord> {
      const t = tableOf(table)
      // Read first only for history: the write itself is applied per field in
      // SQL, so a concurrent update to another field is never overwritten.
      const current = await get(table, id)
      const now = new Date().toISOString()

      const sets: Array<[string, unknown]> = []
      const clears: string[] = []
      const changes: Array<{ field: string; before: unknown; after: unknown }> = []
      for (const [field, value] of Object.entries(fields)) {
        const before = current.fields[field]
        if (isEmpty(value)) {
          if (!isEmpty(before)) {
            clears.push(field)
            changes.push({ field, before, after: null })
          }
          continue
        }
        if (JSON.stringify(before) === JSON.stringify(value)) continue
        sets.push([field, value])
        changes.push({ field, before: before ?? null, after: value })
      }
      if (!changes.length) return current

      let expr = 'fields'
      const binds: unknown[] = []
      if (sets.length) {
        expr = `json_set(${expr}, ${sets.map(() => '?, json(?)').join(', ')})`
        for (const [field, value] of sets) binds.push(path(field), JSON.stringify(value))
      }
      if (clears.length) {
        expr = `json_remove(${expr}, ${clears.map(() => '?').join(', ')})`
        binds.push(...clears.map(path))
      }

      const dateField = dateFieldOf(t)
      const statements = [
        db.prepare(`UPDATE records SET fields = ${expr}, updated_at = ? WHERE id = ? AND table_key = ?`).bind(...binds, now, id, t.key),
        ...changes.map((c) =>
          db
            .prepare('INSERT INTO edits (record_id, table_key, field, before, after, by, at) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .bind(id, t.key, c.field, c.before === null ? null : JSON.stringify(c.before), c.after === null ? null : JSON.stringify(c.after), by, now)
        ),
      ]
      if (dateField && changes.some((c) => c.field === dateField)) {
        statements.push(
          db.prepare('UPDATE records SET entry_date = substr(json_extract(fields, ?), 1, 10) WHERE id = ?').bind(path(dateField), id)
        )
      }
      await db.batch(statements)
      return get(table, id)
    },
  }
}
