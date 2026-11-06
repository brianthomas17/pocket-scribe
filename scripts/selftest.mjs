#!/usr/bin/env node
/**
 * Self-test for the scripts: .env loading and schema.json validation.
 *
 * These are the pieces that have burned us: .env precedence (a blank
 * placeholder shadowing a real value silently broke the documented setup path)
 * and schema validation (the only thing standing between a typo in schema.json
 * and a planner writing to a field that does not exist).
 *
 *   npm test
 */

import { copyFileSync, existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { loadDotEnv, validateSchema, patchConfig, writeConfigs, setEnv, CONFIGS, ROOT, trackerMenu, composeSchema, addTrackers, removeTrackers } from './lib.mjs'

let passed = 0
const failures = []

function check(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failures.push(`${name}: ${e.message}`)
    console.log(`  ✗ ${name}\n      ${e.message}`)
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message)
}

function withEnvFile(contents, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'pocket-scribe-test-'))
  const path = join(dir, '.env')
  writeFileSync(path, contents)
  const snapshot = { ...process.env }
  try {
    fn(path)
  } finally {
    for (const k of Object.keys(process.env)) if (!(k in snapshot)) delete process.env[k]
    for (const [k, v] of Object.entries(snapshot)) process.env[k] = v
    rmSync(dir, { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- .env ------

console.log('\n.env parsing')

check('a later assignment beats an earlier one', () => {
  // This is the exact shape --write-env produces: .env.example ships a blank
  // AIRTABLE_BASE_ID= and the real value gets appended below it.
  withEnvFile('AIRTABLE_BASE_ID=\nAIRTABLE_TOKEN=pat1\n\nAIRTABLE_BASE_ID=appREAL\n', (p) => {
    delete process.env.AIRTABLE_BASE_ID
    loadDotEnv(p)
    assert(
      process.env.AIRTABLE_BASE_ID === 'appREAL',
      `expected appREAL, got ${JSON.stringify(process.env.AIRTABLE_BASE_ID)}`
    )
  })
})

check('a blank assignment never binds', () => {
  withEnvFile('AIRTABLE_BASE_ID=\n', (p) => {
    delete process.env.AIRTABLE_BASE_ID
    loadDotEnv(p)
    assert(
      process.env.AIRTABLE_BASE_ID === undefined,
      `expected undefined, got ${JSON.stringify(process.env.AIRTABLE_BASE_ID)}`
    )
  })
})

check('the real environment beats the file', () => {
  withEnvFile('AIRTABLE_TOKEN=fromfile\n', (p) => {
    process.env.AIRTABLE_TOKEN = 'fromenv'
    loadDotEnv(p)
    assert(process.env.AIRTABLE_TOKEN === 'fromenv', `got ${process.env.AIRTABLE_TOKEN}`)
  })
})

check('inline comments are stripped', () => {
  withEnvFile('AIRTABLE_TOKEN=patAbc123 # personal token\n', (p) => {
    delete process.env.AIRTABLE_TOKEN
    loadDotEnv(p)
    assert(process.env.AIRTABLE_TOKEN === 'patAbc123', `got ${JSON.stringify(process.env.AIRTABLE_TOKEN)}`)
  })
})

check('a # inside a quoted value survives', () => {
  withEnvFile('NTFY_TOPIC="topic#1"\n', (p) => {
    delete process.env.NTFY_TOPIC
    loadDotEnv(p)
    assert(process.env.NTFY_TOPIC === 'topic#1', `got ${JSON.stringify(process.env.NTFY_TOPIC)}`)
  })
})

check('an export prefix is tolerated', () => {
  withEnvFile('export AIRTABLE_TOKEN=patXyz\n', (p) => {
    delete process.env.AIRTABLE_TOKEN
    loadDotEnv(p)
    assert(process.env.AIRTABLE_TOKEN === 'patXyz', `got ${JSON.stringify(process.env.AIRTABLE_TOKEN)}`)
  })
})

// ------------------------------------------------------------ validation ----

console.log('\nschema validation')

const SYSTEM = [
  {
    key: 'capture_log',
    name: 'Capture Log',
    operations: [],
    fields: ['Recording ID', 'Raw Transcript', 'Recorded At', 'Status', 'Target Table', 'Target Record ID', 'Planner Output', 'Field Snapshot', 'Redo', 'Resolved'].map((name) => ({ name, type: 'multilineText' })),
  },
  {
    key: 'corrections',
    name: 'Corrections',
    operations: [],
    fields: ['Summary', 'Source', 'Field', 'Original Value', 'Corrected Value', 'Raw Transcript', 'Detected At', 'Use As Example'].map((name) => ({ name, type: 'multilineText' })),
  },
]

const base = () => ({
  schemaVersion: 3,
  tables: [{ key: 'a', name: 'A', operations: ['create'], fields: [{ name: 'Title', type: 'singleLineText' }, { name: 'When', type: 'date' }] }, ...structuredClone(SYSTEM)],
})

function errorsFor(mutate) {
  const s = base()
  mutate(s)
  return validateSchema(s)
}

const readJson = (name) => JSON.parse(readFileSync(resolve(ROOT, name), 'utf8'))

check('schema.json is valid (or not made yet)', () => {
  // Yours, and untracked: a fresh copy has none until `npm run setup` makes it.
  if (!existsSync(resolve(ROOT, 'schema.json'))) return
  let schema
  try {
    schema = readJson('schema.json')
  } catch {
    throw new Error('schema.json is not JSON')
  }
  const errs = validateSchema(schema)
  assert(errs.length === 0, `expected none, got:\n      ${errs.join('\n      ')}`)
})

check('every tracker on the menu makes a valid schema, alone and all together', () => {
  const menu = trackerMenu()
  assert(menu.length >= 8, `menu has ${menu.length}`)
  for (const items of [...menu.map((m) => [m]), menu, menu.filter((m) => m.suggested)]) {
    const errs = validateSchema(composeSchema(items))
    assert(errs.length === 0, `${items.map((m) => m.id)}: ${errs.join('; ')}`)
  }
})

check('adding a tracker puts it before the system tables and brings its reminder; removing takes both away', () => {
  const menu = trackerMenu()
  const journal = menu.find((m) => m.id === 'journal')
  const adventures = menu.find((m) => m.id === 'adventures')
  const start = composeSchema([journal])
  const { schema: more, added } = addTrackers(start, [adventures, journal])
  assert(added.join() === 'Adventure Learnings', `added ${added}`)
  assert(more.tables.map((t) => t.key).slice(0, 2).join() === 'journal,adventures', more.tables.map((t) => t.key).join())
  assert(more.reminders.events && more.reminders.onThisDay, 'reminders not merged')
  const { schema: less } = removeTrackers(more, ['adventures', 'capture_log'])
  assert(!less.reminders.events && less.tables.some((t) => t.key === 'capture_log'), 'the reminder stayed, or a system table went')
  assert(validateSchema(less).length === 0, 'removal left it invalid')
})

check('a reminder kind already taken is kept, and the skip is reported', () => {
  const adventures = trackerMenu().find((m) => m.id === 'adventures')
  const mine = composeSchema([])
  mine.reminders = { events: { table: 'Trips', eventField: 'Event' } }
  const { schema, skippedReminders } = addTrackers(mine, [adventures])
  assert(schema.reminders.events.table === 'Trips', 'the existing reminder was replaced')
  assert(skippedReminders.length === 1 && skippedReminders[0].kind === 'events' && skippedReminders[0].keptFor === 'Trips', JSON.stringify(skippedReminders))
})

check('removing a tracker drops a reminder that names it in any case', () => {
  const journal = trackerMenu().find((m) => m.id === 'journal')
  const s = composeSchema([journal])
  s.reminders.onThisDay.table = 'JOURNAL'
  const { schema } = removeTrackers(s, ['journal'])
  assert(!schema.reminders, `left ${JSON.stringify(schema.reminders)}`)
})

check('the menu skips files that are not menu items, and keeps its order', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-menu-'))
  try {
    for (const f of ['base.json', 'journal.json', 'dreams.json']) copyFileSync(resolve(ROOT, 'trackers', f), join(dir, f))
    writeFileSync(join(dir, 'workouts.json'), JSON.stringify({ key: 'workouts', name: 'Workouts', operations: ['create'], fields: [] }))
    writeFileSync(join(dir, 'broken.json'), '{ not json')
    assert(trackerMenu(dir).map((m) => m.id).join() === 'journal,dreams', trackerMenu(dir).map((m) => m.id).join())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('a valid minimal schema produces no errors', () => {
  const errs = validateSchema(base())
  assert(errs.length === 0, `got: ${errs.join('; ')}`)
})

check('a select needs no preset choices', () => {
  const errs = errorsFor((s) => s.tables[0].fields.push({ name: 'Kind', type: 'singleSelect' }))
  assert(errs.length === 0, `got: ${errs.join('; ')}`)
})

check('a field type the app cannot handle is rejected', () => {
  const errs = errorsFor((s) => s.tables[0].fields.push({ name: 'Years Old', type: 'formula' }))
  assert(errs.some((e) => e.includes('unsupported type')), `got: ${errs.join('; ')}`)
})

check('a case-insensitive duplicate field name is rejected', () => {
  const errs = errorsFor((s) => s.tables[0].fields.push({ name: 'title', type: 'multilineText' }))
  assert(errs.some((e) => e.includes('duplicate field name')), `got: ${errs.join('; ')}`)
})

check('a role naming no field is rejected', () => {
  const errs = errorsFor((s) => (s.tables[0].roles = { body: 'Nope' }))
  assert(errs.some((e) => e.includes('role "body"')), `got: ${errs.join('; ')}`)
})

check('an appendTarget naming no field is rejected', () => {
  const errs = errorsFor((s) => (s.tables[0].appendTarget = 'Missing'))
  assert(errs.some((e) => e.includes('appendTarget')), `got: ${errs.join('; ')}`)
})

check('lifecycleFields naming no field is rejected', () => {
  const errs = errorsFor((s) => (s.tables[0].lifecycleFields = ['Nope']))
  assert(errs.some((e) => e.includes('lifecycleFields')), `got: ${errs.join('; ')}`)
})

check('duplicate table keys are rejected', () => {
  const errs = errorsFor((s) => s.tables.push({ key: 'a', name: 'B', operations: [], fields: [{ name: 'X', type: 'singleLineText' }] }))
  assert(errs.some((e) => e.includes('duplicate key')), `got: ${errs.join('; ')}`)
})

check('a schema without the Capture Log is rejected', () => {
  const errs = errorsFor((s) => (s.tables = s.tables.filter((t) => t.key !== 'capture_log')))
  assert(errs.some((e) => e.includes('"capture_log"')), `got: ${errs.join('; ')}`)
})

check('a Capture Log missing a field the Worker writes is rejected', () => {
  const errs = errorsFor((s) => (s.tables[1].fields = s.tables[1].fields.filter((f) => f.name !== 'Field Snapshot')))
  assert(errs.some((e) => e.includes('Field Snapshot')), `got: ${errs.join('; ')}`)
})

check('a reminder naming a field that does not exist is rejected', () => {
  const errs = errorsFor((s) => (s.reminders = { onThisDay: { table: 'a', dateField: 'Dte', years: [1] } }))
  assert(errs.some((e) => e.includes('dateField "Dte"')), `got: ${errs.join('; ')}`)
})

check('a reminder on a real table and field is accepted', () => {
  const errs = errorsFor((s) => (s.reminders = { onThisDay: { table: 'A', dateField: 'When', years: [1] } }))
  assert(errs.length === 0, `got: ${errs.join('; ')}`)
})

// ------------------------------------------------------------- setup ----

console.log('\nsetup')

const mainConfig = readFileSync(resolve(ROOT, 'wrangler.template.jsonc'), 'utf8')
const appConfig = readFileSync(resolve(ROOT, 'wrangler.app.template.jsonc'), 'utf8')

check('the shared templates carry nobody\'s ids', () => {
  for (const [name, text] of [['wrangler.template.jsonc', mainConfig], ['wrangler.app.template.jsonc', appConfig]]) {
    for (const key of ['account_id', 'id', 'database_id', 'APP_URL', 'TIMEZONE', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD']) {
      const m = text.match(new RegExp(`"${key}":\\s*"([^"]*)"`))
      assert(!m || m[1] === '', `${name} has ${key} = "${m?.[1]}"`)
    }
  }
})

check('the configs are written from the templates and .env, and only when .env has the ids', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ps-config-'))
  try {
    for (const { template } of CONFIGS) copyFileSync(resolve(ROOT, template), join(dir, template))
    const none = writeConfigs({ account_id: 'a' }, { root: dir })
    assert(none.missing.join() === 'KV_ID,D1_ID' && !existsSync(join(dir, 'wrangler.jsonc')), `missing ${none.missing}`)
    const values = { account_id: 'acct', kv_state: 'kv', d1_id: 'd1', TIMEZONE: 'UTC', APP_URL: 'https://app', ACCESS_TEAM_DOMAIN: 't', ACCESS_AUD: 'aud' }
    const first = writeConfigs(values, { root: dir })
    assert(first.written.join() === 'wrangler.jsonc,wrangler.app.jsonc', `wrote ${first.written}`)
    const main = readFileSync(join(dir, 'wrangler.jsonc'), 'utf8')
    assert(main.startsWith('// Written by') && main.includes('"id": "kv"') && main.includes('"database_id": "d1"'), 'ids not filled in')
    assert(readFileSync(join(dir, 'wrangler.app.jsonc'), 'utf8').includes('"ACCESS_AUD": "aud"'), 'aud not filled in')
    assert(writeConfigs(values, { root: dir }).written.length === 0, 'a second run rewrote the files')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

check('setEnv fills a blank line, replaces a set one, and adds a missing one', () => {
  withEnvFile('A=\nB=old\n', (p) => {
    setEnv('A', '1', p)
    setEnv('B', '2', p)
    setEnv('C', '3', p)
    const text = readFileSync(p, 'utf8')
    assert(text === 'A=1\nB=2\nC=3\n', `got ${JSON.stringify(text)}`)
  })
})

check("a friend's ids replace the shipped ones, comments and all else untouched", () => {
  const { text, changed, missing } = patchConfig(mainConfig, {
    account_id: 'acct-friend',
    kv_state: 'kv-friend',
    d1_id: 'd1-friend',
    TIMEZONE: 'Europe/Berlin',
    APP_URL: 'https://pocket-scribe-app.friend.workers.dev',
  })
  assert(!missing.length, `missing: ${missing}`)
  assert(changed.length === 5, `changed: ${changed.map((c) => c.key)}`)
  for (const v of ['"account_id": "acct-friend"', '"id": "kv-friend"', '"database_id": "d1-friend"', '"TIMEZONE": "Europe/Berlin"']) assert(text.includes(v), `no ${v}`)
  const strip = (t) => t.replace(/"[^"]*"/g, '""')
  assert(strip(text) === strip(mainConfig), 'something besides the values changed')
})

check('the app config takes its Access application and database', () => {
  const { text, changed, missing } = patchConfig(appConfig, { account_id: 'a', d1_id: 'd', ACCESS_TEAM_DOMAIN: 'friend.cloudflareaccess.com', ACCESS_AUD: 'aud123' })
  assert(!missing.length && changed.length === 4, `changed ${changed.length}, missing ${missing}`)
  assert(text.includes('"ACCESS_AUD": "aud123"'), 'aud not written')
})

check('running it again changes nothing', () => {
  const values = { account_id: 'a', kv_state: 'k', d1_id: 'd', TIMEZONE: 'UTC', APP_URL: 'https://x' }
  const once = patchConfig(mainConfig, values).text
  const twice = patchConfig(once, values)
  assert(twice.changed.length === 0 && twice.text === once, 'second run changed something')
})

check('a value with no place in the config is reported, not skipped', () => {
  const { missing } = patchConfig(mainConfig, { ACCESS_AUD: 'x' })
  assert(missing.includes('ACCESS_AUD'), `missing: ${missing}`)
})

// ---------------------------------------------------------------- report ----

console.log('')
if (failures.length) {
  console.error(`✗ ${failures.length} failed, ${passed} passed\n`)
  process.exit(1)
}
console.log(`✓ ${passed} passed\n`)
