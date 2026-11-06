/**
 * Clarify-by-notification, over Telegram.
 *
 * When the planner is unsure, the alternative to asking is a row sitting in a
 * triage queue until you remember to look — which in practice means never, and
 * a queue nobody drains silently eats captures. A message with a button per
 * plausible table resolves it in the seconds while you still remember what you
 * meant, and each tap is a labelled example for the correction loop.
 *
 * Telegram rather than ntfy.sh: ntfy's free tier meters by source IP, and
 * Cloudflare Workers egress from a pool shared with every other Worker, so the
 * daily quota is exhausted by strangers' traffic (observed: HTTP 429 with
 * "daily message quota reached"). A bot token is its own rate limit.
 */

const API = 'https://api.telegram.org'

/** Telegram caps callback_data at 64 bytes, which a record id plus a key fits inside. */
const CALLBACK_SEPARATOR = ':'

export interface ClarifyOption {
  label: string
  tableKey: string
}

function snippet(text: string, max = 220): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** Telegram treats several characters as markup; the transcript is not markup. */
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

async function telegram(env: Env, method: string, body: unknown): Promise<any> {
  const res = await fetch(`${API}/bot${env.TELEGRAM_BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const json = await res.json().catch(() => ({}))
  if (!res.ok || (json as { ok?: boolean }).ok === false) {
    throw new Error(`telegram ${method} → ${res.status}: ${JSON.stringify(json).slice(0, 200)}`)
  }
  return json
}

export function encodeCallback(captureLogId: string, tableKey: string): string {
  return `${captureLogId}${CALLBACK_SEPARATOR}${tableKey}`
}

export function decodeCallback(data: string): { captureLogId: string; tableKey: string } {
  const idx = data.indexOf(CALLBACK_SEPARATOR)
  if (idx === -1) return { captureLogId: data, tableKey: '' }
  return { captureLogId: data.slice(0, idx), tableKey: data.slice(idx + 1) }
}

/**
 * Ask which table a recording belongs in.
 *
 * Returns false rather than throwing when Telegram is not configured or the
 * send fails — a notification problem should degrade to "it waits in the
 * triage queue", never cost the capture itself.
 */
export async function notifyClarify(
  env: Env,
  args: {
    captureLogId: string
    transcript: string
    heard: string
    options: ClarifyOption[]
    /** 'route' asks where it goes; 'confirm-ignore' asks whether it was meant for us at all. */
    kind?: 'route' | 'confirm-ignore'
  }
): Promise<number | null> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) {
    console.log(JSON.stringify({ event: 'notify.unconfigured' }))
    return null
  }

  const heard = args.heard.trim()
  const confirming = args.kind === 'confirm-ignore'
  const title = confirming
    ? 'Skipped this one — was it meant for you?'
    : heard
      ? `Heard <b>“${escapeHtml(heard)}”</b> — where does this go?`
      : 'Where does this go?'

  // One row per button: labels like "Adventure Learnings" are too wide to sit
  // side by side on a phone.
  const keyboard = [
    ...args.options.map((o) => [
      { text: o.label, callback_data: encodeCallback(args.captureLogId, o.tableKey) },
    ]),
    [
      {
        text: confirming ? '👍 No, skip it' : '🚫 Ignore',
        callback_data: encodeCallback(args.captureLogId, ''),
      },
    ],
  ]

  // Buttons cover the common case; the hint invites the thing people do
  // anyway, which is to answer in words.
  const hint = confirming ? '' : '\n\n<i>Or just reply with a few words — e.g. the trip it belongs to.</i>'

  try {
    const sent = await telegram(env, 'sendMessage', {
      chat_id: env.TELEGRAM_CHAT_ID,
      text: `${title}\n\n<i>${escapeHtml(snippet(args.transcript))}</i>${hint}`,
      parse_mode: 'HTML',
      reply_markup: { inline_keyboard: keyboard },
    })
    return sent?.result?.message_id ?? null
  } catch (err) {
    console.log(JSON.stringify({ event: 'notify.failed', message: String(err) }))
    return null
  }
}

/**
 * Close the loop on a tapped button.
 *
 * `answerCallbackQuery` stops Telegram's spinner — without it the button looks
 * stuck regardless of what happened — and editing the message replaces the
 * question with its answer so the chat reads as a log rather than a pile of
 * unanswered prompts.
 */
export async function acknowledgeTap(
  env: Env,
  args: { callbackQueryId: string; chatId: number | string; messageId: number; text: string }
): Promise<void> {
  try {
    await telegram(env, 'answerCallbackQuery', {
      callback_query_id: args.callbackQueryId,
      text: args.text,
    })
    await telegram(env, 'editMessageReplyMarkup', {
      chat_id: args.chatId,
      message_id: args.messageId,
      reply_markup: { inline_keyboard: [] },
    })
    await telegram(env, 'sendMessage', {
      chat_id: args.chatId,
      text: `✅ ${args.text}`,
      reply_to_message_id: args.messageId,
    })
  } catch (err) {
    // A missing acknowledgement is not worth failing a resolved capture over.
    console.log(JSON.stringify({ event: 'notify.ack_failed', message: String(err) }))
  }
}

/** A message with one button per row; returns its message id, or null if it could not be sent. */
export async function sendWithButtons(
  env: Env,
  text: string,
  buttons: Array<{ text: string; callback_data: string }>
): Promise<number | null> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return null
  try {
    const sent = await telegram(env, 'sendMessage', {
      chat_id: env.TELEGRAM_CHAT_ID,
      text,
      reply_markup: { inline_keyboard: buttons.map((b) => [b]) },
    })
    return sent?.result?.message_id ?? null
  } catch (err) {
    console.log(JSON.stringify({ event: 'notify.failed', message: String(err) }))
    return null
  }
}

/**
 * Answer a tapped button and drop just that one from the message, so the rest
 * of a digest stays tappable.
 */
export async function acknowledgeButton(
  env: Env,
  args: {
    callbackQueryId: string
    chatId: number | string
    messageId: number
    text: string
    keyboard: Array<Array<{ text: string; callback_data?: string }>>
    tapped: string
  }
): Promise<void> {
  try {
    await telegram(env, 'answerCallbackQuery', { callback_query_id: args.callbackQueryId, text: args.text })
    const rest = args.keyboard.map((row) => row.filter((b) => b.callback_data !== args.tapped)).filter((row) => row.length)
    await telegram(env, 'editMessageReplyMarkup', {
      chat_id: args.chatId,
      message_id: args.messageId,
      reply_markup: { inline_keyboard: rest },
    })
  } catch (err) {
    console.log(JSON.stringify({ event: 'notify.ack_failed', message: String(err) }))
  }
}

/** Used by setup to confirm the bot can reach the chat. */
export async function sendPlain(env: Env, text: string): Promise<boolean> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false
  try {
    await telegram(env, 'sendMessage', { chat_id: env.TELEGRAM_CHAT_ID, text })
    return true
  } catch {
    return false
  }
}
