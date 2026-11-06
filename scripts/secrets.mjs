#!/usr/bin/env node
/**
 * Push every runtime secret from .env to the deployed Worker.
 *
 * `.env` is local-dev only — wrangler never uploads it — so a value that works
 * in `wrangler dev` is not on the Worker until it is pushed. Doing them one at
 * a time by hand is how a half-configured deployment happens.
 *
 *   npm run secrets
 */

import { readFileSync, existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENV = resolve(ROOT, '.env')

/**
 * Secrets each Worker reads at runtime. Optional ones are skipped quietly when
 * blank: the Pocket webhook is a bonus (polling is the primary path), and
 * WORKER_URL is only used by `npm run telegram:setup`.
 */
const TARGETS = [
  {
    label: 'capture Worker',
    config: 'wrangler.jsonc',
    keys: ['POCKET_API_KEY', 'ANTHROPIC_API_KEY', 'TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID', 'TELEGRAM_WEBHOOK_SECRET'],
    optional: ['POCKET_WEBHOOK_SECRET', 'WORKER_URL'],
  },
  // The app files recordings from Review through the planner.
  { label: 'app', config: 'wrangler.app.jsonc', keys: ['ANTHROPIC_API_KEY'], optional: [] },
]

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)

if (!existsSync(ENV)) {
  console.error(`\n${c('31', '✗ .env not found')}\n`)
  process.exit(1)
}

const values = {}
for (const line of readFileSync(ENV, 'utf8').split('\n')) {
  const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
  if (m && m[2].trim()) values[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
}

// wrangler reads this repo's own CLOUDFLARE_API_TOKEN from .env. One exported
// in the shell would override it and could target another account.
const env = { ...process.env }
delete env.CLOUDFLARE_API_TOKEN
delete env.CLOUDFLARE_ACCOUNT_ID

console.log('')
let pushed = 0
let expected = 0
const missing = []

for (const target of TARGETS) {
  console.log(`  ${target.label}`)
  for (const key of [...target.keys, ...target.optional]) {
    const value = values[key]
    const optional = target.optional.includes(key)
    if (!value) {
      if (!optional) {
        missing.push(key)
        console.log(`    ${c('33', '!')} ${key} ${c('2', 'not set in .env — skipped')}`)
      }
      continue
    }
    expected++
    const res = spawnSync('npx', ['wrangler', 'secret', 'put', key, '-c', target.config], {
      input: value,
      env,
      cwd: ROOT,
      encoding: 'utf8',
    })
    const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
    if (res.status === 0 && /Success/i.test(out)) {
      console.log(`    ${c('32', '✓')} ${key}`)
      pushed++
    } else {
      console.log(`    ${c('31', '✗')} ${key} — ${out.trim().split('\n').slice(-1)[0]}`)
    }
  }
}

console.log(`\n${pushed}/${expected} pushed.`)
if (missing.length) console.log(`${c('2', 'Missing from .env: ' + [...new Set(missing)].join(', '))}`)
console.log('')
if (missing.length || pushed < expected) process.exit(1)
