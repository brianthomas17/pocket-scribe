/**
 * Turns planned operations into writes.
 *
 * This module re-checks everything the planner was told, rather than trusting
 * that it complied. The planner proposes; this decides. A field the schema
 * does not list, a field marked non-writable, or a select choice that does not
 * exist in the live base is dropped here — so the worst a confused planner can
 * do is write less than intended, never something unexpected into a table the
 * person actually relies on.
 */

import { store, type StoreTable as LiveTable } from './store'
import type { Operation, PlannedField, Schema, SchemaTable } from './planner'

export interface AppliedOperation {
  op: Operation['op']
  table: string
  recordId: string
  fields: Record<string, unknown>
  dropped: string[]
}

function coerce(
  type: string,
  planned: PlannedField,
  choices: Set<string> | null,
  allowNewChoices: boolean
): { value: unknown; dropped?: string } {
  const raw = planned.value.trim()

  switch (type) {
    case 'multipleSelects': {
      const wanted = planned.values.map((v) => v.trim()).filter(Boolean)
      if (!wanted.length) return { value: undefined }
      if (!choices || allowNewChoices) return { value: wanted }
      const ok = wanted.filter((v) => choices.has(v.toLowerCase()))
      const bad = wanted.filter((v) => !choices.has(v.toLowerCase()))
      return {
        value: ok.length ? ok : undefined,
        ...(bad.length ? { dropped: `${planned.name}: unknown choice(s) ${bad.join(', ')}` } : {}),
      }
    }
    case 'singleSelect': {
      if (!raw) return { value: undefined }
      if (!choices || allowNewChoices) return { value: raw }
      if (choices.has(raw.toLowerCase())) return { value: raw }
      return { value: undefined, dropped: `${planned.name}: unknown choice "${raw}"` }
    }
    case 'number':
    case 'rating': {
      const n = Number(raw)
      return Number.isFinite(n) ? { value: n } : { value: undefined }
    }
    case 'checkbox':
      return { value: /^(true|yes|1|done|checked)$/i.test(raw) }
    case 'date':
      return { value: raw ? raw.slice(0, 10) : undefined }
    case 'dateTime':
      return { value: raw || undefined }
    default:
      return { value: raw || undefined }
  }
}

/** Map planned fields onto real, writable fields. Anything else is dropped and reported. */
export function resolveFields(
  table: SchemaTable,
  liveTable: LiveTable | undefined,
  planned: PlannedField[],
  allowNewChoices: boolean
): { fields: Record<string, unknown>; dropped: string[] } {
  const writable = new Map(
    table.fields.filter((f) => f.write !== false).map((f) => [f.name.toLowerCase(), f])
  )
  const liveFields = new Map((liveTable?.fields ?? []).map((f) => [f.name.toLowerCase(), f]))

  const fields: Record<string, unknown> = {}
  const dropped: string[] = []

  for (const p of planned) {
    const key = p.name.trim().toLowerCase()
    const spec = writable.get(key)
    if (!spec) {
      dropped.push(`${p.name}: not a writable field on ${table.name}`)
      continue
    }
    const choices = liveFields.get(key)?.options?.choices
    const choiceSet = choices ? new Set(choices.map((c) => c.name.toLowerCase())) : null

    const { value, dropped: why } = coerce(spec.type, p, choiceSet, allowNewChoices)
    if (why) dropped.push(why)
    if (value !== undefined) fields[spec.name] = value
  }

  return { fields, dropped }
}

/** Append a bullet without disturbing what is already in the field. */
function appendBullet(existing: unknown, addition: string): string {
  const current = typeof existing === 'string' ? existing.trimEnd() : ''
  const bullet = `- ${addition.trim().replace(/^[-*•]\s*/, '')}`
  return current ? `${current}\n${bullet}` : bullet
}

export async function applyOperation(
  env: Env,
  schema: Schema,
  live: LiveTable[],
  op: Operation,
  ctx: { recordedAt: string }
): Promise<AppliedOperation> {
  const table = schema.tables.find((t) => t.key === op.table)
  if (!table) throw new Error(`unknown table key "${op.table}"`)
  if (!table.operations.includes(op.op)) {
    throw new Error(`operation "${op.op}" is not allowed on ${table.name}`)
  }

  const liveTable = live.find((t) => t.name.toLowerCase() === table.name.toLowerCase())
  const { fields, dropped } = resolveFields(
    table,
    liveTable,
    op.fields,
    schema.routing.allowNewSelectChoices
  )

  if (op.op === 'append') {
    const target = table.appendTarget
    if (!target) throw new Error(`${table.name} has no append target`)
    if (!op.target_record_id) throw new Error(`append to ${table.name} without a target record`)

    // The bullet text arrives as the append-target field; everything else the
    // planner set on an append is ignored — appending a learning must not
    // quietly edit the trip's date, attendance, or reminder settings.
    const addition = fields[target]
    if (typeof addition !== 'string' || !addition.trim()) {
      throw new Error(`append to ${table.name} produced no text for ${target}`)
    }

    const existing = await store(env).get(table.name, op.target_record_id)
    const merged = appendBullet(existing.fields[target], addition)
    await store(env).update(table.name, op.target_record_id, { [target]: merged })

    return { op: op.op, table: table.name, recordId: op.target_record_id, fields: { [target]: addition }, dropped }
  }

  if (op.op === 'update') {
    if (!op.target_record_id) throw new Error(`update to ${table.name} without a target record`)
    if (!Object.keys(fields).length) throw new Error(`update to ${table.name} had no usable fields`)
    await store(env).update(table.name, op.target_record_id, fields)
    return { op: op.op, table: table.name, recordId: op.target_record_id, fields, dropped }
  }

  // create — but check once more that it really is a create.
  //
  // The planner decides between create and append from a candidate list read
  // before it ran. That is correct when captures are serialized, and wrong the
  // moment they are not: a manual sync fires a webhook per recording, each runs
  // in its own invocation, and four "Adventure Learnings, Burning Man 26"
  // recordings all read the list before any of them had written — producing
  // four trips named Burning Man 26 instead of one with four learnings.
  //
  // Re-checking here closes it for good, because it happens after the write
  // that would have collided. One extra read, and only on tables that identify
  // records by a field.
  const dateField = table.roles?.date
  if (dateField && !(dateField in fields)) {
    const spec = table.fields.find((f) => f.name === dateField)
    fields[dateField] = spec?.type === 'dateTime' ? ctx.recordedAt : ctx.recordedAt.slice(0, 10)
  }
  if (!Object.keys(fields).length) throw new Error(`create on ${table.name} had no usable fields`)

  const resolveField = table.resolveBy?.[0]
  const resolveValue = resolveField ? fields[resolveField] : undefined
  if (resolveField && typeof resolveValue === 'string' && resolveValue.trim()) {
    // A date or date-time is matched by day, so "today's entry" is found
    // whatever time of day it was written.
    const resolveType = table.fields.find((f) => f.name === resolveField)?.type
    const match =
      resolveType === 'date' || resolveType === 'dateTime'
        ? { field: resolveField, sameDay: resolveValue }
        : { field: resolveField, equalsIgnoringCase: resolveValue }
    const existing = await store(env).list(table.name, { where: [match], limit: 1 })
    if (existing.length) {
      const hit = existing[0]
      const target = table.appendTarget

      // A table with an append target grows a list; one without merges fields.
      if (target && typeof fields[target] === 'string' && (fields[target] as string).trim()) {
        const merged = appendBullet(hit.fields[target], fields[target] as string)
        await store(env).update(table.name, hit.id, { [target]: merged })
        return { op: 'append', table: table.name, recordId: hit.id, fields: { [target]: fields[target] }, dropped }
      }

      // Never overwrite what is already there. Blank fields are filled; long
      // text that already has something in it is added to, not skipped —
      // a second journal entry on the same day is more journal, and dropping
      // it would lose the recording while the log says Written.
      const additions: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(fields)) {
        if (v === undefined) continue
        const current = hit.fields[k]
        if (current === undefined || current === null || current === '') {
          additions[k] = v
          continue
        }
        const type = table.fields.find((f) => f.name === k)?.type
        const isProse = type === 'multilineText' || type === 'richText'
        if (isProse && typeof current === 'string' && typeof v === 'string' && v.trim() && !current.includes(v.trim())) {
          additions[k] = `${current.trimEnd()}\n\n${v.trim()}`
        }
      }
      if (Object.keys(additions).length) {
        await store(env).update(table.name, hit.id, additions)
      }
      return { op: 'update', table: table.name, recordId: hit.id, fields: additions, dropped }
    }
  }

  const created = await store(env).create(table.name, fields)
  return { op: op.op, table: table.name, recordId: created.id, fields, dropped }
}
