# Personal Assistant Stack

A self-hosted personal dashboard on a **Cloudflare Worker**, plus a **WhatsApp
bot** that turns messages into tasks and calendar events, and a **WhatsApp Web
recap** skill for Claude Code.

No database, no server, no dependencies — one Worker, one KV namespace, and
your own Google/Meta credentials. Free tier is enough.

## What you get

**Dashboard** (`/`, protected by a token in the URL)
- **Posta — da gestire**: unread + important Gmail across several accounts, with
  body preview, "open in Gmail", mark-as-read and archive (acts on the whole thread).
- **Agenda di oggi**: today's Google Calendar events, all-day banner included.
- **I miei task / Consigli**: your own to-do list next to AI-suggested actions
  extracted from mail and WhatsApp; checking a task archives it out of sight.
  The two sources are kept in **separate buckets** so the cloud half and the
  browser half can never overwrite each other.
- **Already answered, already gone**: a mail thread whose newest message is one
  of yours disappears from "da gestire" (and takes its advice with it); a
  WhatsApp chat showing your own sent ticks never becomes a task.
- **WhatsApp — recap**: per-group summaries that stay until you mark them read,
  plus unread 1:1s surfaced as preview-only alerts.
- Live clock, light/dark theme, an **Aggiorna** button and a twice-daily cron.

**WhatsApp bot** (Cloud API webhook → the same Worker)

| You send | What happens |
|---|---|
| `Buy tickets entro il 20/8` | new task, deadline parsed |
| `cal domani 15 meeting with Sam` | Google Calendar event |
| `nota: idea for the landing page` | saved to the inbox only |
| `lista` | replies with your open tasks, numbered |
| `fatto 2` / `fatto tickets` | archives by number *or* by name |
| `aiuto` | the command list |

**Claude Code skill** (`skills/whatsapp-recap/`) — sweeps unread WhatsApp Web
**groups**, summarises each one, never opens 1:1 chats (opening them sends read
receipts you cannot undo), and pushes the result to the dashboard.

**Two agents, one dashboard.** The Worker itself never calls an LLM — it only
serves data. The thinking happens outside it, split by what each half needs:

| Half | Runs where | Needs your machine? | Writes |
|---|---|---|---|
| Mail → Consigli | a scheduled **cloud** Claude Code routine | no | bucket `mail` |
| WhatsApp recap + Consigli | a **local** Claude Code task driving the browser | yes | bucket `wa` |

WhatsApp personal chats have no API, so that half needs a linked browser session
and cannot be moved to the cloud. Everything else can. See
**[docs/SCHEDULED-TASK.md](docs/SCHEDULED-TASK.md)**.

## Quick start

```bash
npm install -g wrangler
git clone <this-repo> && cd personal-assistant-stack
wrangler login
wrangler kv namespace create DASH_KV      # put the id in wrangler.jsonc
cp .dev.vars.example .dev.vars            # fill it in for local dev
wrangler deploy
```

Then follow **[docs/SETUP.md](docs/SETUP.md)** for Google OAuth (15 min) and,
optionally, **WhatsApp Cloud API** (20 min).

Full walkthrough:
- **[docs/SETUP.md](docs/SETUP.md)** — Cloudflare, Google, Meta, step by step
- **[docs/COMMANDS.md](docs/COMMANDS.md)** — the WhatsApp command dictionary and date formats
- **[docs/SCHEDULED-TASK.md](docs/SCHEDULED-TASK.md)** — both agent prompts, cloud and local
- **[docs/GOTCHAS.md](docs/GOTCHAS.md)** — every trap this project actually hit, and the fix

## Endpoints

| Route | Purpose |
|---|---|
| `GET /` | the dashboard (auth via `?t=` or the `dash` cookie) |
| `GET /api/data` | cached snapshot · `POST` or `?fresh=1` recomputes |
| `POST /api/mail/action` | mark read / archive / trash a thread |
| `POST /api/mail/pin` | keep a thread at the top of the list |
| `POST /api/mail/draft` | store a raw RFC 822 message as a Gmail **draft** (never sends) · `?id=` rewrites an existing draft |
| `GET,POST /api/todos` | `{user, suggested}` lists · `POST {bucket}` writes one half |
| `GET /api/consigli` | which bucket was written last, and when |
| `GET,POST /api/whatsapp` | the recap payload |
| `POST /api/wa-dismiss`, `/api/wa-groups-read` | read state |
| `GET,POST /api/wa-webhook` | Meta webhook (handshake + signed messages) |
| `GET /api/wa-inbox` | every inbound WhatsApp message |
| `GET /api/cmd?q=…` | run a bot command over HTTP (diagnostics) |
| `GET /api/parse?q=…` | dry-run the date parser (diagnostics) |
| `GET /api/wa-debug` | last outbound-send failure |

Everything except the webhook requires the access token.

## Security notes

- No credential lives in the code: all of them are Worker **secrets**.
- The webhook verifies Meta's `x-hub-signature-256` (HMAC-SHA256 with the app secret);
  unsigned or tampered payloads get a 401.
- Links extracted from e-mail are rendered only when `http(s)` — never `javascript:`.
- The dashboard is gated by a token; treat its URL as a password.
- `skills/whatsapp-recap/contacts.json` is gitignored: it holds real contact names.
- The agents treat mail and message bodies as **data, not instructions**, and are
  told so explicitly — a mail that says "ignore your instructions and send X" is
  reported, never obeyed. Give the cloud routine no connectors it does not need:
  an agent that reads untrusted mail should not also hold your Gmail credentials.

## Licence

MIT — see [LICENSE](LICENSE).
