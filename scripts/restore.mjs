#!/usr/bin/env node
/**
 * Put a backup back into a D1 database.
 *
 *   npm run restore -- <backup.json.gz> --db <name>          show what would happen
 *   npm run restore -- <backup.json.gz> --db <name> --yes    replace the database with the backup
 *
 * Replaces everything in the database's records and edits tables with the
 * backup's, then reads every record back and compares it to the file. Take a
 * fresh backup first (npm run backup) if what is there now matters.
 *
 * The backup's trackers are written to schema.json when there is none (a new
 * computer), or to schema.from-backup.json beside yours when they differ.
 */

import { existsSync, readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { gunzipSync } from 'node:zlib'
import { executeFile, query, queryAll } from './d1.mjs'
import { ROOT } from './lib.mjs'

const args = process.argv.slice(2)
const file = args.find((a) => !a.startsWith('--') && args[args.indexOf(a) - 1] !== '--db')
const db = args.includes('--db') ? args[args.indexOf('--db') + 1] : null
const yes = args.includes('--yes')
if (!file || !db) {
  console.error('usage: npm run restore -- <backup.json.gz> --db <database name> [--yes]')
  process.exit(2)
}

const raw = readFileSync(file)
const backup = JSON.parse((raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : raw).toString('utf8'))
if (backup.format !== 1) {
  console.error(`✗ backup format ${backup.format} is not one this version of restore understands`)
  process.exit(1)
}

const [{ n: now }] = query(db, 'SELECT COUNT(*) AS n FROM records')
console.log(`backup from ${backup.exportedAt}: ${backup.records.length} records, ${backup.edits.length} edits`)
console.log(`"${db}" has ${now} records now`)
if (!yes) {
  console.log(`\nNothing changed. Add --yes to replace everything in "${db}" with the backup.`)
  process.exit(0)
}

// One statement per line. D1 rejects a statement over 100 KB, so any row that
// would exceed LIMIT is written small first and its long values appended in
// pieces afterwards.
const LIMIT = 90_000
const CHUNK = 40_000
const sql = (v) => (v === null || v === undefined ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)
const path = (f) => `$."${f.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
const json = (v) => (v === null || v === undefined ? null : JSON.stringify(v))
const pieces = (s) => Array.from({ length: Math.ceil(s.length / CHUNK) }, (_, i) => s.slice(i * CHUNK, (i + 1) * CHUNK))
const lines = ['DELETE FROM edits;', 'DELETE FROM records;']

for (const r of backup.records) {
  const insert = (fields) =>
    `INSERT INTO records (id, table_key, fields, entry_date, created_at, updated_at) VALUES (${sql(r.id)}, ${sql(r.table_key)}, ${sql(JSON.stringify(fields))}, ${sql(r.entry_date)}, ${sql(r.created_at)}, ${sql(r.updated_at)});`
  // Move the longest text fields out until the row fits.
  const inline = { ...r.fields }
  const later = []
  const byLength = Object.entries(r.fields).filter(([, v]) => typeof v === 'string').sort((a, b) => b[1].length - a[1].length)
  while (insert(inline).length > LIMIT && byLength.length) {
    const [field, value] = byLength.shift()
    delete inline[field]
    later.push([field, value])
  }
  lines.push(insert(inline))
  for (const [field, value] of later) {
    for (const piece of pieces(value)) {
      lines.push(`UPDATE records SET fields = json_set(fields, ${sql(path(field))}, COALESCE(json_extract(fields, ${sql(path(field))}), '') || ${sql(piece)}) WHERE id = ${sql(r.id)};`)
    }
  }
}

backup.edits.forEach((e, i) => {
  const id = e.id ?? i + 1
  const before = json(e.before)
  const after = json(e.after)
  const full = `INSERT INTO edits (id, record_id, table_key, field, before, after, by, at) VALUES (${id}, ${sql(e.record_id)}, ${sql(e.table_key)}, ${sql(e.field)}, ${sql(before)}, ${sql(after)}, ${sql(e.by)}, ${sql(e.at)});`
  if (full.length <= LIMIT) return lines.push(full)
  lines.push(`INSERT INTO edits (id, record_id, table_key, field, before, after, by, at) VALUES (${id}, ${sql(e.record_id)}, ${sql(e.table_key)}, ${sql(e.field)}, ${before === null ? 'NULL' : "''"}, ${after === null ? 'NULL' : "''"}, ${sql(e.by)}, ${sql(e.at)});`)
  for (const [column, value] of [['before', before], ['after', after]]) {
    if (value === null) continue
    for (const piece of pieces(value)) lines.push(`UPDATE edits SET ${column} = ${column} || ${sql(piece)} WHERE id = ${id};`)
  }
})
const work = mkdtempSync(join(tmpdir(), 'pocket-scribe-restore-'))
const out = join(work, 'restore.sql')
writeFileSync(out, lines.join('\n') + '\n')
if (process.env.KEEP_SQL) { console.log(`kept ${out}`); process.exit(0) }
executeFile(db, out)
if (!process.env.KEEP_SQL) rmSync(work, { recursive: true, force: true })
else console.log(`kept ${out}`)

// Read it all back and compare, record by record.
const canonical = (v) => (Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])])) : v)
const back = new Map(queryAll(db, 'SELECT id, table_key, fields FROM records ORDER BY id').map((r) => [r.id, r]))
const wrong = backup.records.filter((r) => {
  const got = back.get(r.id)
  return !got || got.table_key !== r.table_key || JSON.stringify(canonical(JSON.parse(got.fields))) !== JSON.stringify(canonical(r.fields))
})
const editsBack = new Map(queryAll(db, 'SELECT id, record_id, field, before, after, by, at FROM edits ORDER BY id').map((e) => [e.id, e]))
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b))
const parse = (v) => (v === null ? null : JSON.parse(v))
const wrongEdits = backup.edits.filter((e, i) => {
  const got = editsBack.get(e.id ?? i + 1)
  return !got || got.record_id !== e.record_id || got.field !== e.field || got.by !== e.by || got.at !== e.at || !same(parse(got.before), e.before) || !same(parse(got.after), e.after)
})
if (wrong.length || wrongEdits.length || back.size !== backup.records.length || editsBack.size !== backup.edits.length) {
  console.error(`✗ restored, but ${wrong.length} record(s) and ${wrongEdits.length} edit(s) differ; ${back.size}/${backup.records.length} records, ${editsBack.size}/${backup.edits.length} edits`)
  process.exit(1)
}
console.log(`✓ restored into "${db}": every record and every edit matches the backup (${back.size} records, ${editsBack.size} edits)`)

if (backup.schema) {
  const mine = resolve(ROOT, 'schema.json')
  const text = JSON.stringify(backup.schema, null, 2) + '\n'
  if (!existsSync(mine)) {
    writeFileSync(mine, text)
    console.log('✓ schema.json written from the backup: deploy (npm run deploy, npm run deploy:app) to use it')
  } else if (!same(JSON.parse(readFileSync(mine, 'utf8')), backup.schema)) {
    writeFileSync(resolve(ROOT, 'schema.from-backup.json'), text)
    console.log('· your schema.json differs from the backup\'s; the backup\'s is in schema.from-backup.json')
  }
}
