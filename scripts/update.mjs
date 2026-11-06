#!/usr/bin/env node
/**
 * Get the latest version and deploy it.
 *
 *   npm run update             pull, install, test, migrate, deploy both Workers
 *   npm run update -- --check  show what is new, change nothing
 *
 * Only shared files change. Your trackers (schema.json), keys and ids (.env)
 * and the wrangler configs made from them are not tracked by git, so nothing
 * an update brings can overwrite them. If you have changed shared files
 * yourself, it stops rather than mixing the two: merge by hand (or ask your
 * AI) and run it again.
 */

import { spawnSync } from 'node:child_process'
import { ROOT } from './lib.mjs'

const CHECK = process.argv.includes('--check')

const run = (cmd, args, { quiet = false } = {}) => {
  const res = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', stdio: quiet ? 'pipe' : 'inherit' })
  if (res.status !== 0) {
    if (quiet) process.stderr.write(`${res.stdout ?? ''}${res.stderr ?? ''}`)
    console.error(`\n✗ \`${cmd} ${args.join(' ')}\` failed. Nothing after it ran; your Workers are as they were.\n`)
    process.exit(1)
  }
  return (res.stdout ?? '').trim()
}
const step = (s) => console.log(`\n==> ${s}`)

step('Checking for changes of your own')
const local = run('git', ['status', '--porcelain', '--untracked-files=no'], { quiet: true })
if (local) {
  console.error(`\n✗ These shared files have changes of your own:\n\n${local}\n\nCommit them and merge the update yourself (git pull), or undo them (git checkout -- <file>). Then run this again.\n`)
  process.exit(1)
}

step('Fetching')
run('git', ['fetch', '--quiet'])
const incoming = run('git', ['log', '--oneline', 'HEAD..@{u}'], { quiet: true })
if (!incoming) {
  console.log('Already up to date.')
  process.exit(0)
}
console.log(`New since your version:\n${incoming.split('\n').map((l) => `  ${l}`).join('\n')}`)
if (CHECK) {
  console.log('\nNothing changed. Run `npm run update` to install it.')
  process.exit(0)
}

step('Pulling')
run('git', ['pull', '--ff-only', '--quiet'])
step('Installing')
run('npm', ['install', '--no-audit', '--no-fund'])
step('Testing')
run('npm', ['test'], { quiet: true })
console.log('✓ tests passed')
step('Writing the wrangler configs')
run('node', ['scripts/config.mjs'])
step('Updating the database')
run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'pocket-scribe', '--remote'])
step('Deploying the capture Worker')
run('npx', ['wrangler', 'deploy'])
step('Deploying the app')
run('npx', ['wrangler', 'deploy', '-c', 'wrangler.app.jsonc'])
console.log('\n✓ Up to date and deployed.\n')
