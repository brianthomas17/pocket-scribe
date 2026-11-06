#!/usr/bin/env node
/**
 * Save a backup of the database to this computer.
 *
 *   npm run backup                     → backups/pocket-scribe-backup-YYYY-MM-DD.json.gz
 *   npm run backup -- --db <name>      a different database
 *   npm run backup -- --keep 30        then delete all but the newest 30 backups
 *
 * The same file the app's "Download a backup" gives you. backups/ is gitignored:
 * it is your journal.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { gzipSync } from 'node:zlib'
import { ROOT } from './lib.mjs'
import { queryAll } from './d1.mjs'

const args = process.argv.slice(2)
const db = args.includes('--db') ? args[args.indexOf('--db') + 1] : 'pocket-scribe'
const keep = args.includes('--keep') ? Number(args[args.indexOf('--keep') + 1]) : 0

const parse = (v) => (v === null ? null : JSON.parse(v))
const records = queryAll(db, 'SELECT id, table_key, fields, entry_date, created_at, updated_at FROM records ORDER BY id').map((r) => ({ ...r, fields: JSON.parse(r.fields) }))
const edits = queryAll(db, 'SELECT id, record_id, table_key, field, before, after, by, at FROM edits ORDER BY id').map((e) => ({ ...e, before: parse(e.before), after: parse(e.after) }))
// Your trackers, so a backup is enough to rebuild everything.
const schemaPath = resolve(ROOT, 'schema.json')
const schema = existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, 'utf8')) : undefined
const backup = { format: 1, exportedAt: new Date().toISOString(), records, edits, schema }

const dir = resolve(ROOT, 'backups')
mkdirSync(dir, { recursive: true })
const file = join(dir, `pocket-scribe-backup-${backup.exportedAt.slice(0, 10)}.json.gz`)
writeFileSync(file, gzipSync(JSON.stringify(backup)))
console.log(`✓ ${records.length} records and ${edits.length} edits from "${db}" → ${file}`)

if (keep > 0) {
  // Names sort by date, so the oldest come first.
  const all = readdirSync(dir).filter((f) => /^pocket-scribe-backup-\d{4}-\d{2}-\d{2}\.json\.gz$/.test(f)).sort()
  for (const old of all.slice(0, Math.max(0, all.length - keep))) {
    unlinkSync(join(dir, old))
    console.log(`  removed ${old}`)
  }
}
