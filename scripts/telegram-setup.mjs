#!/usr/bin/env node
/**
 * Connect a Telegram bot to the Worker.
 *
 * Discovers your chat id, generates the webhook secret, registers the webhook
 * with Telegram, and sends a test message. Safe to re-run — registering the
 * same webhook twice is a no-op, and a fresh secret simply replaces the old.
 *
 *   1. In Telegram, message @BotFather → /newbot → follow the prompts
 *   2. Put the token it gives you in .env as TELEGRAM_BOT_TOKEN=...
 *   3. Send your new bot any message (say "hi") so it can learn your chat id
 *   4. npm run telegram:setup
 */

import { readFileSync, appendFileSync, existsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomBytes } from 'node:crypto'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENV = resolve(ROOT, '.env')

const useColor = process.stdout.isTTY && !process.env.NO_COLOR
const c = (code, s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s)
const ok = (s) => console.log(`  ${c('32', '✓')} ${s}`)
const info = (s) => console.log(`  ${c('2', '·')} ${c('2', s)}`)

function fail(message, remedy) {
  console.error(`\n${c('31', c('1', '✗ ' + message))}`)
  if (remedy) console.error(`\n${remedy}\n`)
  process.exit(1)
}

function readEnv() {
  if (!existsSync(ENV)) fail('.env not found', `Expected it at ${ENV}`)
  const out = {}
  for (const line of readFileSync(ENV, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (m && m[2].trim()) out[m[1]] = m[2].trim().replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

function setEnv(key, value) {
  const body = readFileSync(ENV, 'utf8')
  if (new RegExp(`^${key}=`, 'm').test(body)) {
    writeFileSync(ENV, body.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`))
  } else {
    appendFileSync(ENV, `${key}=${value}\n`)
  }
}

async function api(token, method, body) {
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const json = await res.json().catch(() => ({}))
  if (!json.ok) {
    throw new Error(`${method}: ${json.description ?? res.status}`)
  }
  return json.result
}

const env = readEnv()
const token = env.TELEGRAM_BOT_TOKEN
if (!token) {
  fail(
    'TELEGRAM_BOT_TOKEN is not set in .env',
    [
      'In Telegram:',
      '  1. Message @BotFather and send /newbot',
      '  2. Pick a name and a username ending in "bot"',
      '  3. Copy the token it gives you (looks like 123456789:AAE...)',
      '',
      'Then put it in .env:',
      '  TELEGRAM_BOT_TOKEN=123456789:AAE...',
    ].join('\n')
  )
}

const workerUrl = env.WORKER_URL
if (!workerUrl) fail('WORKER_URL is not set in .env')

console.log(`\n${c('1', 'Connecting Telegram')}`)

const me = await api(token, 'getMe')
ok(`bot is @${me.username}`)

// A webhook, once registered, consumes updates — so read the chat id before
// registering, or getUpdates will always come back empty.
let chatId = env.TELEGRAM_CHAT_ID
if (!chatId) {
  await api(token, 'deleteWebhook').catch(() => {})
  const updates = await api(token, 'getUpdates', { limit: 10 })
  const withChat = updates.map((u) => u.message ?? u.callback_query?.message).filter(Boolean)
  if (!withChat.length) {
    fail(
      'no messages found, so the bot does not know where to send',
      `Open Telegram, find @${me.username}, and send it any message. Then re-run this.`
    )
  }
  chatId = String(withChat[withChat.length - 1].chat.id)
  setEnv('TELEGRAM_CHAT_ID', chatId)
  ok(`chat id ${chatId} (saved to .env)`)
} else {
  info(`chat id ${chatId} (already in .env)`)
}

let secret = env.TELEGRAM_WEBHOOK_SECRET
if (!secret) {
  secret = randomBytes(24).toString('hex')
  setEnv('TELEGRAM_WEBHOOK_SECRET', secret)
  ok('generated TELEGRAM_WEBHOOK_SECRET (saved to .env)')
}

await api(token, 'setWebhook', {
  url: `${workerUrl}/telegram`,
  secret_token: secret,
  // Button taps and typed replies. Without 'message' the bot never receives
  // what you type, which silently swallows every answer given in words.
  allowed_updates: ['callback_query', 'message'],
})
ok(`webhook registered → ${workerUrl}/telegram`)

await api(token, 'sendMessage', {
  chat_id: chatId,
  text: 'pocket-scribe is connected. When a recording is ambiguous, it will ask you here.',
})
ok('test message sent — check Telegram')

console.log(`\n${c('32', c('1', 'Done.'))} Push these to the Worker:\n`)
console.log('  npm run secrets\n')
