/**
 * The planner.
 *
 * Takes a verbatim transcript and returns a list of operations to run against
 * the tables. It is a planner rather than a classifier because "append a bullet
 * to the Joshua Tree adventure" and "start a new journal entry" are the same
 * kind of request with different verbs — collapsing them into one label would
 * lose the target.
 *
 * Everything it is allowed to touch comes from schema.json plus the select
 * choices already in use. It never invents a table or a field; apply.ts
 * enforces that independently, because a planner that can only *propose* is a
 * much smaller blast radius than one that writes.
 */

import Anthropic from '@anthropic-ai/sdk'
import type { StoreRecord, StoreTable as LiveTable } from './store/types'

export interface SchemaTable {
  key: string
  name: string
  existing?: boolean
  operations: string[]
  vocabulary?: string[]
  appendTarget?: string
  resolveBy?: string[]
  roles?: Record<string, string>
  conventions?: string[]
  candidateLimit?: number
  candidateSort?: string
  candidateFields?: string[]
  lifecycleFields?: string[]
  readOnlyFields?: string[]
  fields: Array<{
    name: string
    type: string
    write?: boolean
    description?: string
    options?: { choices?: Array<{ name: string }> }
  }>
}

export interface Schema {
  schemaVersion: number
  routing: {
    ignoreBelowConfidence: number
    minConfidenceToWrite: number
    confirmIgnoreBelow?: number
    confirmIgnoreAboveChars?: number
    confirmIgnoreBelowWhenLong?: number
    allowNewSelectChoices: boolean
  }
  corrections?: { onlyFieldsWrittenByPlanner?: boolean; maxAgeDays?: number }
  reminders?: import('./reminders').RemindersConfig
  tables: SchemaTable[]
}

export interface PlannedField {
  name: string
  value: string
  values: string[]
}

export interface Operation {
  op: 'create' | 'append' | 'update' | 'ignore'
  table: string
  target_record_id: string
  fields: PlannedField[]
  confidence: number
  note: string
}

export interface Plan {
  classifier_heard: string
  alternatives: string[]
  operations: Operation[]
}

export interface Correction {
  transcript: string
  field: string
  from: string
  to: string
}

/**
 * Structured-output schema.
 *
 * Fields are a name/value list rather than a free-form object because
 * structured outputs require `additionalProperties: false` everywhere — an
 * arbitrary key/value map cannot be expressed. `values` carries multi-select
 * choices; `value` carries everything else.
 */
const PLAN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['classifier_heard', 'alternatives', 'operations'],
  properties: {
    classifier_heard: {
      type: 'string',
      description:
        'The opening word(s) you interpreted as the classifier, verbatim from the transcript. Empty string if the recording never addressed the system.',
    },
    alternatives: {
      type: 'array',
      items: { type: 'string' },
      description:
        'Other table keys this recording could plausibly belong to, best first. Empty when it is unambiguous. These become the buttons on a "where does this go?" notification, so only list tables a person might genuinely have meant.',
    },
    operations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['op', 'table', 'target_record_id', 'fields', 'confidence', 'note'],
        properties: {
          op: {
            type: 'string',
            enum: ['create', 'append', 'update', 'ignore'],
            description: 'ignore = this recording did not address the system; emit exactly one ignore operation and nothing else.',
          },
          table: { type: 'string', description: 'A table key from the list. Empty string for ignore.' },
          target_record_id: {
            type: 'string',
            description: 'Record id for append/update, chosen from the candidates given. Empty string for create/ignore.',
          },
          fields: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['name', 'value', 'values'],
              properties: {
                name: { type: 'string' },
                value: { type: 'string', description: 'Value for every field type except multi-select. Empty string if using values.' },
                values: { type: 'array', items: { type: 'string' }, description: 'Multi-select choices. Empty array if using value.' },
              },
            },
          },
          confidence: {
            type: 'number',
            description:
              '0 to 1. On create/append/update: how sure you are this is the right table and shape. On ignore: how sure you are the recording was NOT meant for the system at all — 0.95+ for a meeting or a conversation, lower when it might have been someone talking to their recorder and you are simply not certain. Be honest; low confidence asks rather than guessing.',
          },
          note: { type: 'string', description: 'One short line on why, especially when unsure. Empty string if obvious.' },
        },
      },
    },
  },
}

function describeTables(schema: Schema, live: LiveTable[]): string {
  const liveByName = new Map(live.map((t) => [t.name.toLowerCase(), t]))

  return schema.tables
    .filter((t) => t.operations.length > 0)
    .map((table) => {
      const liveTable = liveByName.get(table.name.toLowerCase())
      const liveFields = new Map((liveTable?.fields ?? []).map((f) => [f.name.toLowerCase(), f]))

      const fields = table.fields
        .filter((f) => f.write !== false)
        .map((f) => {
          const choices = liveFields.get(f.name.toLowerCase())?.options?.choices
          const allowed = choices?.length
            ? ` — choose from: ${choices.map((c) => c.name).join(', ')}`
            : ''
          const note = f.description ? ` (${f.description})` : ''
          return `    - ${f.name} [${f.type}]${allowed}${note}`
        })
        .join('\n')

      const roles = table.roles
        ? Object.entries(table.roles)
            .map(([role, name]) => `${role}=${name}`)
            .join(', ')
        : ''

      const conventions = (table.conventions ?? []).map((c) => `    · ${c}`).join('\n')

      return [
        `  ${table.key} → table "${table.name}"`,
        `    heard as: ${(table.vocabulary ?? []).join(', ')}`,
        `    operations: ${table.operations.join(', ')}`,
        roles ? `    roles: ${roles}` : '',
        table.appendTarget ? `    append target: ${table.appendTarget} (add a bullet; never rewrite)` : '',
        fields,
        conventions ? `    how they use this table:\n${conventions}` : '',
      ]
        .filter(Boolean)
        .join('\n')
    })
    .join('\n\n')
}

function describeCorrections(corrections: Correction[]): string {
  if (!corrections.length) return ''

  // Routing mistakes and field mistakes teach different things, and phrasing a
  // wrong table as "you set table to X" buries the lesson.
  // These come back newest first; the prompt below tells the model
  // the last one is the most recent, and with conflicting corrections about
  // the same vocabulary that ordering decides which one wins.
  const examples = [...corrections]
    .reverse()
    .map((c) =>
      c.field === 'table'
        ? `  - "${c.transcript}"\n      you filed this in ${c.from} — it belonged in ${c.to}`
        : `  - "${c.transcript}"\n      you set ${c.field} to "${c.from}" — the right value was "${c.to}"`
    )
    .join('\n')

  return `\n\n# Where you have been wrong before\n\nReal corrections this person made to your earlier output, newest last. These are the strongest signal you have about how their vocabulary maps onto their tables — they outrank your own reading of an ambiguous recording.\n\n${examples}`
}

export function buildSystemPrompt(
  schema: Schema,
  live: LiveTable[],
  corrections: Correction[]
): string {
  return `You route voice recordings into someone's personal database of trackers.

They speak a classifier word, pause, then talk — "Dream log. There was water running off the roof..." Your job is to turn that into operations against the tables below.

# Tables

${describeTables(schema, live)}

# Rules

Speech-to-text mangles words. "Dreamwald" is "dream log"; "to do list" and "Tudor list" are the todo list. Match on what they plausibly said out loud, not on exact strings.

Most recordings on this device are not for you — meetings, phone calls, a pocket knocking the button. If the recording never addressed the system, emit exactly one operation with op "ignore" and stop. Do not route a meeting into the journal because it sounded reflective.

Set the confidence on that ignore honestly. A meeting, a phone call, or muffled background noise is a confident ignore. Someone half-audibly starting a thought, or a fragment that could be the tail of a real note, is not — and saying so gets them asked rather than dropped. Being unsure is useful information; pretending to be certain is what loses a real capture silently.

Length is not the test — meetings are long too. What separates them is shape. A conversation has more than one person in it: replies, interruptions, questions answered. One person talking uninterrupted for a while, working through something or telling a story, is someone thinking out loud — and if there is real substance there and no classifier, the likeliest explanation is that they forgot to say one, not that their pocket recorded a monologue. Treat that as an unsure ignore. A back-and-forth between people stays a confident ignore no matter how long it runs.

One recording can be several operations. "Todo list — call insurance, email Greg, book the flights" is three creates, one per task. Emit them separately.

Append means append. When adding to an existing record, put ONLY the new text in the append-target field — the code adds it as a bullet to what is already there. Never restate existing content.

Only use select choices listed above. If nothing fits, leave the field out rather than inventing a choice.

Only fill fields the recording actually supports. An empty field is honest; a guessed one is noise the person has to find and fix later.

Confidence is a real signal, not a formality. Below ${schema.routing.minConfidenceToWrite} nothing is written and the recording goes to a review queue — which is the right outcome when you are unsure. Do not inflate it to force a write.${describeCorrections(corrections)}`
}

export async function plan(
  env: Env,
  args: {
    transcript: string
    recordedAt: string
    schema: Schema
    live: LiveTable[]
    candidates: Record<string, StoreRecord[]>
    corrections: Correction[]
    /** Set when a person has answered a "where does this go?" notification. */
    forceTable?: string
    /** What they said when they answered in words rather than tapping. */
    hint?: string
  }
): Promise<Plan> {
  const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY })

  const candidateBlocks = Object.entries(args.candidates)
    .filter(([, recs]) => recs.length > 0)
    .map(([tableKey, recs]) => {
      const table = args.schema.tables.find((t) => t.key === tableKey)
      const by = table?.resolveBy ?? []
      // Extra fields let an update merge with what is already on the record
      // instead of replacing it — the planner has to see today's gratitudes
      // before it rewrites the field.
      const shown = table?.candidateFields ?? by
      const lines = recs
        .map((r) => {
          const label = by.map((f) => r.fields[f]).filter(Boolean).join(' / ')
          const detail = shown
            .filter((f) => !by.includes(f) && r.fields[f])
            .map((f) => `      ${f}: ${String(r.fields[f]).replace(/\s+/g, ' ').slice(0, 300)}`)
            .join('\n')
          return `  ${r.id} — ${label || '(unnamed)'}${detail ? `\n${detail}` : ''}`
        })
        .join('\n')
      return `Existing ${tableKey} records you can append to or update:\n${lines}`
    })
    .join('\n\n')

  const message = await client.messages.create({
    model: env.PLANNER_MODEL || 'claude-opus-5',
    max_tokens: 8000,
    system: buildSystemPrompt(args.schema, args.live, args.corrections),
    output_config: {
      effort: 'medium',
      format: { type: 'json_schema', schema: PLAN_SCHEMA },
    },
    messages: [
      {
        role: 'user',
        content: `Recorded at: ${args.recordedAt}
${
  args.forceTable
    ? `\nThe person has already told you this belongs in "${args.forceTable}". Do not reconsider the routing or emit ignore — put it there and shape the fields to fit that table.\n`
    : ''
}${
  args.hint
    ? `\nThey were asked where this belongs and answered: "${args.hint}"\n\nThat answer is about this recording — treat it as instruction, not as content. It will usually name the table, or the specific record to add to, or both; it may be terse or misspelled. Do not file the answer itself as a capture.\n`
    : ''
}
${candidateBlocks ? candidateBlocks + '\n\n' : ''}Transcript (verbatim):
"""
${args.transcript}
"""`,
      },
    ],
  } as Anthropic.MessageCreateParamsNonStreaming)

  if (message.stop_reason === 'refusal') {
    throw new Error('planner refused')
  }
  const text = message.content.find((b) => b.type === 'text')
  if (!text || text.type !== 'text') throw new Error('planner returned no text block')

  return JSON.parse(text.text) as Plan
}
