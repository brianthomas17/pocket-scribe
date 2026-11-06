/**
 * The morning to-do digest, and what a ✓ tap on it does.
 *
 * Sent from the cron once a day, at the first poll after DIGEST_HOUR in
 * TIMEZONE.
 */

import { acknowledgeButton, sendPlain, sendWithButtons } from './notify'
import { claimDailyRun, claimOnce, releaseOnce } from './state'
import { dueEvents, eventMessages, onThisDay, onThisDayMessage } from './reminders'
import { BACKUP_WARN_BYTES, nightlyBackup } from './backup'
import { store } from './store'
import { allTasks, digest, localNow, setDone, taskTable, TASK_CALLBACK } from './tasks'
import type { Schema } from './planner'

const DEFAULT_HOUR = 8

const log = (event: string, data: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...data }))

export async function sendTaskDigest(env: Env, schema: Schema, at = new Date()): Promise<void> {
  const t = taskTable(schema)
  if (!t) return
  const tz = env.TIMEZONE || 'UTC'
  const { day, hour } = localNow(tz, at)
  if (hour < (Number(env.DIGEST_HOUR) || DEFAULT_HOUR)) return
  if (!(await claimDailyRun(env, 'task-digest', day))) return

  const message = digest(await allTasks(store(env), t), day, env.APP_URL)
  if (!message) {
    log('digest.nothing_due', { day })
    return
  }
  const sent = await sendWithButtons(env, message.text, message.buttons)
  log('digest.sent', { day, tasks: message.buttons.length, delivered: sent !== null })
}

/**
 * The morning reminders that replaced the Airtable automations: event
 * reminders and "on this day". Same hour gate as the digest; each event mark
 * and each anniversary is claimed once, so a reminder is never sent twice.
 */
export async function sendMorningReminders(env: Env, schema: Schema, at = new Date()): Promise<void> {
  if (!schema.reminders) return
  const tz = env.TIMEZONE || 'UTC'
  const { day, hour } = localNow(tz, at)
  if (hour < (Number(env.DIGEST_HOUR) || DEFAULT_HOUR)) return
  if (!(await claimDailyRun(env, 'reminders', day))) return
  const s = store(env)

  const events = schema.reminders.events
  if (events) {
    for (const due of dueEvents(events, await s.list(events.table), day)) {
      const key = `event:${due.event.toLowerCase()}:${due.mark}`
      if (!(await claimOnce(env, key))) continue
      let delivered = true
      for (const text of eventMessages(events, due)) delivered = (await sendPlain(env, text)) && delivered
      // Not delivered: let tomorrow's run try again while the window is open.
      if (!delivered) await releaseOnce(env, key)
      log('reminder.event', { name: due.event, mark: due.mark, adventures: due.adventures.length, delivered })
    }
  }

  const otd = schema.reminders.onThisDay
  const table = otd && schema.tables.find((t) => t.key === otd.table || t.name === otd.table)
  if (otd && table) {
    for (const { years, record } of onThisDay(otd, await s.list(table.name), day)) {
      if (!(await claimOnce(env, `onthisday:${record.id}:${years}`))) continue
      let delivered = true
      for (const text of onThisDayMessage(table, otd, years, record)) delivered = (await sendPlain(env, text)) && delivered
      log('reminder.on_this_day', { recordId: record.id, years, delivered })
    }
  }
}

/** The nightly copy runs at the first poll after this hour, in TIMEZONE. */
const BACKUP_HOUR = 3

/**
 * The nightly copy to R2. Silent when it works; one Telegram message a day when
 * it fails, and one ever (well, once a day) if backups grow past 1 GB.
 */
export async function runNightlyBackup(env: Env): Promise<void> {
  const { day, hour } = localNow(env.TIMEZONE || 'UTC')
  if (hour < BACKUP_HOUR || !env.BACKUPS) return
  if (!(await claimDailyRun(env, 'backup', day))) return
  try {
    const result = await nightlyBackup(env, day)
    log('backup.done', result)
    if (result.totalBytes > BACKUP_WARN_BYTES && (await claimDailyRun(env, 'backup-size', day))) {
      await sendPlain(env, `Backups now take ${(result.totalBytes / 1024 ** 3).toFixed(1)} GB of R2 storage (free up to 10 GB). Nothing is wrong yet, but it is growing faster than expected.`)
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    log('backup.failed', { message })
    // Let the next poll try again rather than waiting a whole day.
    await env.STATE.delete('daily:backup')
    if (await claimDailyRun(env, 'backup-failed-alert', day)) {
      await sendPlain(env, `Last night's backup didn't save: ${message.slice(0, 300)}\n\nYour entries are fine; only the copy failed. It will keep retrying.`)
    }
  }
}

export const isTaskTap = (data: string) => data.startsWith(TASK_CALLBACK)

/** Mark the task done and take its button off the message. */
export async function handleTaskTap(
  env: Env,
  schema: Schema,
  q: {
    id: string
    data: string
    message: { message_id: number; chat: { id: number }; reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> } }
  }
): Promise<void> {
  const t = taskTable(schema)
  const id = q.data.slice(TASK_CALLBACK.length)
  let text = 'Could not find that to-do'
  try {
    if (t) text = `Done: ${(await setDone(store(env), t, id, true)).title}`
  } catch (err) {
    log('digest.tap_failed', { id, message: err instanceof Error ? err.message : String(err) })
  }
  await acknowledgeButton(env, {
    callbackQueryId: q.id,
    chatId: q.message.chat.id,
    messageId: q.message.message_id,
    text,
    keyboard: q.message.reply_markup?.inline_keyboard ?? [],
    tapped: q.data,
  })
}
