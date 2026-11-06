#!/usr/bin/env node
/**
 * Set up (or check) everything Pocket Scribe needs in a Cloudflare account.
 *
 *   npm run setup             create what is missing, record the ids in .env
 *   npm run setup -- --check  report what would change, change nothing
 *
 * Safe to run any number of times: it reuses the KV namespace, D1 database and
 * Access application it finds, and rewrites an id in .env only when it
 * differs. Reads CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, OWNER_EMAIL and
 * TIMEZONE from .env, and writes the wrangler configs from their templates
 * (`npm run config`).
 */

import { existsSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import { composeSchema, loadDotEnv, loadSchema, setEnv, trackerMenu, validateSchema, writeConfigs, configValues, ROOT } from './lib.mjs'

const CHECK = process.argv.includes('--check')
const unknown = process.argv.slice(2).filter((a) => a !== '--check')
if (unknown.length) {
  console.error(`unrecognized argument(s): ${unknown.join(' ')}`)
  process.exit(2)
}

const API = 'https://api.cloudflare.com/client/v4'
const WORKER = 'pocket-scribe'
const APP = 'pocket-scribe-app'
const DB_NAME = 'pocket-scribe'
const KV_TITLE = 'pocket-scribe-state'
const BUCKET = 'pocket-scribe-backups'

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
const step = (s) => console.log(`\n${c('1;36', '==>')} ${c('1', s)}`)
const ok = (s) => console.log(`  ${c('32', '✓')} ${s}`)
const info = (s) => console.log(`  ${c('2', '·')} ${c('2', s)}`)
const warn = (s) => console.log(`  ${c('33', '!')} ${s}`)
const problems = []
function fail(message, remedy) {
  console.error(`\n${c('31', '✗')} ${c('1', message)}${remedy ? `\n\n${remedy}` : ''}\n`)
  process.exit(1)
}

loadDotEnv()
const token = process.env.CLOUDFLARE_API_TOKEN
const account = process.env.CLOUDFLARE_ACCOUNT_ID
const owners = (process.env.OWNER_EMAIL ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const timezone = process.env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone

async function cf(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  const json = await res.json().catch(() => ({}))
  return { status: res.status, ok: res.ok && json.success !== false, result: json.result, errors: json.errors ?? [] }
}
const why = (r) => r.errors.map((e) => `${e.code}: ${e.message}`).join('; ') || `HTTP ${r.status}`

// ---------------------------------------------------------------- inputs ----

step('Checking .env and schema.json')
if (!token || !account) {
  fail('CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID must be set in .env', 'SETUP.md, Step 2, says how to create the token.')
}
if (!owners.length) fail('OWNER_EMAIL is not set in .env', 'Put the email you use to sign in to Cloudflare: it is who the app lets in.')
ok(`account ${account}, app sign-in for ${owners.join(', ')}, time zone ${timezone}`)
// schema.json is yours, not the shared repo's. Normally SETUP.md's Step 4 has
// made it from the menu by now; if not, start with the suggested trackers.
if (!existsSync(resolve(ROOT, 'schema.json'))) {
  if (CHECK) fail('schema.json not found', 'Choose your trackers first: npm run trackers (SETUP.md, Step 4).')
  const suggested = trackerMenu().filter((m) => m.suggested)
  writeFileSync(resolve(ROOT, 'schema.json'), JSON.stringify(composeSchema(suggested), null, 2) + '\n')
  ok(`created schema.json with the suggested trackers (${suggested.map((m) => m.table.name).join(', ')}); add more with npm run trackers`)
}
const errors = validateSchema(loadSchema())
if (errors.length) fail('schema.json has problems', errors.map((e) => `  · ${e}`).join('\n'))
ok('schema.json is valid')

const verify = (await cf('GET', `/accounts/${account}/tokens/verify`)).ok ? true : (await cf('GET', '/user/tokens/verify')).ok
if (!verify) fail('CLOUDFLARE_API_TOKEN was rejected', 'Check the token in .env, and that it is scoped to this account.')
ok('token is valid')

// ------------------------------------------------------------- resources ----

step('Workers subdomain')
const sub = await cf('GET', `/accounts/${account}/workers/subdomain`)
if (!sub.ok || !sub.result?.subdomain) {
  fail(
    'This account has no workers.dev subdomain yet',
    `Open the Cloudflare dashboard → Workers & Pages once; it asks you to pick one. (${why(sub)})`
  )
}
const workerUrl = `https://${WORKER}.${sub.result.subdomain}.workers.dev`
const appHost = `${APP}.${sub.result.subdomain}.workers.dev`
ok(`${sub.result.subdomain}.workers.dev`)

// Ids found or created below go into .env, and the wrangler configs are made
// from them. What .env already says is tried first.

step('KV namespace (recording dedupe and small state)')
let kvId
{
  const list = await cf('GET', `/accounts/${account}/storage/kv/namespaces?per_page=100`)
  if (!list.ok) fail('Could not list KV namespaces', `The token needs "Workers KV Storage: Edit". (${why(list)})`)
  const configured = process.env.KV_ID
  const found = list.result.find((n) => n.id === configured) ?? list.result.find((n) => n.title === KV_TITLE)
  if (found) {
    kvId = found.id
    ok(`using "${found.title}" (${kvId})`)
  } else if (CHECK) {
    info(`would create "${KV_TITLE}"`)
  } else {
    const made = await cf('POST', `/accounts/${account}/storage/kv/namespaces`, { title: KV_TITLE })
    if (!made.ok) fail('Could not create the KV namespace', why(made))
    kvId = made.result.id
    ok(`created "${KV_TITLE}" (${kvId})`)
  }
}

step('D1 database (every record)')
let d1Id
{
  const list = await cf('GET', `/accounts/${account}/d1/database?per_page=100`)
  if (!list.ok) fail('Could not list D1 databases', `The token needs "D1: Edit". (${why(list)})`)
  const configured = process.env.D1_ID
  const found = list.result.find((d) => d.uuid === configured) ?? list.result.find((d) => d.name === DB_NAME)
  if (found) {
    d1Id = found.uuid
    ok(`using "${found.name}" (${d1Id})`)
  } else if (CHECK) {
    info(`would create "${DB_NAME}"`)
  } else {
    const made = await cf('POST', `/accounts/${account}/d1/database`, { name: DB_NAME })
    if (!made.ok) fail('Could not create the D1 database', why(made))
    d1Id = made.result.uuid
    ok(`created "${DB_NAME}" (${d1Id})`)
  }
}

step('R2 bucket (nightly backups)')
{
  const list = await cf('GET', `/accounts/${account}/r2/buckets?name_contains=${BUCKET}`)
  if (!list.ok) {
    const off = list.errors.some((e) => e.code === 10042 || /enable R2/i.test(e.message))
    fail(
      off ? 'R2 is not enabled on this account' : 'Could not list R2 buckets',
      off
        ? 'Dashboard → R2 Object Storage → enable it. It asks for a payment method, but backups stay far inside the free 10 GB.'
        : `The token needs "Workers R2 Storage: Edit" (part of the Edit Cloudflare Workers template). (${why(list)})`
    )
  }
  const found = (list.result?.buckets ?? []).some((b) => b.name === BUCKET)
  if (found) ok(`using "${BUCKET}"`)
  else if (CHECK) info(`would create "${BUCKET}"`)
  else {
    const made = await cf('POST', `/accounts/${account}/r2/buckets`, { name: BUCKET })
    if (!made.ok) fail('Could not create the R2 bucket', why(made))
    ok(`created "${BUCKET}"`)
  }
}

// ---------------------------------------------------------------- access ----

step('Cloudflare Access (who may open the app)')
let aud
let team = process.env.ACCESS_TEAM_DOMAIN || undefined
{
  const apps = await cf('GET', `/accounts/${account}/access/apps`)
  if (!apps.ok) {
    const disabled = apps.errors.some((e) => /not.?enabled/i.test(e.message))
    warn(
      disabled
        ? 'Zero Trust is not enabled on this account. Dashboard → Zero Trust, pick a team name and the Free plan, then run setup again.'
        : `Could not read Access applications: the token needs "Access: Apps and Policies: Edit". (${why(apps)})`
    )
    problems.push('Access')
  } else {
    const found = apps.result.find((a) => a.domain === appHost)
    if (found) {
      aud = found.aud
      ok(`using "${found.name}" for ${appHost}`)
      const allowed = (found.policies ?? []).flatMap((p) => (p.include ?? []).map((i) => i.email?.email)).filter(Boolean)
      const absent = owners.filter((e) => !allowed.map((a) => a.toLowerCase()).includes(e.toLowerCase()))
      if (absent.length) warn(`OWNER_EMAIL includes ${absent.join(', ')}, which the Access policy does not allow — edit the policy in Zero Trust → Access → Applications`)
    } else if (CHECK) {
      info(`would create an Access application for ${appHost}`)
    } else {
      const made = await cf('POST', `/accounts/${account}/access/apps`, {
        name: 'Pocket Scribe app',
        type: 'self_hosted',
        domain: appHost,
        session_duration: '720h',
        app_launcher_visible: false,
        policies: [{ name: 'Owner', decision: 'allow', include: owners.map((email) => ({ email: { email } })) }],
      })
      if (!made.ok) fail('Could not create the Access application', why(made))
      aud = made.result.aud
      ok(`created an Access application for ${appHost}, allowing ${owners.join(', ')}`)
    }

    const org = await cf('GET', `/accounts/${account}/access/organizations`)
    if (org.ok && org.result?.auth_domain) {
      team = org.result.auth_domain
      ok(`team domain ${team}`)
    } else if (team) {
      info(`team domain ${team} (from .env)`)
    } else {
      // Without permission to read the organization, the login redirect for
      // the app names it — but only once the app Worker is deployed.
      const probe = await fetch(`https://${appHost}/`, { redirect: 'manual' }).catch(() => null)
      const location = probe?.headers.get('location') ?? ''
      const host = location.match(/^https:\/\/([^/]+\.cloudflareaccess\.com)\//)?.[1]
      if (host) {
        team = host
        ok(`team domain ${team}`)
      } else {
        warn('Could not find the Access team domain yet. Deploy the app (npm run deploy:app), then run setup again.')
        problems.push('team domain')
        team = undefined
      }
    }
  }
}

// --------------------------------------------------------------- configs ----

step('Recording ids in .env, and writing the wrangler configs')
const ids = { KV_ID: kvId, D1_ID: d1Id, ACCESS_TEAM_DOMAIN: team, ACCESS_AUD: aud, APP_URL: `https://${appHost}`, WORKER_URL: workerUrl }
for (const [key, value] of Object.entries(ids)) {
  if (!value || process.env[key] === value) continue
  if (CHECK) info(`would set ${key}=${value} in .env (now ${process.env[key] || 'blank'})`)
  else {
    setEnv(key, value)
    ok(`${key}=${value}`)
  }
}
if (!CHECK) {
  const { missing, written } = writeConfigs(configValues())
  if (missing.length) fail(`.env still has no ${missing.join(', ')}`, 'Fix what is flagged above and run setup again.')
  ok(written.length ? `wrote ${written.join(' and ')}` : 'wrangler configs already up to date')
}

// ------------------------------------------------------------ migrations ----

step('Database tables')
if (CHECK || !d1Id) {
  info('would apply migrations/ to the database')
} else {
  const res = spawnSync('npx', ['wrangler', 'd1', 'migrations', 'apply', DB_NAME, '--remote'], { cwd: ROOT, encoding: 'utf8' })
  const out = `${res.stdout ?? ''}${res.stderr ?? ''}`
  if (res.status !== 0) fail('Applying migrations failed', out.trim().split('\n').slice(-8).join('\n'))
  ok(/No migrations to apply/i.test(out) ? 'already up to date' : 'migrations applied')
}

// ------------------------------------------------------------------ done ----

console.log('')
if (problems.length) {
  console.log(`${c('33', '!')} Setup is incomplete (${problems.join(', ')}). Fix what is flagged above and run it again.`)
  console.log(`  The capture Worker can be deployed now; the app can't let anyone in until this finishes cleanly.\n`)
  process.exit(1)
}
console.log(`${c('32', '✓')} ${CHECK ? 'Check complete — nothing was changed.' : 'Cloudflare is ready.'}`)
console.log(`  capture Worker  ${workerUrl}`)
console.log(`  app             https://${appHost}\n`)
