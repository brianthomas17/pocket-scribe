# Setup

Written to be followed step by step, by a person or by an agent. Every step ends
with something you can check. **Do not continue past a step whose check fails**:
later steps assume the earlier ones worked, and the usual failure of automated
setup is confidently building on a half-broken base.

Everything runs in **your own accounts**. Nothing is shared with whoever gave you
this code, and there is no service in the middle. That is deliberate: this holds
a journal.

| You'll end up with | |
|---|---|
| A capture Worker | polls Pocket every 2 minutes and files each recording with Claude |
| An app | read, type and fix entries; to-dos; a review queue. Behind a login only you pass |
| A Telegram bot | asks when unsure, sends the morning to-do digest and reminders |
| A D1 database | every record, in your Cloudflare account |

All of it fits in Cloudflare's free plan. The only running cost is pay-as-you-go
Anthropic API usage, one call per recording.

---

## Preconditions

| Need | Check |
|---|---|
| Node 22 or newer (Cloudflare's tools require it) | `node -v` |
| git, so updates can reach you | `git --version` |
| A Cloudflare account (free) | you can sign in at dash.cloudflare.com |
| A Pocket recorder, and its API key | Pocket app → Settings → API key (`pk_…`) |
| An Anthropic API key, with billing set up | console.anthropic.com → API keys; Billing shows a credit balance |
| Telegram on your phone | — |

---

## Step 1 — Get the code

Clone the repository you were given a link to, then in that folder:

```bash
git clone <the link> pocket-scribe
cd pocket-scribe
npm install
cp .env.example .env
```

`.env` holds your keys; Step 4 makes `schema.json`, your trackers. git ignores
both: they are yours, and an update never touches them.

**Check:** `npm test` ends with two `✓ … passed` lines.

---

## Step 2 — Cloudflare

Four things in the Cloudflare dashboard, once each.

1. **A workers.dev subdomain.** Open **Workers & Pages**. If it asks you to
   pick a subdomain, pick one; that's where your Workers will live.
2. **Zero Trust**, which puts the app behind a login. Open **Zero Trust**, choose
   a team name (anything), and pick the **Free** plan. It may ask for a payment
   method even for the Free plan, which covers up to 50 users; there is no other
   way to put the app behind a login.
3. **R2**, where the nightly backups go. Open **R2 Object Storage** and enable
   it. It asks for a payment method; backups stay far inside the free 10 GB (one
   night's copy of a year's journal is well under 1 MB).
4. **An API token for this project.** **My Profile → API Tokens → Create
   Token → "Edit Cloudflare Workers"** template (**Use template**). Click **+ Add
   more** under Permissions and add these three rows:

   | Permission | Why |
   |---|---|
   | Account · D1 · Edit | the database |
   | Account · Access: Apps and Policies · Edit | the app's login |
   | Account · Access: Organizations, Identity Providers, and Groups · Read | finds your login page's address |

   Under **Account Resources**, pick only your account. Leave **Zone Resources**
   as the template has it (this project uses no domain of yours). **Continue
   to summary → Create Token**, and copy it; Cloudflare shows it once.

Fill in these two lines in `.env` (they're already there, blank): the token,
and your account id, the 32-character id in the dashboard's address bar
(`dash.cloudflare.com/<account id>/…`):

```
CLOUDFLARE_API_TOKEN=…
CLOUDFLARE_ACCOUNT_ID=…
```

Wrangler reads these from `.env` itself. **Never export `CLOUDFLARE_*` in your
shell profile**: a shell value overrides `.env` and can point a deploy at the
wrong account.

**Check:** `npx wrangler whoami` says *API Token* and lists exactly your account.
If it says *OAuth Token*, it isn't reading `.env`: run it from this folder, and
check the line has no spaces or quotes around the value.

---

## Step 3 — Fill in the rest of .env

Fill in these existing lines:

| Line | What goes there |
|---|---|
| `OWNER_EMAIL` | The email you sign in to Cloudflare with. It's who the app lets in. |
| `TIMEZONE` | Yours, for the morning digest, e.g. `America/Los_Angeles`. Blank uses this computer's. |
| `POCKET_API_KEY` | `pk_…` from the Pocket app |
| `ANTHROPIC_API_KEY` | `sk-ant-…` |

The Telegram lines get filled in Step 7, and `WORKER_URL` in Step 5.

---

## Step 4 — Choose your trackers

A tracker is a list the system files into: a journal, your to-dos, notes about
people. Choose any mix of ready-made ones and your own.

**From the menu.** See it with `npm run trackers`:

| | Tracker | What it's for |
|---|---|---|
| Suggested | `journal` | Daily entries and gratitudes; a year later, that day's entry comes back |
| | `todos` | Deadlines, a 9am Telegram digest, ✓ buttons; "I did X" ticks one off |
| | `thoughts` | Ideas, notes to self, anything worth keeping that isn't a task |
| Optional | `dreams` | A dream log |
| | `adventures` | Lessons from trips and events, sent back a month before you go again |
| | `bucket_list` | Things to do someday, ticked off when they happen |
| | `people` | What's going on with the people in your life, birthdays, gift ideas |
| | `recommendations` | Books, shows and places people tell you about, and who said so |

```bash
npm run trackers -- start --suggested             # the suggested three
npm run trackers -- start journal todos people    # or exactly the ones you want
npm run trackers -- add dreams                     # add more any time
npm run trackers -- remove dreams                  # or take one out
```

**Your own.** Want something the menu doesn't have, such as workouts, a
reading log, or symptoms? Describe it to your AI in plain words ("each workout:
what I did, how long, how it felt") and have it add a tracker to `schema.json`
following *Editing the schema* below. The menu's trackers are good examples to
copy from.

Either way, read each tracker's **`vocabulary`** in `schema.json` and change
it to the words you'll actually say ("dream log", "todo list"…): that's how a
recording finds its way. Everything here can change later; deploy afterwards.

**Check:** `npm test` still passes; it validates `schema.json`.

---

## Step 5 — Set up Cloudflare

```bash
npm run setup
```

This creates the KV namespace, the D1 database and the R2 bucket for backups,
creates the Access application
that lets only `OWNER_EMAIL` into the app, records all their ids in `.env`,
writes `wrangler.jsonc` and `wrangler.app.jsonc` from their templates, and
creates the database tables. It is safe to run again; it reuses whatever it already
made. `npm run setup -- --check` shows what it would do without doing it.

**Check:** it ends with `✓ Cloudflare is ready.` and prints two addresses, the
capture Worker and the app.

If it stops at something flagged `!`, fix that one thing and run it again. Don't
deploy the app until it finishes cleanly; it can't let anyone in before then.

---

## Step 6 — Deploy

```bash
npm run deploy
npm run deploy:app
```

**Check:**

- the capture Worker's address answers `pocket-scribe is listening`
- the app's address shows a Cloudflare Access sign-in page. Choose
  **Cloudflare** and sign in with your Cloudflare account (`OWNER_EMAIL`). You
  should land on **Today**.

To sign in with an emailed code instead, which is handier on a phone (or if the
sign-in page offers no option at all): Zero Trust → Settings → Authentication →
Login methods → Add → **One-time PIN**.

Until Step 8 the capture Worker runs without its keys, so errors in
`npm run tail` before then are expected.

---

## Step 7 — Telegram

Telegram is how it asks you where an unclear recording belongs, and how the
morning digest and reminders arrive.

1. In Telegram, message **@BotFather** → `/newbot` → follow the prompts.
2. Put the token in `.env` as `TELEGRAM_BOT_TOKEN`.
3. **Send your new bot any message.** It can't learn your chat id until you
   speak first.
4. Run `npm run telegram:setup`. It finds your chat id, generates the webhook
   secret, connects the bot to your Worker, and sends a test message.

**Check:** the test message arrives. (Replying or tapping buttons does nothing
until Step 8 gives the Worker its keys.)

Only your chat can answer the bot; messages from anyone else are ignored. It
learns which chat is yours from the most recent message, so be the only one who
has messaged a brand-new bot when you run this.

---

## Step 8 — Push the secrets

```bash
npm run secrets
```

`.env` never leaves your computer on its own (`wrangler deploy` doesn't upload
it), so this copies the keys each Worker needs onto it.

**Check:** it reports `7/7 pushed` (`8/8` if you set the optional webhook
secret) with no `✗` or `!` lines, and
within two minutes `npm run tail` shows a poll (`*/2 * * * *`, outcome `ok`). An
idle poll logs nothing else; that is the healthy case.

**Then try it:** record "Journal entry. Testing my new setup" on the Pocket.
Once Pocket has synced it, it appears on the app's **Today** within a couple of
minutes.

---

## Optional — the Pocket webhook

Polling is the primary path; nothing depends on the webhook, but it makes
captures near-instant when it works. In the Pocket app's webhook settings, paste
your `WORKER_URL`. Pocket shows the signing secret once: put it in `.env` as
`POCKET_WEBHOOK_SECRET` and run `npm run secrets` again. Until the secret is
pushed, deliveries are rejected; the poller picks them up anyway.

---

## Editing the schema

`schema.json` is the single source of truth for tables, fields, and the spoken
vocabulary that routes a recording to a table. Every table lives in the same D1
table as JSON, so **adding a tracker or a field is just an edit here and a
deploy**. There is no migration, and the app draws its forms from this file.

Rules `npm test` enforces:

- Field names are case-insensitively unique within a table.
- Field types are one of: `singleLineText`, `multilineText`, `richText`, `date`,
  `dateTime`, `number`, `checkbox`, `singleSelect`, `multipleSelects`, `email`,
  `url`, `phoneNumber`.
- Every field named elsewhere (`appendTarget`, `resolveBy`, `lifecycleFields`,
  `candidateFields`, `roles`, `reminders`) exists on its table.
- The `capture_log` and `corrections` tables exist with the fields the Worker
  writes. Leave those two alone.

Select fields need no preset choices; a new one exists the moment it is used.

Per-table keys:

| Key | Meaning |
|---|---|
| `vocabulary` | Spoken phrases that route to this table |
| `operations` | Which of `create` / `append` / `update` the planner may do; empty for system tables |
| `conventions` | How you use the table, in plain sentences, passed to the planner |
| `appendTarget` | Field that `append` adds a bullet to |
| `resolveBy` | Field used to find an existing record to add to instead of duplicating (e.g. the journal's Date: one row per day) |
| `candidateFields` / `candidateLimit` / `candidateSort` | Which existing records the planner sees, so it can update one instead of creating another |
| `lifecycleFields` | Fields whose edits are not lessons for the planner (ticking a to-do done is you using it, not a correction) |
| `roles` | Which field is the `date`, `title`, `body`; `due` + `done` make a table a to-do list |

`reminders` (top level) configures the morning Telegram reminders:

- `events`: about a month before a recurring event, every past year's learnings
  for it. It triggers `monthsAfter` months after the event's newest entry, then
  every year, for events whose newest entry has `optInField` ticked.
- `onThisDay`: the entry from exactly N `years` ago.

Remove either one to turn it off.

---

## Backups

Three layers, each for a different kind of loss:

| Layer | Where | Automatic | Protects against |
|---|---|---|---|
| Restore history | Inside D1 | Always on | A bad change in the last few days: roll back to an earlier moment |
| Nightly copy | Your R2 bucket | Every night after 3am (`TIMEZONE`); 30 nightly copies plus one a month, kept | The database being deleted or corrupted, or a mistake noticed too late for the restore history |
| Your own copy | Anywhere you choose | You download it | Losing access to your Cloudflare account |

Every backup also carries your trackers (`schema.json`), so a backup alone is
enough to rebuild on a new computer.

The nightly copy is silent when it works; a Telegram message says if one fails.
For your own copy:

- **In the app:** Tables → **Download a backup** saves every entry and its whole
  edit history as one file. Put it wherever you keep important files.
- **From this folder:** `npm run backup` saves the same file into `backups/`
  (gitignored).

To put a backup back:

```bash
npm run restore -- backups/pocket-scribe-backup-2026-10-28.json.gz --db pocket-scribe          # shows what would happen
npm run restore -- backups/pocket-scribe-backup-2026-10-28.json.gz --db pocket-scribe --yes    # replaces the database
```

Restoring replaces everything in the database with the backup, then checks every
record and edit against the file. Run `npm run backup` first if what's there now
matters. On a computer with no `schema.json`, it writes yours from the backup.

---

## Updates

```bash
npm run update -- --check   # what's new, changing nothing
npm run update              # get it: pull, install, test, update the database, deploy both
```

An update changes only shared files. Your trackers (`schema.json`), your keys
and ids (`.env`), and the wrangler configs made from them are untracked, so it
can't overwrite them. A new feature that needs a field your trackers don't have
says so in its notes rather than adding it for you.

If you've changed the code yourself, `npm run update` stops instead of mixing
your changes with the update: `git pull` and merge them (your AI can help),
then run it again.

---

## Day to day

```bash
npm run tail        # watch it work
npm test            # after editing schema.json
npm run deploy      # after editing schema.json or the code (capture Worker)
npm run deploy:app  # …and the app
```

---

## Troubleshooting

| Message | Cause | Fix |
|---|---|---|
| `Authentication error [code: 10000]` | Wrangler is using a credential without access to this account or permission: no `CLOUDFLARE_API_TOKEN` in `.env`, one exported in the shell, or a token missing a row from Step 2 | `npx wrangler whoami`; fix `.env`, `unset` any shell exports, add the missing permission row to the token (editing keeps its value) |
| setup: `This account has no workers.dev subdomain yet` | Step 2.1 skipped | Open Workers & Pages once |
| setup: `Zero Trust is not enabled` | Step 2.2 skipped | Dashboard → Zero Trust → team name → Free |
| setup: `R2 is not enabled on this account` | Step 2.3 skipped | Dashboard → R2 Object Storage → enable |
| setup: `Could not find the Access team domain yet` | The token lacks the Organizations · Read row | Add it, or deploy the app and run setup again (it reads the address from the login redirect) |
| The app answers `Access is not configured for this app` | It was deployed before setup filled in its Access ids | `npm run setup`, then `npm run deploy:app` |
| The app says Forbidden after signing in | You signed in with an address that isn't in `OWNER_EMAIL`'s policy | Zero Trust → Access → Applications → Pocket Scribe app → edit the policy |
| Telegram replies do nothing | The bot is not subscribed to messages | `npm run telegram:setup` again |
| Nothing captured for days, everything healthy | Pocket's device→cloud sync has stalled (you get a Telegram warning after 3 days) | Open the Pocket app and let it sync; on Android set Pocket's battery usage to Unrestricted |
| A recording shows up in Review as Failed | It failed three times; the message has the error | Fix the cause, then tick **Redo** on it in the app (Tables → Capture Log) |
| Recordings fail with `credit balance is too low` | The Anthropic account has no billing | console.anthropic.com → Billing, then **Redo** the failed ones |
| Telegram says a recording couldn't be transcribed; `npm run tail` shows `poll.error` mentioning AI | Workers AI's free daily allowance is used up, or it failed | Nothing: it is retried every half hour. Tapping Summarize on it in the Pocket app also works |
| Polls run but nothing is ever captured; `npm run tail` shows `poll.unhandled` with a 401 | `POCKET_API_KEY` is wrong or revoked | New key in the Pocket app, update `.env`, `npm run secrets` |
| `npx wrangler whoami` says *OAuth Token* | Wrangler isn't reading this folder's `.env`, so it fell back to an old `wrangler login` | Run commands from this folder; check the `.env` line has no spaces or quotes |
| `wrangler` refuses to start, mentioning the Node version | Node older than 22 | Install Node 22 or newer |
| `schema.json not found` | Step 4 was skipped | `npm run trackers` |
| `.env has no KV_ID, D1_ID` | Setup hasn't run in this folder | `npm run setup` |

---

## Giving it to someone else

Send them the link to the shared repository. They follow this file from Step 1
on their own accounts, and get your updates with `npm run update`. Nothing of
yours is in the repository: your trackers, keys and ids stay in your
untracked files.
