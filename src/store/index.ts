/** The store the Worker and the app use: every record, in D1. */

import { d1Store } from './d1'
import type { Schema } from '../planner'
import type { Store } from './types'
import rawSchema from '../../schema.json'

export type { Store, StoreRecord, StoreTable, Query, Where, Actor } from './types'

export function store(env: Env): Store {
  return d1Store(env.DB, rawSchema as unknown as Schema)
}
