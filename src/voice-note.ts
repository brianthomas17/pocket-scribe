/**
 * Which Telegram messages are voice notes, worked out from the message alone,
 * so it can be tested without a Worker. voice.ts files them.
 */

/** Telegram bots can download files up to this size. */
export const TELEGRAM_MAX_BYTES = 20 * 1024 * 1024
export interface VoiceNote {
  /** Recording ID in Capture Log: tg- plus the chat and message, so it cannot collide with Pocket's. */
  id: string
  fileId: string
  mime: string
  seconds: number
  bytes: number
  caption: string
  at: string
}

interface TelegramAudio {
  file_id: string
  mime_type?: string
  duration?: number
  file_size?: number
}

export interface TelegramMessage {
  message_id: number
  date: number
  chat: { id: number }
  caption?: string
  voice?: TelegramAudio
  audio?: TelegramAudio
  document?: TelegramAudio
}

/** The note in a Telegram message, if it carries audio. */
export function voiceNoteFrom(msg: TelegramMessage): VoiceNote | null {
  const doc = msg.document?.mime_type?.startsWith('audio/') ? msg.document : undefined
  const file = msg.voice ?? msg.audio ?? doc
  if (!file) return null
  return {
    id: `tg-${msg.chat.id}-${msg.message_id}`,
    fileId: file.file_id,
    mime: file.mime_type ?? (msg.voice ? 'audio/ogg' : 'audio/mpeg'),
    // Telegram leaves duration off documents; unknown counts as long.
    seconds: file.duration ?? Infinity,
    bytes: file.file_size ?? 0,
    caption: (msg.caption ?? '').trim(),
    at: new Date(msg.date * 1000).toISOString(),
  }
}
