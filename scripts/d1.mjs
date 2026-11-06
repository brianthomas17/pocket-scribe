/**
 * Run SQL against a remote D1 database through wrangler, the same way you
 * would by hand, so the scripts use this repo's own Cloudflare token.
 */

import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { ROOT } from './lib.mjs'

const WRANGLER = resolve(ROOT, 'node_modules/.bin/wrangler')

export function query(db, sql) {
  const out = execFileSync(WRANGLER, ['d1', 'execute', db, '--remote', '--json', '--command', sql], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  return JSON.parse(out)[0].results
}

export function executeFile(db, file) {
  execFileSync(WRANGLER, ['d1', 'execute', db, '--remote', '--yes', '--file', file], { cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit'] })
}

/** Every row of a query, read in pages so a large table never has to fit one response. */
export function queryAll(db, sql, page = 500) {
  const rows = []
  for (let offset = 0; ; offset += page) {
    const batch = query(db, `${sql} LIMIT ${page} OFFSET ${offset}`)
    rows.push(...batch)
    if (batch.length < page) return rows
  }
}
