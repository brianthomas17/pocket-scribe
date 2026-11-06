/**
 * The storage interface every part of the Worker talks to.
 *
 * Callers name tables and fields exactly as schema.json does, and describe
 * what they want with structured conditions, never SQL. D1 (./d1.ts) is the
 * one implementation; the interface is what keeps the rest of the code from
 * knowing how records are stored.
 */

export interface StoreRecord {
  id: string
  fields: Record<string, unknown>
  createdTime?: string
}

export interface StoreField {
  id: string
  name: string
  type: string
  options?: { choices?: Array<{ id: string; name: string }> }
}

/** One table as the backend actually has it — chiefly, which select choices exist. */
export interface StoreTable {
  id: string
  name: string
  primaryFieldId: string
  fields: StoreField[]
}

/**
 * One condition on one field. Every query the Worker makes is a conjunction of
 * these; nothing needs OR.
 */
export type Where =
  /** Non-empty: a ticked checkbox, non-blank text, a non-zero number. */
  | { field: string; truthy: true }
  /** Exact match. */
  | { field: string; equals: string }
  /** Trimmed, case-insensitive match. */
  | { field: string; equalsIgnoringCase: string }
  /** A date or dateTime falling on this YYYY-MM-DD (UTC). */
  | { field: string; sameDay: string }
  /** Anything but blank. */
  | { field: string; notBlank: true }

export interface Query {
  where?: Where[]
  /** Only these fields are needed. A hint: a backend may return more. */
  fields?: string[]
  /** Sort by this field; blanks sort first ascending, last descending. */
  sort?: string
  /** Defaults to desc — most callers want the newest rows. */
  direction?: 'asc' | 'desc'
  limit?: number
}

/** Who made a change. Recorded with every edit on backends that keep history. */
export type Actor = 'system' | 'you' | 'import'

export interface Store {
  /** Tables as stored, with the select choices that exist right now. */
  schema(): Promise<StoreTable[]>
  /** Throws when the record does not exist. */
  get(table: string, id: string): Promise<StoreRecord>
  list(table: string, query?: Query): Promise<StoreRecord[]>
  create(table: string, fields: Record<string, unknown>, by?: Actor): Promise<StoreRecord>
  /** Merges: fields not named are left alone; a null value clears a field. */
  update(table: string, id: string, fields: Record<string, unknown>, by?: Actor): Promise<StoreRecord>
}
