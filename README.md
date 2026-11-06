# pocket-scribe

Talk into a [Pocket](https://heypocket.com) recorder, say what kind of thought it
is, and have it land in the right tracker — then read, fix and add to it in a
small app on your phone.

```
"Dream log. I was back in the house on Oak Street and..."   → Dreams, new entry
"Todo list. Call insurance, email Greg, by Friday"           → To-Dos, two tasks due Friday
"Adventure learnings, Burning Man 26 — get metal canteens"   → appended to that trip
"Journal entry. Three gratitudes: ..."                       → today's journal entry
"I called the insurance company"                             → that to-do, ticked done
```

Everything is yours: your Cloudflare account, your keys, your data. There is no
service in the middle. Setting it up for someone else means they run their own
copy: see **[SETUP.md](SETUP.md)**. Updates come with `npm run update`, and never
touch your trackers.

## What you get

| | |
|---|---|
| **Capture** | Pocket is polled every 2 minutes; Claude files each recording into the right tracker, merging into today's journal or an existing trip instead of duplicating |
| **The app** | Today (with "on this day" from earlier years), every tracker with search, an editor with full history, typed entries, a review queue. Behind a Cloudflare Access login |
| **To-dos** | Deadlines, a task screen, and a 9am Telegram digest of what's overdue, due today and due tomorrow, with a ✓ button on each |
| **Telegram** | Asks where an unclear recording belongs (answer with a button or in words); sends the digest and reminders. Send it a voice message or an audio file and it is filed like a Pocket recording |
| **Reminders** | A month before each recurring event, every past year's learnings for it; the journal entry from a year ago today |
| **Learning** | Every correction (a Telegram answer, an edit in the app, a Redo) becomes an example the planner reads next time |

## How it works

```
Pocket device ──sync──▶ Pocket cloud ──┬── cron poll (2 min) ─▶ capture Worker ◀──▶ Telegram
                                        └── webhook (bonus) ───▶       │
                                                                       │ planner (Claude)
                                                                       ▼
                                   app Worker (Access login) ◀──▶ D1 database
```

- **The transcript is stored verbatim with every capture.** Any bad filing can be
  redone from it.
- **Polling is the primary path.** Pocket's webhook has broken repeatedly and
  exposes no delivery log; at two minutes, whether it is alive stops mattering.
- **The planner proposes; `apply.ts` decides.** Unknown and non-writable fields
  are dropped at write time, so a confused planner can only write less than
  intended.
- **Recordings that never addressed the system are dropped**, but only when the
  planner is confident. Otherwise it asks.
- **Every change is kept.** Each edit, by you or the system, is in the `edits`
  table with its before and after; deleting keeps a copy there too.

## Layout

| Path | |
|---|---|
| `src/` | the capture Worker: poll, webhook, Telegram, planner, digest, reminders |
| `src/store/` | storage: every tracker in one D1 table as JSON, described by `schema.json` |
| `app/` | the app Worker |
| `migrations/` | the D1 tables |
| `schema.json` | your trackers: tables, fields, vocabulary, reminders. Yours: untracked, and in every backup |
| `trackers/` | the tracker menu a new install chooses from (`npm run trackers`), and the shared base |
| `wrangler.template.jsonc`, `wrangler.app.template.jsonc` | shared Worker settings; `npm run config` fills in your ids from `.env` to make `wrangler.jsonc` and `wrangler.app.jsonc` (untracked) |
| `scripts/` | `setup`, `trackers`, `update`, `config`, `secrets`, `telegram-setup`, `backup`, `restore`, and the tests |

## Day to day

```bash
npm run tail        # watch it work
npm test            # validates schema.json, then the store, forms, to-dos and reminders
npm run deploy      # capture Worker
npm run deploy:app  # app
npm run backup      # save a backup of every entry to backups/
npm run update      # get the latest version and deploy it
```

Wrangler authenticates with the `CLOUDFLARE_API_TOKEN` in this repo's `.env`, not
your global `wrangler login`, so this repo always deploys to its own account.

Run the app locally against a local database with
`npx wrangler dev -c wrangler.app.jsonc --var DEV_NO_AUTH:1` (the login check is
skipped only on localhost).

## Fixing what it got wrong

- **Answer in Telegram.** When it asks, reply in words rather than tapping:
  "burning man 26" names the table and the record at once.
- **Edit it in the app.** Changing something the planner wrote records the
  correction as you save.
- **Refile it.** In the app's Review, file a recording into a table; or tick
  **Redo** on its Capture Log entry (optionally with a table in Target Table)
  and it is re-filed within a day. Refiling creates a new entry; delete the old
  one if it is wrong.

## Cost

Cloudflare's free plan covers the Workers, D1, KV, R2, Workers AI and Access (up to 50 users).
Telegram is free. Workers AI's free allowance covers a few hours a day of
transcribing what Pocket didn't. The only running cost is pay-as-you-go
Anthropic API usage, one planner call per recording.

### Privacy

Transcripts go to the Anthropic API for filing. Everything else stays in your
Cloudflare account, and nothing is shared with anyone running their own copy.
Worth knowing before pointing a dream journal at it.

## When Pocket doesn't transcribe

Since late October 2026 Pocket often leaves a recording "pending" until you
tap Summarize in its app, and its API has no way to ask for a transcript. So a
recording still unfinished after ten minutes is downloaded and transcribed here,
on Workers AI in your own Cloudflare account. Recordings over an
hour are left to Pocket, and you're told once, on Telegram, to tap Summarize.

## Voice messages

For when the Pocket is the wrong microphone (walking in wind, or a better mic
plugged into your phone), hold the mic button in the bot's chat and talk, or
send it an audio file up to 20 MB. A caption counts as part of what you said,
so "journal" typed under a voice note routes it. The bot replies with where it
went. Short audio is transcribed with Deepgram Nova-3, long audio with Whisper,
both on Workers AI.

## Known external failure

Pocket's device → phone → cloud sync can stall silently, and then there is
nothing to poll. After three quiet days the Worker sends one Telegram nudge. On
Android, set **Settings → Apps → Pocket → Battery → Unrestricted**; battery
optimization killing background sync is the likeliest cause.
