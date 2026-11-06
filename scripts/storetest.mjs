#!/usr/bin/env node
/**
 * Tests for the Worker's logic: the D1 store against a real (local,
 * in-memory) D1 database, form parsing, to-dos, and reminders.
 *
 *   npm run test:store
 *
 * The TypeScript is bundled with esbuild (already installed with wrangler) and
 * D1 comes from wrangler's local runtime, so this needs no new dependencies
 * and touches no remote database.
 */

import { build } from 'esbuild'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { getPlatformProxy } from 'wrangler'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const work = mkdtempSync(join(tmpdir(), 'pocket-scribe-store-'))

let passed = 0
let failed = 0
async function check(name, fn) {
  try {
    await fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (err) {
    failed++
    console.log(`  ✗ ${name}\n      ${err instanceof Error ? err.message : err}`)
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}
const eq = (a, b, what) => assert(JSON.stringify(a) === JSON.stringify(b), `${what}: expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`)

// ---- bundle the store ----
const entry = join(work, 'entry.ts')
writeFileSync(
  entry,
  `export { d1Store, path, newId } from ${JSON.stringify(join(ROOT, 'src/store/d1.ts'))}\n` +
    `export { readField, esc, html } from ${JSON.stringify(join(ROOT, 'app/html.ts'))}\n` +
    `export { bucketOf, arrange, digest, localNow } from ${JSON.stringify(join(ROOT, 'src/tasks.ts'))}\n` +
    `export { addMonths, yearsBefore, dueEvents, eventMessages, onThisDay, onThisDayMessage, chunk } from ${JSON.stringify(join(ROOT, 'src/reminders.ts'))}\n` +
    `export { eventNameFrom, knownEvents, decide, interpretReply, fieldsFor, checkNewAdventure, handleEventReply, handleEventTap } from ${JSON.stringify(join(ROOT, 'src/events.ts'))}\n` +
    `export { pocketHealth, shouldTranscribeHere } from ${JSON.stringify(join(ROOT, 'src/pocket-health.ts'))}\n` +
    `export { voiceNoteFrom } from ${JSON.stringify(join(ROOT, 'src/voice-note.ts'))}\n` +
    `export { expiredDaily, nightlyBackup, exportAll } from ${JSON.stringify(join(ROOT, 'src/backup.ts'))}\n`
)
// The Worker imports schema.json at build time. The tests swap in a fixed one,
// so they pass on any install, whatever its trackers.
const FIXTURE = join(ROOT, 'scripts/fixtures/schema.test.json')
const fixedSchema = {
  name: 'fixed-schema',
  setup(b) {
    b.onResolve({ filter: /(^|\/)schema\.json$/ }, () => ({ path: FIXTURE }))
  },
}
await build({ entryPoints: [entry], bundle: true, format: 'esm', platform: 'neutral', outfile: join(work, 'store.mjs'), logLevel: 'error', plugins: [fixedSchema], loader: { '.png': 'binary' } })
const { d1Store, newId, readField, esc, html, bucketOf, arrange, digest, localNow, addMonths, yearsBefore, dueEvents, eventMessages, onThisDay, onThisDayMessage, chunk, eventNameFrom, knownEvents, decide, interpretReply, fieldsFor, checkNewAdventure, handleEventReply, handleEventTap, pocketHealth, shouldTranscribeHere, voiceNoteFrom, expiredDaily, nightlyBackup, exportAll } = await import(pathToFileURL(join(work, 'store.mjs')).href)

// ---- a local D1 ----
const config = join(work, 'wrangler.json')
writeFileSync(
  config,
  JSON.stringify({
    name: 'store-test',
    main: 'x.js',
    compatibility_date: '2026-08-12',
    d1_databases: [{ binding: 'DB', database_name: 'store-test', database_id: 'store-test' }],
    kv_namespaces: [{ binding: 'STATE', id: 'store-test-kv' }],
    r2_buckets: [{ binding: 'BACKUPS', bucket_name: 'store-test-backups' }],
  })
)
const proxy = await getPlatformProxy({ configPath: config, persist: { path: join(work, 'state') } })
const db = proxy.env.DB

const migration = readFileSync(join(ROOT, 'migrations/0001_records.sql'), 'utf8')
const statements = migration
  .split('\n')
  .filter((l) => !l.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean)
for (const s of statements) await db.prepare(s).run()

const schema = {
  schemaVersion: 2,
  routing: { ignoreBelowConfidence: 0.4, minConfidenceToWrite: 0.7, allowNewSelectChoices: false },
  tables: [
    {
      key: 'journal',
      name: 'Journal',
      operations: ['create', 'update'],
      roles: { date: 'Date' },
      fields: [
        { name: 'Date', type: 'date' },
        { name: 'Journal', type: 'multilineText' },
        { name: 'Location', type: 'multipleSelects', options: { choices: [{ name: 'Home' }] } },
      ],
    },
    {
      key: 'adventures',
      name: 'Adventure Learnings',
      operations: ['append', 'create'],
      fields: [
        { name: 'Adventure Name', type: 'singleLineText' },
        { name: 'Event', type: 'singleSelect' },
      ],
    },
    {
      key: 'capture_log',
      name: 'Capture Log',
      operations: [],
      fields: [
        { name: 'Recording ID', type: 'singleLineText' },
        { name: 'Recorded At', type: 'dateTime' },
        { name: 'Status', type: 'singleSelect' },
        { name: 'Field Snapshot', type: 'multilineText' },
        { name: 'Swept At', type: 'dateTime' },
        { name: 'Redo', type: 'checkbox' },
      ],
    },
  ],
}
const store = d1Store(db, schema)

console.log('\napp forms')

const fd = (pairs) => {
  const f = new FormData()
  for (const [k, v] of pairs) f.append(k, v)
  return f
}
await check('a field the form did not send is left alone', () => eq(readField({ name: 'Notes', type: 'multilineText' }, fd([])), undefined, 'value'))
await check('an emptied field is cleared', () => eq(readField({ name: 'Notes', type: 'multilineText' }, fd([['f:Notes', '  ']])), null, 'value'))
await check('text keeps its line breaks, loses trailing space', () =>
  eq(readField({ name: 'Notes', type: 'multilineText' }, fd([['f:Notes', 'one\r\n  two  \n']])), 'one\n  two', 'value')
)
await check('an unticked checkbox is false, not left alone', () =>
  eq(readField({ name: 'Done', type: 'checkbox' }, fd([['present:Done', '1']])), false, 'value')
)
await check('multi-select merges ticked and newly typed, without duplicates', () =>
  eq(
    readField({ name: 'Location', type: 'multipleSelects' }, fd([['present:Location', '1'], ['f:Location', 'Reno'], ['new:Location', 'Joshua Tree, Reno , ']])),
    ['Reno', 'Joshua Tree'],
    'value'
  )
)
await check('a multi-select with nothing ticked is cleared', () =>
  eq(readField({ name: 'Location', type: 'multipleSelects' }, fd([['present:Location', '1'], ['new:Location', '']])), null, 'value')
)
await check('a number that is not a number is cleared, not stored as text', () =>
  eq(readField({ name: 'N', type: 'number' }, fd([['f:N', 'abc']])), null, 'value')
)
await check('html escapes what it is given', () => eq(String(html`<p>${'<script>"x"&'}</p>`), '<p>&lt;script&gt;&quot;x&quot;&amp;</p>', 'html'))

console.log('\nto-dos')

const T = (id, title, due, done = false) => ({ id, title, notes: '', due, done })
const today = '2026-10-07'
await check('buckets by due date', () =>
  eq(
    [T('a', 'a', '2026-10-01'), T('b', 'b', today), T('c', 'c', '2026-10-08'), T('d', 'd', '2026-10-14'), T('e', 'e', '2026-10-15'), T('f', 'f', null)].map((x) => bucketOf(x, today)),
    ['overdue', 'today', 'tomorrow', 'week', 'later', 'undated'],
    'buckets'
  )
)
await check('done tasks never land in an open bucket', () => {
  const { open, done } = arrange([T('a', 'a', '2026-10-01', true), T('b', 'b', today)], today)
  eq([...open.values()].flat().map((x) => x.id), ['b'], 'open')
  eq(done.map((x) => x.id), ['a'], 'done')
})
await check('soonest first within a bucket', () => {
  const { open } = arrange([T('a', 'late', '2026-10-05'), T('b', 'later', '2026-10-01')], today)
  eq(open.get('overdue').map((x) => x.id), ['b', 'a'], 'order')
})
await check('no digest when nothing is overdue, today or tomorrow', () =>
  eq(digest([T('a', 'a', '2026-10-20'), T('b', 'b', null), T('c', 'c', '2026-10-01', true)], today), null, 'digest')
)
await check('the digest lists overdue, today and tomorrow, one button each', () => {
  const d = digest([T('a', 'Call insurance', '2026-10-03'), T('b', 'Email Greg', today), T('c', 'Book flights', '2026-10-08'), T('z', 'Later thing', '2026-10-30')], today, 'https://app.example/')
  assert(d.text.includes('Overdue\n• Call insurance (was due Sat, Oct 3)'), d.text)
  assert(d.text.includes('Today\n• Email Greg'), d.text)
  assert(d.text.includes('Tomorrow\n• Book flights'), d.text)
  assert(!d.text.includes('Later thing'), 'later task leaked in')
  assert(d.text.endsWith('https://app.example/todos'), d.text)
  eq(d.buttons.map((b) => b.callback_data), ['task:a', 'task:b', 'task:c'], 'buttons')
  assert(d.buttons.every((b) => new TextEncoder().encode(b.callback_data).length <= 64), 'callback data too long')
})
await check('local day and hour follow the time zone, not UTC', () => {
  const at = new Date('2026-10-08T05:30:00Z') // 10:30pm the day before in Los Angeles
  eq(localNow('America/Los_Angeles', at), { day: '2026-10-07', hour: 22 }, 'LA')
  eq(localNow('UTC', at), { day: '2026-10-08', hour: 5 }, 'UTC')
})

console.log('\nreminders')

await check('months add on the calendar and clamp to the month end', () => {
  eq(addMonths('2025-08-24', 11), '2026-07-24', 'Burning Man 25 + 11')
  eq(addMonths('2025-01-31', 1), '2025-02-28', 'Jan 31 + 1')
  eq(addMonths('2024-03-31', -1), '2024-02-29', 'leap year')
  eq(yearsBefore('2028-02-29', 1), '2027-02-28', 'Feb 29 a year back')
})

const EV = { table: 'Adventure Learnings', eventField: 'Event', nameField: 'Adventure Name', dateField: 'Date', bodyField: 'Learnings', optInField: 'Send Reminder?', optInValues: ['Yes'], monthsAfter: 11 }
const adv = (id, name, event, date, remind, learnings = `learned at ${name}`) => ({ id, fields: { 'Adventure Name': name, Event: event, Date: date, 'Send Reminder?': remind, Learnings: learnings } })
const bm = [adv('a', 'Burning Man 24', 'Burning Man', '2024-08-26', 'Yes'), adv('b', 'Burning Man 25', 'Burning Man', '2025-08-24', 'Yes')]

await check('an event is due 11 months after its newest adventure, with every year newest first', () => {
  const due = dueEvents(EV, bm, '2026-07-24')
  eq(due.map((d) => [d.event, d.mark, d.adventures.map((a) => a.id)]), [['Burning Man', '2026-07-24', ['b', 'a']]], 'due')
})
await check('a missed day or two is still caught; outside the window is not', () => {
  eq(dueEvents(EV, bm, '2026-07-26').length, 1, 'two days late')
  eq(dueEvents(EV, bm, '2026-07-27').length, 0, 'three days late')
  eq(dueEvents(EV, bm, '2026-07-23').length, 0, 'a day early')
})
await check('only the newest adventure decides: opting out drops the event', () =>
  eq(dueEvents(EV, [...bm, adv('c', 'Burning Man 26', 'Burning Man', '2026-09-08', 'Nah')], addMonths('2026-09-08', 11)).length, 0, 'due')
)
await check('event names match despite stray spaces and case', () => {
  const due = dueEvents(EV, [adv('x', 'Shambhala 25', 'Shambhala ', '2025-07-24', 'Yes'), adv('y', 'Shambs 26', 'shambhala', '2026-07-23', 'Yes')], '2027-06-23')
  eq(due.map((d) => d.adventures.length), [2], 'grouped')
})
await check('an event repeats yearly even when last year went unrecorded', () => {
  const wonky = [adv('w', 'Camp Wonky 25', 'Camp Wonky', '2025-06-15', 'Yes')]
  eq(dueEvents(EV, wonky, '2026-05-15').map((d) => d.mark), ['2026-05-15'], 'first year')
  eq(dueEvents(EV, wonky, '2027-05-15').map((d) => d.mark), ['2027-05-15'], 'a year later, nothing new recorded')
  eq(dueEvents(EV, wonky, '2027-05-14').length, 0, 'not the day before')
})
await check('adventures with no event never remind', () => eq(dueEvents(EV, [adv('d', 'Desert Hearts 26', undefined, '2026-10-03', 'Yes')], '2027-09-03').length, 0, 'due'))
await check('the reminder names each year and carries its learnings', () => {
  const [text] = eventMessages(EV, dueEvents(EV, bm, '2026-07-24')[0])
  assert(text.startsWith('Things to remember for Burning Man'), text)
  assert(text.indexOf('Burning Man 25 (Sun, Aug 24, 2025)\nlearned at Burning Man 25') < text.indexOf('Burning Man 24'), text)
})
await check('a long reminder is split into numbered Telegram-sized parts', () => {
  const long = bm.map((a) => ({ ...a, fields: { ...a.fields, Learnings: 'x'.repeat(3000) } }))
  const parts = eventMessages(EV, dueEvents(EV, long, '2026-07-24')[0])
  assert(parts.length >= 2, `parts: ${parts.length}`)
  assert(parts.every((p) => p.length <= 4096), 'a part is over 4096')
  assert(parts[0].startsWith('(1/'), parts[0].slice(0, 20))
  eq(chunk('short'), ['short'], 'short text is one part')
})

const OTD = { table: 'journal', dateField: 'Date', years: [1] }
const J = { key: 'journal', name: 'Journal', operations: ['create'], fields: [{ name: 'Date', type: 'date' }, { name: 'Journal', type: 'multilineText' }, { name: 'Gratitudes', type: 'richText' }, { name: 'Location', type: 'multipleSelects' }, { name: "Today's Man Event", type: 'singleLineText' }] }
await check('on this day finds exactly one year back, and reads like the old email', () => {
  const rows = [
    { id: 'j1', fields: { Date: '2025-10-16', Journal: 'Building art at BSS24.', Gratitudes: 'Reno friends', Location: ['Big Stick Shindig'], "Today's Man Event": 'Building art' } },
    { id: 'j2', fields: { Date: '2025-10-15', Journal: 'not today' } },
    { id: 'j3', fields: { Date: '2024-10-16', Journal: 'two years back' } },
  ]
  const hits = onThisDay(OTD, rows, '2026-10-16')
  eq(hits.map((h) => [h.record.id, h.years]), [['j1', 1]], 'hits')
  eq(onThisDayMessage(J, OTD, 1, hits[0].record), ['This day 1 year ago: Thu, Oct 16, 2025\n\nBig Stick Shindig — Building art\n\nBuilding art at BSS24.\n\nReno friends'], 'message')
})

console.log('\nvoice notes')

{
  const base = { message_id: 7, date: 1762300000, chat: { id: 42 } }
  await check('a voice message is a note, with an id that cannot collide with Pocket', () => {
    const n = voiceNoteFrom({ ...base, voice: { file_id: 'f', duration: 30, file_size: 9000 }, caption: ' journal ' })
    eq([n.id, n.mime, n.seconds, n.caption, n.at], ['tg-42-7', 'audio/ogg', 30, 'journal', '2025-11-04T23:46:40.000Z'], 'note')
  })
  await check('an audio file sent as a document is a note; its unknown length counts as long', () =>
    eq(voiceNoteFrom({ ...base, document: { file_id: 'f', mime_type: 'audio/wav' } }).seconds, Infinity, 'seconds')
  )
  await check('a photo or a PDF is not', () =>
    eq([voiceNoteFrom({ ...base }), voiceNoteFrom({ ...base, document: { file_id: 'f', mime_type: 'application/pdf' } })], [null, null], 'notes')
  )
}

console.log('\npocket health')

{
  const now = Date.parse('2026-10-28T02:00:00Z')
  // Today's real situation: last finished recording Oct 22, one from Oct 27 still pending.
  const list = [
    { id: 'p', state: 'pending', recording_at: '2026-10-27T04:52:59Z' },
    { id: 'a', state: 'completed', recording_at: '2026-10-22T20:44:38Z' },
    { id: 'b', state: 'completed', recording_at: '2026-10-15T17:49:09Z' },
  ]
  await check('a pending recording counts as something reaching Pocket', () => eq(pocketHealth(list, now).silentDays, null, 'silentDays'))
  await check('a recording pending for hours is reported as stuck, not as silence', () => eq(pocketHealth(list, now).stuck.map((s) => s.id), ['p'], 'stuck'))
  await check('a recording that only just arrived is not stuck yet', () =>
    eq(pocketHealth([{ id: 'n', state: 'pending', recording_at: '2026-10-28T00:30:00Z' }, ...list.slice(1)], now).stuck, [], 'stuck')
  )
  await check('three quiet days, with nothing pending, is silence', () => eq(pocketHealth(list.slice(1), now).silentDays, 5, 'silentDays'))
  await check('two quiet days is not worth a message', () => eq(pocketHealth(list.slice(1), Date.parse('2026-10-24T22:00:00Z')).silentDays, null, 'silentDays'))
  await check('no recordings at all is a new account, not a stalled sync', () => eq(pocketHealth([], now), { silentDays: null, stuck: [] }, 'health'))
  await check('a stuck recording over an hour long is flagged as too long to transcribe here', () =>
    eq(pocketHealth([{ ...list[0], duration: 3 * 3600 }], now).stuck[0].tooLong, true, 'tooLong')
  )
  const at = (min) => Date.parse(list[0].recording_at) + min * 60 * 1000
  await check('Pocket gets ten minutes before a recording is transcribed here', () =>
    eq([shouldTranscribeHere({ ...list[0], duration: 6 }, at(5)), shouldTranscribeHere({ ...list[0], duration: 6 }, at(10))], [false, true], 'here')
  )
  await check('a finished recording, or one over an hour, is not transcribed here', () =>
    eq([shouldTranscribeHere(list[1], now), shouldTranscribeHere({ ...list[0], duration: 3 * 3600 }, now)], [false, false], 'here')
  )
}

console.log('\nevent classification')

const EVC = { ...EV, optOutValue: 'Nah' }
const AT = { key: 'adventures', name: 'Adventure Learnings', operations: ['create'], fields: [{ name: 'Adventure Name', type: 'singleLineText' }, { name: 'Event', type: 'singleSelect' }, { name: 'Date', type: 'date' }, { name: 'Send Reminder?', type: 'singleSelect' }, { name: 'Learnings', type: 'richText' }] }
const SC = { tables: [AT], reminders: { events: EVC } }
const live = [
  adv('bs24', 'Big Stick 24', 'Big Stick', '2024-06-11', 'Yes'),
  adv('bs26', 'Big Stick 26', 'Big Stick', '2026-06-10', 'Yes'),
  adv('sh', 'Shambhala 25', 'Shambhala ', '2025-07-24', 'Yes'),
  adv('lv', 'Las Vegas 6/26', 'Las Vegas', '2026-06-26', 'Nah'),
]

await check('the year comes off an adventure name, whatever its shape', () =>
  eq(['Desert Hearts 26', "Burning Man '27", 'Burning Man 2027', 'Las Vegas 6/26', 'Maui Backpacking'].map(eventNameFrom), ['Desert Hearts', 'Burning Man', 'Burning Man', 'Las Vegas', 'Maui Backpacking'], 'names')
)
await check('an adventure under an existing event needs nothing', () =>
  eq(decide(EVC, adv('x', 'Big Stick 27', 'big stick', '2027-06-10'), knownEvents(EVC, live)).action, 'none', 'action')
)
await check('no event, but the name gives it away: filed silently, reminders copied', () => {
  const events = knownEvents(EVC, live)
  const d = decide(EVC, adv('x', 'Big Stick 27', undefined, '2027-06-10'), events)
  eq([d.action, d.event?.name], ['assign', 'Big Stick'], 'decision')
  eq(fieldsFor(EVC, SC, { kind: 'existing', name: 'big stick' }, events), { Event: 'Big Stick', 'Send Reminder?': 'Yes' }, 'fields')
})
await check('an unknown event asks: new first, recent events, then one-off', () => {
  const d = decide(EVC, adv('x', 'Desert Hearts 26', undefined, '2026-10-03'), knownEvents(EVC, live))
  eq(d.action, 'ask', 'action')
  eq(d.options.map((o) => (o.kind === 'oneoff' ? 'oneoff' : `${o.kind}:${o.name}`)), ['new:Desert Hearts', 'existing:Las Vegas', 'existing:Big Stick', 'existing:Shambhala', 'oneoff'], 'options')
})
await check("a new event the planner named is the first choice, as it named it", () => {
  const d = decide(EVC, adv('x', 'DH 26', 'Desert Hearts', '2026-10-03'), knownEvents(EVC, live))
  eq(d.options[0], { kind: 'new', name: 'Desert Hearts' }, 'first option')
})
await check('a typed answer: an existing name picks it, one-off is one, anything else is new', () => {
  const events = knownEvents(EVC, live)
  eq(interpretReply('  shambhala ', events), { kind: 'existing', name: 'Shambhala' }, 'existing')
  eq(interpretReply('one-off', events), { kind: 'oneoff' }, 'one-off')
  eq(interpretReply('Desert Hearts', events), { kind: 'new', name: 'Desert Hearts' }, 'new')
})
await check('new events remind; one-offs do not; an existing event keeps its own setting', () => {
  const events = knownEvents(EVC, live)
  eq(fieldsFor(EVC, SC, { kind: 'new', name: 'Desert Hearts' }, events), { Event: 'Desert Hearts', 'Send Reminder?': 'Yes' }, 'new')
  eq(fieldsFor(EVC, SC, { kind: 'oneoff' }, events), { Event: null, 'Send Reminder?': 'Nah' }, 'one-off')
  eq(fieldsFor(EVC, SC, { kind: 'existing', name: 'Las Vegas' }, events), { Event: 'Las Vegas', 'Send Reminder?': 'Nah' }, 'existing opted out')
})
await check('a checkbox opt-in is ticked or unticked, not given text', () => {
  const cb = { ...EVC, optInField: 'Remind', optInValues: undefined }
  const sc = { tables: [{ ...AT, fields: [...AT.fields, { name: 'Remind', type: 'checkbox' }] }], reminders: { events: cb } }
  eq(fieldsFor(cb, sc, { kind: 'new', name: 'X' }, new Map())['Remind'], true, 'new')
  eq(fieldsFor(cb, sc, { kind: 'oneoff' }, new Map())['Remind'], false, 'one-off')
})

console.log('\nd1 store')

await check('ids look like Airtable ids', () => assert(/^rec[A-Za-z0-9]{14}$/.test(newId()), newId()))

let day1
await check('create drops empty fields and stamps the entry date', async () => {
  day1 = await store.create('Journal', { Date: '2026-10-02', Journal: 'First entry', Location: [], Note: '' })
  eq(day1.fields, { Date: '2026-10-02', Journal: 'First entry' }, 'fields')
  const row = await db.prepare('SELECT entry_date, table_key FROM records WHERE id = ?').bind(day1.id).first()
  eq(row, { entry_date: '2026-10-02', table_key: 'journal' }, 'row')
})

await check('get returns what was created', async () => eq((await store.get('Journal', day1.id)).fields, day1.fields, 'fields'))
await check('tables are found by name or key, any case', async () => eq((await store.get('journal', day1.id)).id, day1.id, 'id'))
await check('get on a missing record throws', async () => {
  let threw = false
  await store.get('Journal', 'recNope').catch(() => (threw = true))
  assert(threw, 'did not throw')
})
await check('get does not cross tables', async () => {
  let threw = false
  await store.get('Capture Log', day1.id).catch(() => (threw = true))
  assert(threw, 'found a journal record through Capture Log')
})
await check('an unknown table throws', async () => {
  let threw = false
  await store.list('Nope').catch(() => (threw = true))
  assert(threw, 'did not throw')
})

await check('sameDay finds the day, not its neighbours', async () => {
  await store.create('Journal', { Date: '2026-10-03', Journal: 'Next day' })
  const hits = await store.list('Journal', { where: [{ field: 'Date', sameDay: '2026-10-02' }] })
  eq(hits.map((h) => h.id), [day1.id], 'ids')
})

await check('sameDay matches a dateTime by its UTC day', async () => {
  const c = await store.create('Capture Log', { 'Recording ID': 'r1', 'Recorded At': '2026-10-02T16:01:50.000Z', Status: 'Written' })
  const hits = await store.list('Capture Log', { where: [{ field: 'Recorded At', sameDay: '2026-10-02' }] })
  eq(hits.map((h) => h.id), [c.id], 'ids')
})

await check('equalsIgnoringCase trims and ignores case', async () => {
  const a = await store.create('Adventure Learnings', { 'Adventure Name': 'Burning Man 26', Event: 'Burning Man' })
  const hits = await store.list('Adventure Learnings', { where: [{ field: 'Adventure Name', equalsIgnoringCase: '  burning MAN 26 ' }], limit: 1 })
  eq(hits.map((h) => h.id), [a.id], 'ids')
})

await check('truthy: a ticked checkbox matches, an unticked or missing one does not', async () => {
  const on = await store.create('Capture Log', { 'Recording ID': 'r2', Redo: true })
  await store.create('Capture Log', { 'Recording ID': 'r3', Redo: false })
  await store.create('Capture Log', { 'Recording ID': 'r4' })
  const hits = await store.list('Capture Log', { where: [{ field: 'Redo', truthy: true }] })
  eq(hits.map((h) => h.id), [on.id], 'ids')
})

await check('the correction-sweep query: Written with a snapshot, never-swept first', async () => {
  const swept = await store.create('Capture Log', { 'Recording ID': 's1', Status: 'Written', 'Field Snapshot': '[1]', 'Swept At': '2026-10-01T00:00:00Z' })
  const never = await store.create('Capture Log', { 'Recording ID': 's2', Status: 'Written', 'Field Snapshot': '[2]' })
  await store.create('Capture Log', { 'Recording ID': 's3', Status: 'Ignored', 'Field Snapshot': '[3]' })
  await store.create('Capture Log', { 'Recording ID': 's4', Status: 'Written' })
  const hits = await store.list('Capture Log', {
    where: [
      { field: 'Status', equals: 'Written' },
      { field: 'Field Snapshot', notBlank: true },
    ],
    sort: 'Swept At',
    direction: 'asc',
    limit: 5,
  })
  eq(hits.map((h) => h.id), [never.id, swept.id], 'ids')
})

await check('sort desc puts the newest first; limit caps it', async () => {
  const hits = await store.list('Journal', { sort: 'Date', limit: 1 })
  eq(hits.map((h) => h.fields.Date), ['2026-10-03'], 'dates')
})

await check('update merges, clears with null, and leaves other fields alone', async () => {
  const r = await store.update('Journal', day1.id, { Journal: 'Edited', Location: ['Home', 'Cabin'] })
  eq(r.fields, { Date: '2026-10-02', Journal: 'Edited', Location: ['Home', 'Cabin'] }, 'after update')
  const cleared = await store.update('Journal', day1.id, { Location: null })
  eq(cleared.fields, { Date: '2026-10-02', Journal: 'Edited' }, 'after clear')
})

await check('every change is recorded in edits, with who made it', async () => {
  await store.update('Journal', day1.id, { Journal: 'By hand' }, 'you')
  const { results } = await db.prepare('SELECT field, before, after, by FROM edits WHERE record_id = ? ORDER BY id').bind(day1.id).all()
  eq(
    results.map((e) => [e.field, e.by]),
    [['(created)', 'system'], ['Journal', 'system'], ['Location', 'system'], ['Location', 'system'], ['Journal', 'you']],
    'edits'
  )
  const last = results.at(-1)
  eq([JSON.parse(last.before), JSON.parse(last.after)], ['Edited', 'By hand'], 'before/after')
})

await check('an update that changes nothing writes nothing', async () => {
  const before = await db.prepare('SELECT COUNT(*) AS n FROM edits').first()
  await store.update('Journal', day1.id, { Journal: 'By hand' })
  const after = await db.prepare('SELECT COUNT(*) AS n FROM edits').first()
  eq(after.n, before.n, 'edit count')
})

await check('moving the date moves the entry date', async () => {
  await store.update('Journal', day1.id, { Date: '2026-09-30' })
  const row = await db.prepare('SELECT entry_date FROM records WHERE id = ?').bind(day1.id).first()
  eq(row.entry_date, '2026-09-30', 'entry_date')
})

await check('concurrent updates to different fields both land', async () => {
  const r = await store.create('Journal', { Date: '2026-10-04', Journal: 'x' })
  await Promise.all([store.update('Journal', r.id, { Journal: 'from A' }), store.update('Journal', r.id, { Location: ['Home'] })])
  eq((await store.get('Journal', r.id)).fields, { Date: '2026-10-04', Journal: 'from A', Location: ['Home'] }, 'fields')
})

await check('field names with quotes and spaces are safe', async () => {
  const r = await store.create('Adventure Learnings', { 'Adventure Name': 'He said "go"' })
  const hits = await store.list('Adventure Learnings', { where: [{ field: 'Adventure Name', equals: 'He said "go"' }] })
  eq(hits.map((h) => h.id), [r.id], 'ids')
})

await check('schema: select choices are the declared ones plus every value in use', async () => {
  const tables = await store.schema()
  const journal = tables.find((t) => t.name === 'Journal')
  const location = journal.fields.find((f) => f.name === 'Location')
  eq(location.options.choices.map((c) => c.name).sort(), ['Home'], 'Location (Cabin was cleared)')
  const event = tables.find((t) => t.name === 'Adventure Learnings').fields.find((f) => f.name === 'Event')
  eq(event.options.choices.map((c) => c.name), ['Burning Man'], 'Event')
  const text = journal.fields.find((f) => f.name === 'Journal')
  assert(!text.options, 'a text field has no choices')
})

console.log('\nevent questions, end to end (local D1 + KV, Telegram stubbed)')

{
  const real = JSON.parse(readFileSync(FIXTURE, 'utf8'))
  const sent = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://api.telegram.org')) return realFetch(url, init)
    sent.push({ method: String(url).split('/').pop(), body: JSON.parse(init.body) })
    return new Response(JSON.stringify({ ok: true, result: { message_id: 4200 + sent.length } }))
  }
  const env = { DB: db, STATE: proxy.env.STATE, TELEGRAM_BOT_TOKEN: 't', TELEGRAM_CHAT_ID: '1' }
  const s = d1Store(db, real)
  await s.create('Adventure Learnings', { 'Adventure Name': 'Big Stick 26', Event: 'Big Stick', Date: '2026-06-10', 'Send Reminder?': 'Yes' })

  await check('a new adventure with an obvious event is filed without asking', async () => {
    const r = await s.create('Adventure Learnings', { 'Adventure Name': 'Big Stick 27', Date: '2027-06-10', Learnings: 'x' })
    await checkNewAdventure(env, real, r.id)
    eq(sent.length, 0, 'messages sent')
    const after = await s.get('Adventure Learnings', r.id)
    eq([after.fields.Event, after.fields['Send Reminder?']], ['Big Stick', 'Yes'], 'fields')
  })

  let dh
  await check('an unknown one is asked about, with a button per choice', async () => {
    dh = await s.create('Adventure Learnings', { 'Adventure Name': 'Desert Hearts 26', Date: '2026-10-03', Learnings: 'x' })
    await checkNewAdventure(env, real, dh.id)
    eq(sent.map((m) => m.method), ['sendMessage'], 'calls')
    eq(sent[0].body.reply_markup.inline_keyboard.map((row) => row[0].text), ['🆕 New event: Desert Hearts', 'Big Stick', 'Burning Man', 'One-off (no event)'], 'buttons') // Burning Man: made by the store tests above
  })

  await check('typing the answer creates the event and turns its reminder on', async () => {
    eq(await handleEventReply(env, real, 'Desert Hearts'), true, 'handled')
    const after = await s.get('Adventure Learnings', dh.id)
    eq([after.fields.Event, after.fields['Send Reminder?']], ['Desert Hearts', 'Yes'], 'fields')
    assert(sent.at(-1).body.text.includes('new event “Desert Hearts”'), sent.at(-1).body.text)
  })

  await check('once answered, the next message is not taken as an answer', async () => {
    eq(await handleEventReply(env, real, 'hello'), false, 'handled')
  })

  await check('a tap on One-off marks it and clears the buttons', async () => {
    sent.length = 0
    const trip = await s.create('Adventure Learnings', { 'Adventure Name': 'Maui 27', Date: '2027-01-05', Learnings: 'x' })
    await checkNewAdventure(env, real, trip.id)
    const keyboard = sent[0].body.reply_markup.inline_keyboard
    const oneoff = keyboard.find((row) => row[0].text.startsWith('One-off'))[0]
    await handleEventTap(env, real, { id: 'cb', data: oneoff.callback_data, message: { message_id: 4201, chat: { id: 1 }, reply_markup: { inline_keyboard: keyboard } } })
    const after = await s.get('Adventure Learnings', trip.id)
    eq([after.fields.Event, after.fields['Send Reminder?']], [undefined, 'Nah'], 'fields')
    const edit = sent.find((m) => m.method === 'editMessageReplyMarkup')
    eq(edit.body.reply_markup.inline_keyboard, [], 'buttons left')
  })

  await check('a reply to some other message is left for the capture flow', async () => {
    eq(await handleEventReply(env, real, 'journal', 999), false, 'handled')
  })
  globalThis.fetch = realFetch
}

console.log('\nbackups (local D1 + R2)')

await check('nightly copies older than 30 days are the only ones deleted', () =>
  eq(expiredDaily(['daily/2026-09-27.json.gz', 'daily/2026-09-28.json.gz', 'daily/2026-10-27.json.gz', 'monthly/2026-09.json.gz', 'other.txt'], '2026-10-28'), ['daily/2026-09-27.json.gz'], 'expired')
)
{
  const bucket = proxy.env.BACKUPS
  const env = { DB: db, BACKUPS: bucket }
  await check('the first night writes that night and the month', async () => {
    const r = await nightlyBackup(env, '2026-10-28')
    eq([r.key, r.monthly, r.deleted], ['daily/2026-10-28.json.gz', true, 0], 'result')
    assert(await bucket.head('monthly/2026-10.json.gz'), 'no monthly copy')
  })
  await check('a later night in the same month leaves the month copy alone', async () => {
    eq((await nightlyBackup(env, '2026-10-29')).monthly, false, 'monthly written again')
  })
  await check('the copy is the whole database, readable without this code', async () => {
    const obj = await bucket.get('daily/2026-10-29.json.gz')
    const text = await new Response(obj.body.pipeThrough(new DecompressionStream('gzip'))).text()
    const b = JSON.parse(text)
    const [{ n }] = (await db.prepare('SELECT COUNT(*) AS n FROM records').all()).results
    eq([b.format, b.records.length], [1, n], 'format and record count')
    assert(b.edits.length > 0 && b.edits[0].id !== undefined, 'edits carry their ids')
    assert(Array.isArray(b.schema?.tables) && b.schema.tables.length > 0, 'the trackers (schema.json) are in it')
  })
  await check('a month later, the old nightly copies are gone and the month copies stay', async () => {
    for (let d = 1; d <= 31; d++) await bucket.put(`daily/2026-09-${String(d).padStart(2, '0')}.json.gz`, 'x')
    const r = await nightlyBackup(env, '2026-10-30')
    const left = (await bucket.list({ prefix: 'daily/' })).objects.map((o) => o.key)
    assert(!left.some((k) => k < 'daily/2026-09-30'), `kept old: ${left.filter((k) => k < 'daily/2026-09-30')}`)
    assert(left.includes('daily/2026-10-30.json.gz') && left.includes('daily/2026-09-30.json.gz'), 'deleted too much')
    eq(r.deleted, 29, 'deleted')
    assert(await bucket.head('monthly/2026-10.json.gz'), 'month copy gone')
  })
}

await proxy.dispose()
rmSync(work, { recursive: true, force: true })

console.log(`\n${failed ? '✗' : '✓'} ${passed} passed${failed ? `, ${failed} failed` : ''}`)
process.exit(failed ? 1 : 0)
