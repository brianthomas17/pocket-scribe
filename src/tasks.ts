/**
 * To-dos: due dates, done, and a morning digest.
 *
 * Any schema.json table whose roles name both `due` and `done` is a task list.
 * The app shows it grouped by when things are due; the capture Worker sends one
 * Telegram message each morning with what is overdue, due today and due
 * tomorrow, a ✓ button on each. Nothing is sent when that list is empty — a
 * message every day regardless is how a digest stops being read.
 */

import type { Schema, SchemaTable } from './planner'
import type { Store, StoreRecord } from './store'

export interface Task {
  id: string
  title: string
  notes: string
  due: string | null
  done: boolean
}

export type Bucket = 'overdue' | 'today' | 'tomorrow' | 'week' | 'later' | 'undated'

export const BUCKETS: Array<{ key: Bucket; label: string }> = [
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Today' },
  { key: 'tomorrow', label: 'Tomorrow' },
  { key: 'week', label: 'This week' },
  { key: 'later', label: 'Later' },
  { key: 'undated', label: 'No date' },
]

export function taskTable(schema: Schema): SchemaTable | undefined {
  return schema.tables.find((t) => t.roles?.due && t.roles?.done)
}

export function toTask(t: SchemaTable, r: StoreRecord): Task {
  const roles = t.roles ?? {}
  const due = r.fields[roles.due]
  return {
    id: r.id,
    title: String(r.fields[roles.title ?? t.fields[0].name] ?? '(untitled)'),
    notes: String((roles.notes && r.fields[roles.notes]) ?? ''),
    due: typeof due === 'string' && due ? due.slice(0, 10) : null,
    done: r.fields[roles.done] === true,
  }
}

const addDays = (day: string, n: number) => {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + n)
  return d.toISOString().slice(0, 10)
}

export function bucketOf(task: Task, today: string): Bucket {
  if (!task.due) return 'undated'
  if (task.due < today) return 'overdue'
  if (task.due === today) return 'today'
  if (task.due === addDays(today, 1)) return 'tomorrow'
  if (task.due <= addDays(today, 7)) return 'week'
  return 'later'
}

/** Open tasks grouped by bucket, soonest first within each; done tasks newest-due first. */
export function arrange(tasks: Task[], today: string): { open: Map<Bucket, Task[]>; done: Task[] } {
  const open = new Map<Bucket, Task[]>(BUCKETS.map((b) => [b.key, []]))
  for (const task of tasks.filter((x) => !x.done)) open.get(bucketOf(task, today))!.push(task)
  for (const list of open.values()) list.sort((a, b) => (a.due ?? '9999').localeCompare(b.due ?? '9999') || a.title.localeCompare(b.title))
  const done = tasks.filter((x) => x.done).sort((a, b) => (b.due ?? '').localeCompare(a.due ?? ''))
  return { open, done }
}

export async function allTasks(store: Store, t: SchemaTable): Promise<Task[]> {
  return (await store.list(t.name)).map((r) => toTask(t, r))
}

export async function setDone(store: Store, t: SchemaTable, id: string, done: boolean, by: 'you' | 'system' = 'you'): Promise<Task> {
  return toTask(t, await store.update(t.name, id, { [t.roles!.done]: done }, by))
}

/** YYYY-MM-DD and the hour, in a time zone. */
export function localNow(tz: string, at = new Date()): { day: string; hour: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? ''
  return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) }
}

const short = (day: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(`${day}T00:00:00Z`))

/** Telegram allows a long message, but a digest past this many tasks is not read. */
const DIGEST_MAX = 12

/**
 * The digest for a morning, or null when there is nothing due.
 * Button data is `task:<id>`, well inside Telegram's 64-byte limit.
 */
export function digest(
  tasks: Task[],
  today: string,
  appUrl?: string
): { text: string; buttons: Array<{ text: string; callback_data: string }> } | null {
  const { open } = arrange(tasks, today)
  const due = (['overdue', 'today', 'tomorrow'] as const).filter((k) => open.get(k)!.length)
  if (!due.length) return null

  const shown: Task[] = []
  const lines = [`To-dos for ${short(today)}`]
  for (const key of due) {
    const label = BUCKETS.find((b) => b.key === key)!.label
    lines.push('', label)
    for (const task of open.get(key)!) {
      if (shown.length >= DIGEST_MAX) break
      shown.push(task)
      lines.push(`• ${task.title}${key === 'overdue' && task.due ? ` (was due ${short(task.due)})` : ''}`)
    }
  }
  const total = due.reduce((n, k) => n + open.get(k)!.length, 0)
  if (total > shown.length) lines.push('', `…and ${total - shown.length} more`)
  if (appUrl) lines.push('', `${appUrl.replace(/\/$/, '')}/todos`)

  return {
    text: lines.join('\n'),
    buttons: shown.map((task) => ({ text: `✓ ${task.title.length > 40 ? `${task.title.slice(0, 39)}…` : task.title}`, callback_data: `task:${task.id}` })),
  }
}

export const TASK_CALLBACK = 'task:'
