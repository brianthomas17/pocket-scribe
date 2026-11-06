#!/usr/bin/env node
/**
 * Write wrangler.jsonc and wrangler.app.jsonc from the templates and .env.
 *
 *   npm run config
 *
 * Every deploy runs this first, so a shared setting changed by an update
 * reaches your Workers. `npm run setup` puts the ids it finds into .env.
 */

import { loadDotEnv, writeConfigs } from './lib.mjs'

loadDotEnv()
const { missing, written } = writeConfigs()
if (missing.length) {
  console.error(`\n✗ .env has no ${missing.join(', ')}. Run \`npm run setup\` first: it finds or creates them.\n`)
  process.exit(1)
}
if (written.length) console.log(`✓ wrote ${written.join(' and ')}`)
