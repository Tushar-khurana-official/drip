# Drip CRM

A small CRM for WhatsApp follow-ups: keep a list of leads, tag them, pick an approved WhatsApp template,
fill in its variables and schedule when it goes out. The server sends each message at its time through the
WhatsApp API (Meta Cloud API format, via the provider's gateway).

## What it does

| | |
| --- | --- |
| **Leads** | Add one by one or import a CSV (`name, phone, tags, notes`; header row optional). Indian 10-digit numbers get +91; other numbers need their country code. Duplicate numbers are merged, not repeated. Each lead has a status (new, contacted, interested, converted, lost), source, notes and an opt-in date. |
| **Tags** | Add tags in the lead form, remove them with the × on a lead, or add/remove a tag on many selected leads at once. Click tags to filter (match any or all). |
| **Templates** | Loaded live from the WhatsApp Business Account: approved, pending and rejected, with a preview. Only approved templates can be sent. |
| **Campaigns** | Select leads (or choose tags) → *Send template* → choose a template → map each variable (`{{1}}`, named params, URL button params) to the lead's first name, full name, phone, or fixed text → add the media link if the header is an image/video/document → choose the time → *Schedule*. *Send test* sends it to your own number first. |
| **Tracking** | Each campaign shows scheduled / sent / failed / cancelled per lead, with WhatsApp's error message when one fails. Change the time or cancel what is still scheduled; retry failed messages. A lead moves from *new* to *contacted* once a message is sent. |

Messages are only scheduled for leads marked as opted in. Opting a lead out cancels their pending messages.

## Run it

```bash
npm install
cp .env.example .env      # fill in login + WhatsApp settings
npm run dev               # http://localhost:3000
```

| Command | |
| --- | --- |
| `npm run dev` | API + Vite dev server; sends due messages every 30 s |
| `npm run build`, then `npm start` | Production build on a Node server (same 30 s sender) |
| `npm test` | Leads, CSV, tags, template variables and payloads, login, campaigns, sending (against a fake WhatsApp API) |
| `npm run lint` | TypeScript check |

## WhatsApp settings

| Variable | What |
| --- | --- |
| `WHATSAPP_API_BASE` | `https://crmapi.setu360.com/api/meta/v19.0` |
| `WHATSAPP_TOKEN` | Gateway token, sent as `Authorization: Bearer …` |
| `WHATSAPP_PHONE_NUMBER_ID` | The sending number's ID (messages: `POST {base}/{id}/messages`) |
| `WHATSAPP_WABA_ID` | The WhatsApp Business Account ID (templates: `GET {base}/{waba}/message_templates?json=true`) |

The phone-number ID and the Business Account ID are different numbers. Using the phone-number ID for
templates gives *"request node (waba_id) does not match"*.

## How sending works

- Every 30 seconds (or on each cron call) the server takes due messages, marks them *sending* in one atomic
  step, sends them, and records *sent* (with WhatsApp's message id) or *failed* (with the reason). Two runs can
  never send the same message.
- A message interrupted mid-send is marked failed after 15 minutes, never resent automatically.
- Messages more than 24 hours late (server was down) are marked failed instead of being sent late.
- Delivered / read receipts need the WhatsApp webhook, which currently points at the provider; not shown yet.
- Logs contain counts only, never names, numbers or message text.

## Deploy on Vercel

1. Storage → create a Neon (Postgres) database and connect it (sets `DATABASE_URL`).
2. Set the environment variables from `.env.example`.
3. Scheduling: Vercel functions don't run in the background, so something must call
   `GET /api/cron/send-due` with `Authorization: Bearer $CRON_SECRET` every minute — Vercel Cron on a Pro plan,
   or a free external cron service. (A normal Node host with `npm start` needs none of this.)

## GitHub Pages (itsasoeternity.github.io/drip)

GitHub Pages only hosts files, so it can show Drip's screens but cannot run the server (leads storage,
the WhatsApp token, scheduled sending). Use it together with a server on Vercel or any Node host:

1. Deploy the server (above) and note its address, e.g. `https://drip-xyz.vercel.app`.
2. On that server set `ALLOWED_ORIGINS=https://itsasoeternity.github.io` (the default).
3. GitHub → repo **Settings → Pages → Source: GitHub Actions** (one time).
4. GitHub → **Settings → Secrets and variables → Actions → Variables → New variable**:
   `DRIP_API_URL` = the server address.
5. **Actions → Deploy to GitHub Pages → Run workflow** (it also runs on every push to `main`).

Without `DRIP_API_URL` the page shows these steps instead of a blank screen. On Pages, login uses a token kept
in the browser (cross-site cookies are blocked by browsers); only the origins in `ALLOWED_ORIGINS` can call
the API. The simplest option is still to open the Vercel address directly: it serves the same app.

## Code

| Path | |
| --- | --- |
| `src/lib/leads.ts` | Phone numbers, tags, filters, CSV |
| `src/lib/templates.ts` | Template variables, payload for the WhatsApp API, preview |
| `src/server/whatsapp.ts` | WhatsApp API client (templates, send) |
| `src/server/sender.ts` | Scheduled sending |
| `src/server/app.ts` | API routes |
| `src/server/store.ts` | Postgres or JSON-file storage (atomic updates) |
| `src/components/` | Leads, campaign composer, campaigns, templates |
| `tests/drip.test.ts` | Tests |
