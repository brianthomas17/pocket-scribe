/**
 * The Pocket Scribe app: read, type and fix entries.
 *
 *   GET  /                      Today (or ?day=YYYY-MM-DD)
 *   GET  /tables                every table, with counts
 *   GET  /t/:key                one table, newest first, with search
 *   GET  /new                   pick a table to add to
 *   GET  /t/:key/new            a blank form       POST /t/:key       create
 *   GET  /t/:key/:id            read and edit       POST /t/:key/:id   save
 *   GET  /review                captures waiting on you
 *   POST /review/:id            file one in a table, or ignore it
 *
 * Its own Worker, behind Cloudflare Access, reading and writing D1 only. It is
 * separate from the capture Worker because Access protects a whole Worker, and
 * the capture Worker's webhooks have to stay reachable.
 */

import { authenticate } from './auth'
import { backupFilename, exportAll, gzipped } from '../src/backup'
import { homeScreenAsset } from './home-screen'
import { browse, captureFor, count, history, onDay, reviewCount, reviewQueue, sameDayEarlierYears, PAGE } from './queries'
import {
  choicesFor,
  html,
  input,
  isDay,
  isEditable,
  localDay,
  page,
  prettyDay,
  prettyTime,
  readField,
  shiftDay,
  show,
  snippet,
  summarize,
  titleOf,
  type Html,
} from './html'
import { d1Store } from '../src/store/d1'
import type { Store, StoreRecord } from '../src/store'
import type { Schema, SchemaTable } from '../src/planner'
import { resolveCapture } from '../src/capture'
import { recordFieldCorrection, type SnapshotEntry } from '../src/corrections'
import { allTasks, arrange, BUCKETS, setDone, taskTable, type Task } from '../src/tasks'
import rawSchema from '../schema.json'

const schema = rawSchema as unknown as Schema
const tasks = taskTable(schema)
const content = schema.tables.filter((t) => t.operations.length > 0)
const system = schema.tables.filter((t) => t.operations.length === 0)
const byKey = new Map(schema.tables.map((t) => [t.key, t]))

interface Ctx {
  env: Env
  db: D1Database
  store: Store
  tz: string
  url: URL
  reviewCount: number
}

const redirect = (to: string) => new Response(null, { status: 303, headers: { location: to } })
const notFound = (ctx: Ctx, what = 'Not found') =>
  page({ title: what, active: '', reviewCount: ctx.reviewCount, status: 404, body: html`<h1>${what}</h1><p><a href="/">Back to today</a></p>` })

const t0 = (t: SchemaTable) => dateFieldOf(t) ?? t.fields[0].name

function dateFieldOf(t: SchemaTable): string | undefined {
  return t.roles?.date ?? t.fields.find((f) => f.type === 'date' || f.type === 'dateTime')?.name
}

function card(t: SchemaTable, r: StoreRecord, ctx: Ctx, opts: { showDate?: boolean; full?: boolean } = {}): Html {
  const { title, text } = summarize(t, r.fields)
  const dateField = dateFieldOf(t)
  // A date-titled record already says its date; others show it on the right.
  const side =
    t.key === 'capture_log' && r.fields['Recorded At']
      ? prettyTime(String(r.fields['Recorded At']), ctx.tz)
      : opts.showDate && dateField && t.fields[0]?.name !== dateField
        ? show(t.fields.find((f) => f.name === dateField), r.fields[dateField], ctx.tz)
        : ''
  const status = t.key === 'capture_log' && r.fields.Status ? html`<span class="status ${String(r.fields.Status).split(' ')[0]}">${r.fields.Status}</span> ` : html``
  const body = text ? snippet(text, opts.full ? 1200 : 240) : ''
  return html`<a class="card" href="/t/${t.key}/${r.id}"><div class="spread"><span class="t">${status}${snippet(title, t.key === 'capture_log' ? 140 : 90)}</span><span class="s">${side}</span></div>${body ? html`<div class="body">${body}</div>` : html``}</a>`
}

// ---------------------------------------------------------------- today ----

async function today(ctx: Ctx): Promise<Response> {
  const asked = ctx.url.searchParams.get('day')
  const day = isDay(asked) ? asked : localDay(ctx.tz)
  const isToday = day === localDay(ctx.tz)
  const keys = [...content.map((t) => t.key), 'capture_log']
  const rows = await onDay(ctx.db, keys, day)

  const sections = content.map((t) => {
    const list = rows.get(t.key) ?? []
    return html`<div class="head"><h2>${t.name}</h2><a href="/t/${t.key}/new?day=${day}">+ Add</a></div>${
      list.length ? list.map((r) => card(t, r, ctx, { full: true })) : html`<p class="empty">Nothing ${isToday ? 'yet' : 'this day'}.</p>`
    }`
  })
  const caps = rows.get('capture_log') ?? []
  const capTable = byKey.get('capture_log')
  const captures = capTable && caps.length ? html`<h2>Recordings</h2>${caps.map((r) => card(capTable, r, ctx))}` : html``

  // On this day: the table the on-this-day reminder uses, else the first
  // table named by its date (Journal).
  const otdKey = schema.reminders?.onThisDay?.table
  const otdTable = (otdKey && schema.tables.find((t) => t.key === otdKey || t.name === otdKey)) || content.find((t) => t.fields[0]?.type === 'date')
  const earlier = otdTable ? await sameDayEarlierYears(ctx.db, otdTable.key, day) : []
  const yearsAgo = (r: StoreRecord) => Number(day.slice(0, 4)) - Number(String(r.fields[t0(otdTable!)] ?? day).slice(0, 4))
  const onThisDaySection =
    otdTable && earlier.length
      ? html`<h2>On this day</h2>${earlier.map(
          (r) => html`<p class="sub" style="margin:12px 0 0">${yearsAgo(r)} year${yearsAgo(r) === 1 ? '' : 's'} ago</p>${card(otdTable, r, ctx, { full: true })}`
        )}`
      : html``

  return page({
    title: isToday ? 'Today' : prettyDay(day),
    active: isToday ? 'today' : '',
    reviewCount: ctx.reviewCount,
    body: html`<div class="spread"><a class="btn" href="/?day=${shiftDay(day, -1)}">←</a>
<form method="get" action="/" class="row"><input type="date" name="day" value="${day}" onchange="this.form.submit()" style="width:auto"></form>
<a class="btn" href="/?day=${shiftDay(day, 1)}">→</a></div>
<h1>${isToday ? 'Today' : ''} ${prettyDay(day)}</h1>${sections}${onThisDaySection}${captures}`,
  })
}

// --------------------------------------------------------------- tables ----

async function tables(ctx: Ctx): Promise<Response> {
  const counts = await Promise.all(schema.tables.map((t) => count(ctx.db, t.key)))
  const row = (t: SchemaTable) =>
    html`<a class="card" href="/t/${t.key}"><div class="spread"><span class="t">${t.name}</span><span class="s">${counts[schema.tables.indexOf(t)]}</span></div></a>`
  return page({
    title: 'Tables',
    active: 'tables',
    reviewCount: ctx.reviewCount,
    body: html`<h1>Tables</h1>${content.map(row)}<h2>System</h2>${system.map(row)}
<h2>Backup</h2><a class="card" href="/backup" download><span class="t">Download a backup</span><div class="s">Every entry and its whole edit history, as one file. Keep a copy somewhere that isn't Cloudflare.</div></a>`,
  })
}

/** Every record and edit, streamed as one gzipped file to save anywhere. */
async function download(ctx: Ctx): Promise<Response> {
  const body = gzipped(await exportAll(ctx.db))
  return new Response(body, {
    headers: {
      'content-type': 'application/gzip',
      'content-disposition': `attachment; filename="${backupFilename(localDay(ctx.tz))}"`,
      'cache-control': 'no-store',
    },
  })
}

async function list(ctx: Ctx, t: SchemaTable): Promise<Response> {
  const q = ctx.url.searchParams.get('q') ?? ''
  const pg = Math.max(0, Number(ctx.url.searchParams.get('page') ?? 0) || 0)
  const { records, more } = await browse(ctx.db, t.key, { q, page: pg })
  const link = (p: number) => `/t/${t.key}?${new URLSearchParams({ ...(q ? { q } : {}), page: String(p) })}`
  return page({
    title: t.name,
    active: 'tables',
    reviewCount: ctx.reviewCount,
    body: html`<div class="spread"><h1>${t.name}</h1>${t.operations.length ? html`<a class="btn primary" href="/t/${t.key}/new">+ New</a>` : html``}</div>
<form class="search" method="get"><input name="q" value="${q}" placeholder="Search ${t.name}" type="search"><button>Search</button></form>
${records.length ? records.map((r) => card(t, r, ctx, { showDate: true })) : html`<p class="empty">${q ? `Nothing matches “${q}”.` : 'Nothing here yet.'}</p>`}
<div class="pager">${pg > 0 ? html`<a href="${link(pg - 1)}">← Newer</a>` : html`<span></span>`}${more ? html`<a href="${link(pg + 1)}">Older →</a>` : html`<span></span>`}</div>
${records.length ? html`<p class="sub">Showing ${pg * PAGE + 1}–${pg * PAGE + records.length}</p>` : html``}`,
  })
}

// ---------------------------------------------------------------- entry ----

async function choiceMap(ctx: Ctx): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>()
  for (const t of await ctx.store.schema()) {
    const key = schema.tables.find((s) => s.name === t.name)?.key ?? t.id
    for (const f of t.fields) if (f.options?.choices) out.set(`${key}.${f.name}`, f.options.choices.map((c) => c.name))
  }
  return out
}

function form(t: SchemaTable, fields: Record<string, unknown>, choices: Map<string, string[]>, action: string, submit: string): Html {
  const editable = t.fields.filter(isEditable)
  return html`<form method="post" action="${action}">${editable.map((f) => input(f, fields[f.name], choicesFor(f, choices, t.key)))}
<div class="save-bar"><button class="primary" type="submit">${submit}</button><a class="btn" href="/t/${t.key}">Cancel</a></div></form>`
}

async function newForm(ctx: Ctx, t: SchemaTable): Promise<Response> {
  const asked = ctx.url.searchParams.get('day')
  const dateField = dateFieldOf(t)
  const prefill: Record<string, unknown> = {}
  if (dateField && t.fields.find((f) => f.name === dateField)?.type === 'date') prefill[dateField] = isDay(asked) ? asked : localDay(ctx.tz)
  return page({
    title: `New ${t.name}`,
    active: 'new',
    reviewCount: ctx.reviewCount,
    body: html`<h1>New in ${t.name}</h1>${form(t, prefill, await choiceMap(ctx), `/t/${t.key}`, 'Save')}`,
  })
}

function readForm(t: SchemaTable, data: FormData): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of t.fields.filter(isEditable)) {
    const v = readField(f, data)
    if (v !== undefined) out[f.name] = v
  }
  return out
}

async function create(ctx: Ctx, t: SchemaTable, data: FormData): Promise<Response> {
  const fields = readForm(t, data)
  if (!Object.values(fields).some((v) => v !== null && v !== false)) return redirect(`/t/${t.key}/new`)
  const r = await ctx.store.create(t.name, fields, 'you')
  return redirect(`/t/${t.key}/${r.id}?saved=created`)
}

async function entry(ctx: Ctx, t: SchemaTable, id: string): Promise<Response> {
  let r: StoreRecord
  try {
    r = await ctx.store.get(t.name, id)
  } catch {
    return notFound(ctx, `No such ${t.name} entry`)
  }
  const [choices, edits, capture] = await Promise.all([choiceMap(ctx), history(ctx.db, id), t.key === 'capture_log' ? null : captureFor(ctx.db, id)])
  const known = new Set(t.fields.filter(isEditable).map((f) => f.name))
  // readOnlyFields are values imported from an old system's formulas (Years
  // Old). They no longer update, so showing them would only mislead.
  const stale = new Set(t.readOnlyFields ?? [])
  const extra = Object.entries(r.fields).filter(([k]) => !known.has(k) && !stale.has(k))
  const saved = ctx.url.searchParams.get('saved')

  const transcript = capture?.fields['Raw Transcript']
    ? html`<details open><summary>From a recording · <a href="/t/capture_log/${capture.id}">${capture.fields['Recorded At'] ? prettyTime(String(capture.fields['Recorded At']), ctx.tz) : 'open'}</a></summary><blockquote>${capture.fields['Raw Transcript']}</blockquote></details>`
    : html``

  const others = extra.length
    ? html`<details><summary>Other fields (${extra.length})</summary>${extra.map(
        ([k, v]) => html`<div class="field"><label>${k}</label><div>${typeof v === 'string' && v.length > 200 ? html`<blockquote>${v}</blockquote>` : show(undefined, v, ctx.tz)}</div></div>`
      )}</details>`
    : html``

  const fmt = (v: unknown) => (v === null || v === undefined ? '—' : snippet(typeof v === 'string' ? v : JSON.stringify(v), 120))
  const hist = edits.length
    ? html`<details><summary>History (${edits.length})</summary><table class="hist">${edits.map(
        (e) => html`<tr><td>${prettyTime(e.at, ctx.tz)}<br><span class="sub">${e.by}</span></td><td><b>${e.field}</b><br>${e.field === '(created)' ? '' : html`${fmt(e.before)} → ${fmt(e.after)}`}</td></tr>`
      )}</table></details>`
    : html``

  return page({
    title: titleOf(t, r.fields),
    active: 'tables',
    reviewCount: ctx.reviewCount,
    body: html`<p class="sub"><a href="/t/${t.key}">${t.name}</a></p>
${saved ? html`<div class="saved">${saved === 'created' ? 'Added.' : 'Saved.'}</div>` : html``}
${transcript}${form(t, r.fields, choices, `/t/${t.key}/${id}`, 'Save changes')}${others}${hist}`,
  })
}

/**
 * Save an edit, and if it changes something the planner wrote, record that as
 * a correction now — the app knows exactly what changed, so nothing has to
 * diff for it later. The capture's Field Snapshot says what the planner wrote;
 * it is re-baselined so each lesson is learned once.
 */
async function save(ctx: Ctx, t: SchemaTable, id: string, data: FormData): Promise<Response> {
  const before = await ctx.store.get(t.name, id)
  const after = await ctx.store.update(t.name, id, readForm(t, data), 'you')

  if (t.key !== 'capture_log') {
    const capture = await captureFor(ctx.db, id)
    if (capture) {
      try {
        const snapshot = JSON.parse(String(capture.fields['Field Snapshot'] ?? '[]')) as SnapshotEntry[]
        const written = snapshot.find((e) => e.recordId === id)
        const lifecycle = new Set((t.lifecycleFields ?? []).map((f) => f.toLowerCase()))
        const norm = (v: unknown) => (typeof v === 'string' ? v.trim() : JSON.stringify(v ?? ''))
        let changed = false
        for (const field of Object.keys(written?.fields ?? {})) {
          if (lifecycle.has(field.toLowerCase())) continue
          if (norm(before.fields[field]) === norm(after.fields[field])) continue
          if (norm(written!.fields[field]) === norm(after.fields[field])) continue
          const ok = await recordFieldCorrection(ctx.env, {
            table: t.name,
            recordId: id,
            field,
            from: written!.fields[field],
            to: after.fields[field],
            transcript: String(capture.fields['Raw Transcript'] ?? ''),
          })
          if (ok) {
            written!.fields[field] = after.fields[field]
            changed = true
          }
        }
        if (changed) await ctx.store.update('Capture Log', capture.id, { 'Field Snapshot': JSON.stringify(snapshot, null, 2) })
      } catch (err) {
        console.log(JSON.stringify({ event: 'app.correction_failed', message: String(err) }))
      }
    }
  }
  return redirect(`/t/${t.key}/${id}?saved=1`)
}

// ----------------------------------------------------------------- to-dos ----

async function todos(ctx: Ctx, t: SchemaTable): Promise<Response> {
  const day = localDay(ctx.tz)
  const { open, done } = arrange(await allTasks(ctx.store, t), day)
  const row = (task: Task, overdue = false) => html`<div class="task${task.done ? ' done' : ''}">
<form method="post" action="/todos/${task.id}/done"><input type="hidden" name="done" value="${task.done ? '0' : '1'}"><button class="tick" title="${task.done ? 'Mark not done' : 'Mark done'}">${task.done ? '✓' : ''}</button></form>
<a href="/t/${t.key}/${task.id}"><span class="t">${task.title}</span>${task.due ? html`<span class="due${overdue ? ' late' : ''}">${prettyDay(task.due)}</span>` : html``}${task.notes ? html`<span class="s">${snippet(task.notes, 120)}</span>` : html``}</a></div>`

  const sections = BUCKETS.filter((b) => open.get(b.key)!.length).map(
    (b) => html`<h2>${b.label} <span class="sub">${open.get(b.key)!.length}</span></h2>${open.get(b.key)!.map((x) => row(x, b.key === 'overdue'))}`
  )
  const openCount = [...open.values()].reduce((n, l) => n + l.length, 0)
  return page({
    title: 'To-dos',
    active: 'todos',
    reviewCount: ctx.reviewCount,
    body: html`<h1>To-dos</h1>
<form method="post" action="/todos" class="quick"><input name="title" placeholder="Add a to-do" autocomplete="off" required><input type="date" name="due" aria-label="Due date"><button class="primary">Add</button></form>
${openCount ? sections : html`<p class="empty">Nothing to do. Nice.</p>`}
${done.length ? html`<details><summary>Done (${done.length})</summary>${done.slice(0, 50).map((x) => row(x))}</details>` : html``}`,
  })
}

async function addTodo(ctx: Ctx, t: SchemaTable, data: FormData): Promise<Response> {
  const title = String(data.get('title') ?? '').trim()
  const due = String(data.get('due') ?? '').trim()
  if (title) {
    await ctx.store.create(t.name, { [t.roles!.title ?? t.fields[0].name]: title, ...(isDay(due) ? { [t.roles!.due]: due } : {}) }, 'you')
  }
  return redirect('/todos')
}

async function toggleTodo(ctx: Ctx, t: SchemaTable, id: string, data: FormData): Promise<Response> {
  await setDone(ctx.store, t, id, data.get('done') === '1')
  return redirect('/todos')
}

// ------------------------------------------------------------------- new ----

function chooser(ctx: Ctx): Response {
  return page({
    title: 'New',
    active: 'new',
    reviewCount: ctx.reviewCount,
    body: html`<h1>Add something</h1>${content.map((t) => html`<a class="card" href="/t/${t.key}/new"><span class="t">${t.name}</span></a>`)}`,
  })
}

// ---------------------------------------------------------------- review ----

async function review(ctx: Ctx): Promise<Response> {
  const queue = await reviewQueue(ctx.db)
  const done = ctx.url.searchParams.get('done')
  const items = queue.map((r) => {
    const f = r.fields
    const reason = [f.Reason, f.Confidence !== undefined ? `confidence ${f.Confidence}` : ''].filter(Boolean).join(' · ')
    return html`<div class="card"><div class="spread"><span class="t"><span class="status ${String(f.Status).split(' ')[0]}">${f.Status}</span></span><span class="s">${f['Recorded At'] ? prettyTime(String(f['Recorded At']), ctx.tz) : ''}</span></div>
${reason ? html`<div class="s">${reason}</div>` : html``}
<blockquote>${snippet(String(f['Raw Transcript'] ?? ''), 600)}</blockquote>
<form method="post" action="/review/${r.id}" class="row">${content.map((t) => html`<button name="table" value="${t.key}">${t.name}</button>`)}<button name="table" value="" class="danger">Ignore</button><a href="/t/capture_log/${r.id}">Details</a></form></div>`
  })
  return page({
    title: 'Review',
    active: 'review',
    reviewCount: ctx.reviewCount,
    body: html`<h1>Review</h1><p class="sub">Recordings that need you. Filing one runs it through the planner into that table.</p>
${done ? html`<div class="saved">${done}</div>` : html``}
${items.length ? items : html`<p class="empty">Nothing waiting.</p>`}`,
  })
}

async function resolve(ctx: Ctx, id: string, data: FormData): Promise<Response> {
  const tableKey = String(data.get('table') ?? '')
  if (tableKey && !content.some((t) => t.key === tableKey)) return redirect('/review')
  const result = await resolveCapture(ctx.env, { captureLogId: id, tableKey, workerUrl: ctx.url.origin, source: 'Notification' })
  return redirect(`/review?${new URLSearchParams({ done: result.message })}`)
}

// ---------------------------------------------------------------- router ----

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/favicon.ico') return new Response(null, { status: 204 })

    const auth = await authenticate(request, env)
    if (!auth.ok) {
      console.log(JSON.stringify({ event: 'app.denied', reason: auth.reason }))
      return new Response(`${auth.status === 503 ? auth.reason : 'Forbidden'}\n`, { status: auth.status })
    }
    const asset = request.method === 'GET' ? homeScreenAsset(url.pathname) : null
    if (asset) return asset
    if (!env.DB) return new Response('No database is bound to this app.\n', { status: 503 })

    // Forms post only from this app. Access's cookie would otherwise ride along
    // on a cross-site POST from any page you happened to have open.
    if (request.method === 'POST') {
      const origin = request.headers.get('origin')
      if (origin !== url.origin) return new Response('Cross-site request refused\n', { status: 403 })
    } else if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('method not allowed\n', { status: 405 })
    }

    const ctx: Ctx = {
      env,
      db: env.DB,
      store: d1Store(env.DB, schema),
      tz: String((request as Request & { cf?: { timezone?: string } }).cf?.timezone ?? 'UTC'),
      url,
      reviewCount: await reviewCount(env.DB),
    }

    try {
      const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)
      const post = request.method === 'POST'
      if (!parts.length) return today(ctx)
      if (parts[0] === 'tables' && parts.length === 1) return tables(ctx)
      if (parts[0] === 'backup' && parts.length === 1 && !post) return download(ctx)
      if (parts[0] === 'new' && parts.length === 1) return chooser(ctx)
      if (parts[0] === 'todos' && tasks) {
        if (parts.length === 1) return post ? addTodo(ctx, tasks, await request.formData()) : todos(ctx, tasks)
        if (parts.length === 3 && parts[2] === 'done' && post) return toggleTodo(ctx, tasks, parts[1], await request.formData())
      }
      if (parts[0] === 'review') {
        if (parts.length === 1) return review(ctx)
        if (parts.length === 2 && post) return resolve(ctx, parts[1], await request.formData())
      }
      if (parts[0] === 't' && parts[1]) {
        const t = byKey.get(parts[1])
        if (!t) return notFound(ctx)
        if (parts.length === 2) return post ? create(ctx, t, await request.formData()) : list(ctx, t)
        if (parts.length === 3 && parts[2] === 'new' && !post) return newForm(ctx, t)
        if (parts.length === 3) return post ? save(ctx, t, parts[2], await request.formData()) : entry(ctx, t, parts[2])
      }
      return notFound(ctx)
    } catch (err) {
      console.log(JSON.stringify({ event: 'app.error', path: url.pathname, message: err instanceof Error ? err.stack : String(err) }))
      return page({
        title: 'Something went wrong',
        active: '',
        status: 500,
        reviewCount: ctx.reviewCount,
        body: html`<h1>Something went wrong</h1><p class="error">${err instanceof Error ? err.message : String(err)}</p><p>Nothing you typed was saved unless the page said so. <a href="/">Back to today</a></p>`,
      })
    }
  },
}

