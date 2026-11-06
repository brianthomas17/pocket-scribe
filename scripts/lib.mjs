/**
 * Shared by the scripts: .env loading and schema.json validation.
 *
 * Validation is the only thing between a typo in schema.json and a planner
 * that writes to a field that does not exist, so it checks every place one
 * part of the schema names another.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Load .env into process.env without overriding what the shell already set.
 * The last assignment of a key wins, so a stale duplicate earlier in the file
 * cannot shadow a later correction.
 */
export function loadDotEnv(envPath) {
  const path = envPath || resolve(ROOT, '.env')
  if (!existsSync(path)) return

  const fromEnvironment = new Set(Object.keys(process.env))
  const parsed = new Map()

  for (let line of readFileSync(path, 'utf8').split('\n')) {
    line = line.trim()
    if (!line || line.startsWith('#')) continue
    if (line.startsWith('export ')) line = line.slice(7).trim()

    const m = line.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i)
    if (!m) continue

    let [, key, value] = m
    value = value.trim()

    const quoted = value.match(/^(['"])([\s\S]*)\1$/)
    if (quoted) {
      value = quoted[2]
    } else {
      // Strip an inline comment, but only an unquoted one.
      const hash = value.indexOf(' #')
      if (hash !== -1) value = value.slice(0, hash).trim()
    }

    if (value === '') continue
    parsed.set(key, value)
  }

  for (const [key, value] of parsed) {
    if (!fromEnvironment.has(key)) process.env[key] = value
  }
}

export function loadSchema(path = process.env.SCHEMA_PATH ? resolve(process.cwd(), process.env.SCHEMA_PATH) : resolve(ROOT, 'schema.json')) {
  if (!existsSync(path)) {
    console.error(`\n✗ ${path} not found. Start from the starter:\n\n  cp schema.starter.json schema.json\n`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(path, 'utf8'))
}

/** Field types the app can show and edit, and the planner can write. */
export const FIELD_TYPES = new Set([
  'singleLineText',
  'multilineText',
  'richText',
  'date',
  'dateTime',
  'number',
  'checkbox',
  'singleSelect',
  'multipleSelects',
  'email',
  'url',
  'phoneNumber',
])

/** Tables the Worker itself reads and writes by these names and fields. */
const SYSTEM_TABLES = {
  capture_log: ['Recording ID', 'Raw Transcript', 'Recorded At', 'Status', 'Target Table', 'Target Record ID', 'Planner Output', 'Field Snapshot', 'Redo', 'Resolved'],
  corrections: ['Summary', 'Source', 'Field', 'Original Value', 'Corrected Value', 'Raw Transcript', 'Detected At', 'Use As Example'],
}

export function validateSchema(schema) {
  const errors = []

  if (!Array.isArray(schema.tables) || schema.tables.length === 0) {
    errors.push('schema.tables must be a non-empty array')
    return errors
  }

  const keys = new Set()
  const names = new Set()
  const fieldsOf = new Map()

  for (const table of schema.tables) {
    const where = `table "${table.key || table.name || '?'}"`

    if (!table.key) errors.push(`${where}: missing "key"`)
    else if (keys.has(table.key)) errors.push(`${where}: duplicate key`)
    else keys.add(table.key)

    if (!table.name) errors.push(`${where}: missing "name"`)
    else if (names.has(table.name.toLowerCase())) errors.push(`${where}: duplicate name`)
    else names.add(table.name.toLowerCase())

    if (!Array.isArray(table.operations)) errors.push(`${where}: "operations" must be a list (empty for system tables)`)

    if (!Array.isArray(table.fields) || table.fields.length === 0) {
      errors.push(`${where}: needs at least one field`)
      continue
    }

    const fieldNames = new Set()
    for (const field of table.fields) {
      if (!field.name) errors.push(`${where}: a field is missing "name"`)
      if (!field.type) errors.push(`${where}: field "${field.name}" is missing "type"`)
      else if (!FIELD_TYPES.has(field.type)) errors.push(`${where}: field "${field.name}" has unsupported type "${field.type}"`)
      const lower = (field.name || '').toLowerCase()
      if (fieldNames.has(lower)) errors.push(`${where}: duplicate field name "${field.name}" (names are case-insensitively unique)`)
      fieldNames.add(lower)
    }
    fieldsOf.set(table.key, fieldNames)
    fieldsOf.set(String(table.name).toLowerCase(), fieldNames)

    const named = (label, name) => {
      if (name && !fieldNames.has(String(name).toLowerCase())) errors.push(`${where}: ${label} "${name}" is not a field on this table`)
    }
    named('appendTarget', table.appendTarget)
    named('candidateSort', table.candidateSort)
    for (const name of table.lifecycleFields || []) named('lifecycleFields names', name)
    for (const name of table.resolveBy || []) named('resolveBy names', name)
    for (const name of table.candidateFields || []) named('candidateFields names', name)
    for (const [role, name] of Object.entries(table.roles || {})) named(`role "${role}"`, name)

    const required = SYSTEM_TABLES[table.key]
    for (const name of required || []) named('the Worker needs', name)
  }

  for (const key of Object.keys(SYSTEM_TABLES)) {
    if (!keys.has(key)) errors.push(`schema needs a "${key}" table: the Worker writes to it`)
  }

  const fieldsFor = (ref) => fieldsOf.get(ref) ?? fieldsOf.get(String(ref || '').toLowerCase())
  const ev = schema.reminders?.events
  if (ev) {
    const f = fieldsFor(ev.table)
    if (!f) errors.push(`reminders.events: table "${ev.table}" is not in schema.json`)
    else
      for (const k of ['eventField', 'nameField', 'dateField', 'bodyField', 'optInField']) {
        if (!ev[k]) errors.push(`reminders.events: missing "${k}"`)
        else if (!f.has(String(ev[k]).toLowerCase())) errors.push(`reminders.events: ${k} "${ev[k]}" is not a field on "${ev.table}"`)
      }
    if (!(ev.monthsAfter > 0)) errors.push('reminders.events: "monthsAfter" must be a positive number')
  }
  const otd = schema.reminders?.onThisDay
  if (otd) {
    const f = fieldsFor(otd.table)
    if (!f) errors.push(`reminders.onThisDay: table "${otd.table}" is not in schema.json`)
    else if (!f.has(String(otd.dateField || '').toLowerCase())) errors.push(`reminders.onThisDay: dateField "${otd.dateField}" is not a field on "${otd.table}"`)
    if (!Array.isArray(otd.years) || !otd.years.length) errors.push('reminders.onThisDay: "years" must be a non-empty list')
  }

  return errors
}

/**
 * Set values in a wrangler.jsonc without disturbing its comments or layout.
 *
 * Each key is a pattern for the one place it lives; a key whose pattern is not
 * found is reported rather than silently skipped, so a config edited by hand
 * into a different shape fails loudly instead of deploying stale ids.
 */
const CONFIG_KEYS = {
  account_id: /("account_id":\s*")[^"]*(")/,
  kv_state: /("binding":\s*"STATE",\s*"id":\s*")[^"]*(")/,
  d1_id: /("database_id":\s*")[^"]*(")/,
  TIMEZONE: /("TIMEZONE":\s*")[^"]*(")/,
  APP_URL: /("APP_URL":\s*")[^"]*(")/,
  ACCESS_TEAM_DOMAIN: /("ACCESS_TEAM_DOMAIN":\s*")[^"]*(")/,
  ACCESS_AUD: /("ACCESS_AUD":\s*")[^"]*(")/,
}

export function patchConfig(text, values) {
  const changed = []
  const missing = []
  let out = text
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined || value === null) continue
    const pattern = CONFIG_KEYS[key]
    const m = pattern && out.match(pattern)
    if (!m) {
      missing.push(key)
      continue
    }
    const current = m[0].slice(m[1].length, m[0].length - m[2].length)
    if (current === value) continue
    out = out.replace(pattern, `$1${value}$2`)
    changed.push({ key, from: current, to: value })
  }
  return { text: out, changed, missing }
}

/**
 * Your wrangler configs, made from the shared templates plus the ids in .env.
 *
 * The templates are tracked and the results are not, so an update can change
 * a shared setting (a new binding, a cron) without ever touching your ids, and
 * your ids can never end up in the shared repo.
 */
export const CONFIGS = [
  { template: 'wrangler.template.jsonc', out: 'wrangler.jsonc', keys: ['account_id', 'kv_state', 'd1_id', 'TIMEZONE', 'APP_URL'] },
  { template: 'wrangler.app.template.jsonc', out: 'wrangler.app.jsonc', keys: ['account_id', 'd1_id', 'ACCESS_TEAM_DOMAIN', 'ACCESS_AUD'] },
]

/** Without these a deploy would land nowhere useful; the rest may be blank for now. */
const REQUIRED = { account_id: 'CLOUDFLARE_ACCOUNT_ID', kv_state: 'KV_ID', d1_id: 'D1_ID' }

export function configValues(env = process.env) {
  return {
    account_id: env.CLOUDFLARE_ACCOUNT_ID,
    kv_state: env.KV_ID,
    d1_id: env.D1_ID,
    TIMEZONE: env.TIMEZONE || Intl.DateTimeFormat().resolvedOptions().timeZone,
    APP_URL: env.APP_URL ?? '',
    ACCESS_TEAM_DOMAIN: env.ACCESS_TEAM_DOMAIN ?? '',
    ACCESS_AUD: env.ACCESS_AUD ?? '',
  }
}

const GENERATED = (template) =>
  `// Written by \`npm run config\` from ${template} and your .env. Not tracked by\n// git, and rewritten on every deploy: change the template or .env instead.\n`

/**
 * Write wrangler.jsonc and wrangler.app.jsonc. Returns the .env keys that are
 * missing; nothing is written when any is.
 */
export function writeConfigs(values = configValues(), { root = ROOT, write = true } = {}) {
  const missing = Object.entries(REQUIRED).filter(([k]) => !values[k]).map(([, env]) => env)
  if (missing.length) return { missing, written: [] }
  const written = []
  for (const { template, out, keys } of CONFIGS) {
    const picked = Object.fromEntries(keys.map((k) => [k, values[k] ?? '']))
    const patch = patchConfig(readFileSync(resolve(root, template), 'utf8'), picked)
    if (patch.missing.length) throw new Error(`${template} has no place for ${patch.missing.join(', ')}`)
    const text = GENERATED(template) + patch.text
    const path = resolve(root, out)
    if (existsSync(path) && readFileSync(path, 'utf8') === text) continue
    if (write) writeFileSync(path, text)
    written.push(out)
  }
  return { missing: [], written }
}

/** Set KEY=value in .env, replacing an existing line (blank or not) or adding one. */
export function setEnv(key, value, envPath = resolve(ROOT, '.env')) {
  const text = existsSync(envPath) ? readFileSync(envPath, 'utf8') : ''
  const line = new RegExp(`^${key}=.*$`, 'm')
  const next = line.test(text) ? text.replace(line, `${key}=${value}`) : `${text.replace(/\n?$/, '\n')}${key}=${value}\n`
  if (next !== text) writeFileSync(envPath, next)
  process.env[key] = value
  return next !== text
}
