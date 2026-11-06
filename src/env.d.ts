/**
 * Secrets the Worker expects.
 *
 * These cannot be declared in wrangler.jsonc — secrets deliberately have no
 * home in committed config. `wrangler types` infers them from .env, which is
 * gitignored, so a fresh clone would otherwise generate an empty Env and fail
 * `npm run typecheck` for reasons that look nothing like the real cause.
 *
 * Declaring them here keeps the typecheck reproducible from a clean checkout.
 * This is not the hand-written-bindings anti-pattern: real bindings live in
 * wrangler.jsonc and stay generated. Nothing here can drift from config,
 * because none of it is in config.
 *
 * Set them for real with:  npx wrangler secret put <NAME>
 * For local `wrangler dev`, the same keys in .env are picked up automatically.
 */
declare global {
  interface Env {
    /** Shown once by Pocket when the webhook is created. */
    POCKET_WEBHOOK_SECRET: string
    /** pk_... from the Pocket app. */
    POCKET_API_KEY: string
    /** Planner. */
    ANTHROPIC_API_KEY: string
    /** Telegram bot token from @BotFather. */
    TELEGRAM_BOT_TOKEN: string
    /** The chat the bot talks to — your own user id. */
    TELEGRAM_CHAT_ID: string
    /** Shared secret Telegram echoes back on every webhook call. */
    TELEGRAM_WEBHOOK_SECRET: string
    /** Optional model override for the planner. Defaults to claude-opus-5. */
    PLANNER_MODEL?: string
    /** This Worker's own origin, used to build notification button URLs from cron. */
    WORKER_URL?: string
    /** The app Worker's Cloudflare Access application: its team domain (x.cloudflareaccess.com) and AUD tag. */
    ACCESS_TEAM_DOMAIN?: string
    ACCESS_AUD?: string
    /** Local `wrangler dev` only (.dev.vars): skip the Access check. Never set on a deployed Worker. */
    DEV_NO_AUTH?: string
  }
}

export {}
