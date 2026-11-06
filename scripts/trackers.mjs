#!/usr/bin/env node
/**
 * Choose your trackers from the menu in trackers/.
 *
 *   npm run trackers                          the menu, and which you have
 *   npm run trackers -- start journal todos   a new schema.json with just these
 *   npm run trackers -- start --suggested     …with the suggested ones
 *   npm run trackers -- add people dreams     add to your schema.json
 *   npm run trackers -- remove dreams         take one out
 *
 * The menu is a starting point, not a limit: edit any tracker in schema.json
 * afterwards, or describe one you want to your AI and have it written there
 * (SETUP.md, "Editing the schema"). Deploy afterwards to use the change.
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { addTrackers, composeSchema, removeTrackers, trackerMenu, validateSchema, ROOT } from './lib.mjs'

const SCHEMA = resolve(ROOT, 'schema.json')
const [command = 'list', ...args] = process.argv.slice(2)
const menu = trackerMenu()

function fail(message) {
  console.error(`\n✗ ${message}\n`)
  process.exit(1)
}

let current = null
if (existsSync(SCHEMA)) {
  try {
    current = JSON.parse(readFileSync(SCHEMA, 'utf8'))
  } catch (err) {
    fail(`schema.json is not valid JSON, so nothing was changed: ${err.message}\n  Fix it by hand (or ask your AI), then run this again.`)
  }
}
const has = (item) => current?.tables?.some((t) => t.key === item.table.key)

function pick(ids, { suggested = false } = {}) {
  if (suggested && args.includes('--suggested')) return menu.filter((m) => m.suggested)
  if (args.includes('--suggested')) fail('--suggested only goes with `start`. Name the trackers instead.')
  const unknown = ids.filter((id) => !menu.some((m) => m.id === id))
  if (unknown.length) fail(`No tracker called ${unknown.join(', ')}. The menu: ${menu.map((m) => m.id).join(', ')}`)
  if (!ids.length) fail(`Name at least one: ${menu.map((m) => m.id).join(', ')}`)
  return ids.map((id) => menu.find((m) => m.id === id))
}

function save(schema, said) {
  const errors = validateSchema(schema)
  if (errors.length) fail(`That would make schema.json invalid:\n  · ${errors.join('\n  · ')}`)
  writeFileSync(SCHEMA, JSON.stringify(schema, null, 2) + '\n')
  console.log(`✓ ${said}`)
  console.log('  Deploy to use it: npm run deploy && npm run deploy:app')
}

const ids = args.filter((a) => !a.startsWith('--'))

if (command === 'list') {
  console.log('\nThe tracker menu (✓ = in your schema.json, * = suggested to start with):\n')
  for (const m of menu) {
    console.log(`  ${has(m) ? '✓' : ' '} ${m.id.padEnd(16)}${m.suggested ? '*' : ' '} ${m.table.name}: ${m.about}`)
  }
  const own = current?.tables.filter((t) => t.operations?.length && !menu.some((m) => m.table.key === t.key)) ?? []
  if (own.length) console.log(`\n  Your own: ${own.map((t) => t.name).join(', ')}`)
  if (!current) console.log('\nNo schema.json yet. Start one: npm run trackers -- start --suggested (or name the ones you want)')
  console.log('\nWant something not on the menu? Describe it to your AI; SETUP.md, "Editing the schema", has the rules.\n')
} else if (command === 'start') {
  if (current && !args.includes('--force')) {
    fail('schema.json already exists. Use `add` and `remove` to change it, or add --force to replace it (entries already filed stay in the database).')
  }
  const items = pick(ids, { suggested: true })
  if (current) {
    // schema.json is not tracked by git, so this copy is the only way back.
    const copy = resolve(ROOT, `schema.backup-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
    copyFileSync(SCHEMA, copy)
    console.log(`· your previous schema.json is saved as ${copy.slice(ROOT.length + 1)}`)
  }
  save(composeSchema(items), `schema.json started with ${items.map((m) => m.table.name).join(', ')}`)
} else if (command === 'add') {
  if (!current) fail('No schema.json yet. Use `start` first.')
  const { schema, added, skippedReminders } = addTrackers(current, pick(ids))
  if (!added.length) {
    console.log('Already there; nothing changed.')
    process.exit(0)
  }
  save(schema, `added ${added.join(', ')}`)
  for (const s of skippedReminders) {
    console.log(`! ${s.tracker}'s "${s.kind}" reminder was not added: yours already goes to ${s.keptFor}, and there is one of each. Point reminders.${s.kind} at ${s.tracker} in schema.json to switch.`)
  }
} else if (command === 'remove') {
  if (!current) fail('No schema.json yet.')
  const keys = pick(ids).map((m) => m.table.key)
  const { schema, removed } = removeTrackers(current, keys)
  if (!removed.length) {
    console.log("None of those are in your schema.json; nothing changed.")
    process.exit(0)
  }
  save(schema, `removed ${removed.join(', ')}. Anything already filed there stays in the database, and shows again if you add it back.`)
} else {
  fail(`Unknown command "${command}". Try: npm run trackers`)
}
