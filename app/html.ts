/**
 * Page chrome, and how each field type is shown, edited and read back.
 *
 * Server-rendered HTML with plain forms: it works on a phone with nothing to
 * install, every action is a real link or a real POST, and there is no client
 * framework to keep up to date. The only script converts date-times between
 * your clock and UTC.
 */

import type { SchemaTable } from '../src/planner'
import { HOME_SCREEN_HEAD } from './home-screen'

export type FieldSpec = SchemaTable['fields'][number]

export const esc = (v: unknown) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

/** Tagged template that escapes every interpolation unless it is already Html. */
export class Html {
  constructor(readonly value: string) {}
  toString() {
    return this.value
  }
}
export const raw = (s: string) => new Html(s)
export function html(strings: TemplateStringsArray, ...values: unknown[]): Html {
  let out = strings[0]
  values.forEach((v, i) => {
    const part = Array.isArray(v) ? v.map((x) => (x instanceof Html ? x.value : esc(x))).join('') : v instanceof Html ? v.value : esc(v)
    out += part + strings[i + 1]
  })
  return new Html(out)
}

// ----------------------------------------------------------------- dates ----

/** YYYY-MM-DD in a time zone (the visitor's, from Cloudflare). */
export function localDay(tz: string, at = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
}

export function shiftDay(day: string, by: number): string {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + by)
  return d.toISOString().slice(0, 10)
}

export const isDay = (s: string | null): s is string => !!s && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`))

export function prettyDay(day: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' }).format(
    new Date(`${day}T00:00:00Z`)
  )
}

export function prettyTime(iso: string, tz: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(d)
}

// ---------------------------------------------------------------- fields ----

const SELECT = new Set(['singleSelect', 'multipleSelects'])
const LONG = new Set(['multilineText', 'richText'])
const EDITABLE = new Set(['singleLineText', 'multilineText', 'richText', 'date', 'dateTime', 'number', 'checkbox', 'singleSelect', 'multipleSelects', 'email', 'url', 'phoneNumber'])

export const isEditable = (f: FieldSpec) => EDITABLE.has(f.type)

/** Short, read-only rendering for lists and the day view. */
export function show(f: FieldSpec | undefined, v: unknown, tz: string): Html {
  if (v === undefined || v === null || v === '') return html``
  if (Array.isArray(v)) return html`${v.map((x) => html`<span class="chip">${typeof x === 'object' ? JSON.stringify(x) : x}</span>`)}`
  if (f?.type === 'checkbox') return html`${v ? '✓' : ''}`
  if (f?.type === 'date' && typeof v === 'string') return html`${prettyDay(v.slice(0, 10))}`
  if (f?.type === 'dateTime' && typeof v === 'string') return html`${prettyTime(v, tz)}`
  if (typeof v === 'object') return html`<code>${JSON.stringify(v)}</code>`
  return html`${v}`
}

/** One form control for one field. Select choices come from the store, so options grow as they are used. */
export function input(f: FieldSpec, v: unknown, choices: string[]): Html {
  const name = `f:${f.name}`
  const id = `f-${f.name.replace(/[^A-Za-z0-9]+/g, '-')}`
  const label = html`<label for="${id}">${f.name}</label>`
  const str = v === undefined || v === null ? '' : typeof v === 'string' ? v : String(v)

  switch (f.type) {
    case 'multilineText':
    case 'richText': {
      const rows = Math.min(16, Math.max(3, str.split('\n').length + 1))
      return html`<div class="field">${label}<textarea id="${id}" name="${name}" rows="${rows}">${str}</textarea></div>`
    }
    case 'date':
      return html`<div class="field">${label}<input id="${id}" type="date" name="${name}" value="${str.slice(0, 10)}"></div>`
    case 'dateTime':
      // Filled from the ISO value by the page script, in your own time zone.
      return html`<div class="field">${label}<input id="${id}" type="datetime-local" data-iso="${str}"><input type="hidden" name="${name}" value="${str}"></div>`
    case 'number':
      return html`<div class="field">${label}<input id="${id}" type="number" step="any" name="${name}" value="${str}"></div>`
    case 'checkbox':
      return html`<div class="field check"><input id="${id}" type="checkbox" name="${name}" value="1" ${v ? raw('checked') : ''}>${label}<input type="hidden" name="present:${f.name}" value="1"></div>`
    case 'singleSelect': {
      const listId = `${id}-choices`
      return html`<div class="field">${label}<input id="${id}" name="${name}" value="${str}" list="${listId}" autocomplete="off" placeholder="Pick or type a new one"><datalist id="${listId}">${choices.map((c) => html`<option value="${c}">`)}</datalist></div>`
    }
    case 'multipleSelects': {
      const chosen = new Set(Array.isArray(v) ? v.map(String) : [])
      const all = [...new Set([...choices, ...chosen])]
      return html`<fieldset class="field"><legend>${f.name}</legend><div class="choices">${all.map(
        (c) => html`<label class="choice"><input type="checkbox" name="${name}" value="${c}" ${chosen.has(c) ? raw('checked') : ''}> ${c}</label>`
      )}</div><input name="new:${f.name}" placeholder="Add new, separated by commas" autocomplete="off"><input type="hidden" name="present:${f.name}" value="1"></fieldset>`
    }
    default:
      return html`<div class="field">${label}<input id="${id}" name="${name}" value="${str}"></div>`
  }
}

/**
 * Read one field back from a submitted form. `undefined` means the form did
 * not include it (leave it alone); `null` means it was emptied (clear it).
 */
export function readField(f: FieldSpec, form: FormData): unknown {
  const name = `f:${f.name}`
  switch (f.type) {
    case 'checkbox':
      if (!form.has(`present:${f.name}`)) return undefined
      return form.get(name) === '1'
    case 'multipleSelects': {
      if (!form.has(`present:${f.name}`)) return undefined
      const picked = form.getAll(name).map(String)
      const added = String(form.get(`new:${f.name}`) ?? '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
      const all = [...new Set([...picked, ...added])]
      return all.length ? all : null
    }
    case 'number': {
      if (!form.has(name)) return undefined
      const s = String(form.get(name)).trim()
      if (!s) return null
      const n = Number(s)
      return Number.isFinite(n) ? n : null
    }
    default: {
      if (!form.has(name)) return undefined
      // Text keeps its line breaks and inner spacing; only trailing space goes.
      const s = String(form.get(name)).replace(/\r\n/g, '\n').trimEnd()
      if (!s.trim()) return null
      if (f.type === 'date') return s.slice(0, 10)
      return s
    }
  }
}

export function choicesFor(f: FieldSpec, live: Map<string, string[]>, tableKey: string): string[] {
  return SELECT.has(f.type) ? (live.get(`${tableKey}.${f.name}`) ?? []) : []
}

/**
 * How a record reads in a list: a title line and the text under it.
 *
 *   a table named by its date (Journal, Dreams)  → the date, then its text
 *   a recording                                  → what was said
 *   anything else                                → its title field, then its text
 */
export function summarize(t: SchemaTable, fields: Record<string, unknown>): { title: string; text: string } {
  const longText = t.fields
    .filter((f) => LONG.has(f.type))
    .map((f) => fields[f.name])
    .filter((v): v is string => typeof v === 'string' && !!v.trim())
  if (t.key === 'capture_log') return { title: String(fields['Raw Transcript'] ?? fields['Recording ID'] ?? ''), text: '' }
  if (t.fields[0]?.type === 'date') {
    const day = typeof fields[t.fields[0].name] === 'string' ? prettyDay(String(fields[t.fields[0].name]).slice(0, 10)) : '(no date)'
    return { title: day, text: longText.join('\n') }
  }
  const key = t.roles?.title ?? t.fields[0]?.name
  const title = key && fields[key] !== undefined && fields[key] !== '' ? String(fields[key]) : longText[0] ?? '(empty)'
  return { title, text: longText.filter((s) => s !== title).join('\n') }
}

export const titleOf = (t: SchemaTable, fields: Record<string, unknown>) => summarize(t, fields).title

export const snippet = (s: string, n = 140) => {
  const clean = s.replace(/\s+/g, ' ').trim()
  return clean.length > n ? `${clean.slice(0, n - 1)}…` : clean
}

// ------------------------------------------------------------------ page ----

const CSS = `
:root{--bg:#fbfaf8;--panel:#fff;--ink:#1d1b18;--quiet:#6b665e;--line:#e6e2db;--accent:#2f5d8a;--accent-ink:#fff;--warn:#9a5b00;--bad:#a12d2d;--good:#2e6b3a;--chip:#efece6}
@media (prefers-color-scheme:dark){:root{--bg:#141312;--panel:#1d1c1a;--ink:#ece8e1;--quiet:#a39d93;--line:#34312d;--accent:#8db4dc;--accent-ink:#0d1b29;--warn:#e0a54a;--bad:#e27a7a;--good:#7fc48c;--chip:#2a2825}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;-webkit-text-size-adjust:100%}
a{color:var(--accent);text-decoration:none}
main{max-width:720px;margin:0 auto;padding:16px 16px 96px}
nav.top{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--line);padding-top:env(safe-area-inset-top)}
nav.top div{padding-left:max(12px,env(safe-area-inset-left));padding-right:max(12px,env(safe-area-inset-right))}
main{padding-bottom:calc(96px + env(safe-area-inset-bottom))}
.save-bar{padding-bottom:calc(10px + env(safe-area-inset-bottom))}
nav.top div{max-width:720px;margin:0 auto;display:flex;gap:4px;padding:8px 12px;overflow-x:auto}
nav.top a{padding:6px 10px;border-radius:8px;color:var(--quiet);white-space:nowrap}
nav.top a.on{background:var(--chip);color:var(--ink);font-weight:600}
.badge{display:inline-block;min-width:20px;padding:0 6px;border-radius:10px;background:var(--warn);color:var(--panel);font-size:12px;font-weight:700;text-align:center;margin-left:4px}
h1{font-size:22px;margin:8px 0 4px}
h2{font-size:15px;text-transform:uppercase;letter-spacing:.04em;color:var(--quiet);margin:28px 0 8px}
.sub{color:var(--quiet);margin:0 0 16px}
.card{display:block;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:12px 14px;margin:8px 0;color:var(--ink)}
a.card:hover{border-color:var(--accent)}
.card .t{font-weight:600}
.card .s{color:var(--quiet);font-size:14px;margin-top:2px}
.card .body{color:var(--ink);font-size:15px;margin-top:4px;white-space:pre-line}
.head{display:flex;justify-content:space-between;align-items:baseline;margin:28px 0 8px}.head h2{margin:0}
.empty{color:var(--quiet);font-style:italic;margin:4px 0}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.spread{display:flex;justify-content:space-between;align-items:center;gap:8px}
.btn,button{display:inline-block;font:inherit;font-weight:600;padding:9px 14px;border-radius:10px;border:1px solid var(--line);background:var(--panel);color:var(--ink);cursor:pointer}
.btn.primary,button.primary{background:var(--accent);border-color:var(--accent);color:var(--accent-ink)}
button.danger{color:var(--bad)}
.field{display:block;margin:0 0 14px;border:0;padding:0}
.field label,.field legend{display:block;font-size:14px;font-weight:600;color:var(--quiet);margin-bottom:4px;padding:0}
.field.check{display:flex;gap:8px;align-items:center}
.field.check label{margin:0;color:var(--ink);font-size:16px}
input,textarea,select{width:100%;font:inherit;color:var(--ink);background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:9px 11px}
input[type=checkbox]{width:20px;height:20px;padding:0}
textarea{resize:vertical}
.choices{display:flex;flex-wrap:wrap;gap:6px 14px;margin-bottom:8px}
.choice{display:flex;gap:6px;align-items:center;font-size:15px;color:var(--ink);font-weight:400}
.chip{display:inline-block;background:var(--chip);border-radius:6px;padding:0 6px;margin:0 4px 2px 0;font-size:14px}
.status{font-size:13px;font-weight:700}
.status.Written{color:var(--good)}.status.Failed{color:var(--bad)}.status.Unrouted,.status.Needs{color:var(--warn)}.status.Ignored{color:var(--quiet)}
.saved{background:var(--chip);border-radius:10px;padding:8px 12px;margin:8px 0}
.error{color:var(--bad);font-weight:600}
blockquote{margin:8px 0;padding:8px 12px;border-left:3px solid var(--line);color:var(--quiet);white-space:pre-line;font-size:15px}
details{margin:16px 0}summary{cursor:pointer;color:var(--quiet)}
table.hist{width:100%;border-collapse:collapse;font-size:14px}table.hist td{border-top:1px solid var(--line);padding:6px 4px;vertical-align:top}
.save-bar{position:sticky;bottom:0;background:var(--bg);padding:10px 0;border-top:1px solid var(--line);display:flex;gap:8px}
form.search{display:flex;gap:8px;margin:8px 0 16px}
.pager{display:flex;justify-content:space-between;margin-top:16px}
form.quick{display:flex;flex-wrap:wrap;gap:8px;margin:8px 0 8px}form.quick input[name=title]{flex:1 1 100%}form.quick input[type=date]{flex:1;width:auto}
.task{display:flex;gap:12px;align-items:flex-start;background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:10px 12px;margin:8px 0}
.task form{margin:0}.task a{flex:1;color:var(--ink);display:flex;flex-direction:column}
.task .due{font-size:13px;color:var(--quiet)}.task .s{font-size:14px;color:var(--quiet);overflow-wrap:anywhere}.task .due.late{color:var(--bad);font-weight:600}
button.tick{width:26px;height:26px;padding:0;border-radius:50%;border:2px solid var(--quiet);background:none;color:var(--good);font-size:15px;line-height:1}
.task.done .t{text-decoration:line-through;color:var(--quiet)}.task.done button.tick{border-color:var(--good)}
`

const SCRIPT = `
document.querySelectorAll('input[type=datetime-local][data-iso]').forEach(function (el) {
  var hidden = el.nextElementSibling, iso = el.dataset.iso
  if (iso) { var d = new Date(iso); if (!isNaN(d)) { var p = function (n) { return String(n).padStart(2, '0') }
    el.value = d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes()) } }
  el.addEventListener('change', function () { hidden.value = el.value ? new Date(el.value).toISOString() : '' })
})
`

export function page(opts: { title: string; active: string; reviewCount: number; body: Html; status?: number }): Response {
  const tab = (href: string, key: string, label: string, extra: Html = html``) =>
    html`<a href="${href}" class="${opts.active === key ? 'on' : ''}">${label}${extra}</a>`
  const doc = html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="robots" content="noindex">${raw(HOME_SCREEN_HEAD)}<title>${opts.title} · Pocket Scribe</title><style>${raw(CSS)}</style></head><body>
<nav class="top"><div>${tab('/', 'today', 'Today')}${tab('/tables', 'tables', 'Tables')}${tab('/todos', 'todos', 'To-dos')}${tab('/review', 'review', 'Review', opts.reviewCount ? html`<span class="badge">${opts.reviewCount}</span>` : html``)}${tab('/new', 'new', '+ New')}</div></nav>
<main>${opts.body}</main><script>${raw(SCRIPT)}</script></body></html>`
  return new Response(doc.value, {
    status: opts.status ?? 200,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'x-frame-options': 'DENY',
      'referrer-policy': 'same-origin',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src 'self'; manifest-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    },
  })
}
