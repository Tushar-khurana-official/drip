# Drip

A small CRM for following up with leads on WhatsApp: add leads, tag them, pick a message template and
choose when it goes out. Hinglish interface, works on phone and desktop.

The code started as the Leads CRM in Dukaan Saathi and runs here as its own app for one business.

## What it does

| Step | How |
| --- | --- |
| Add a lead | "Naya lead": name, WhatsApp number, source, note, tags. A number is saved only with the consent tick ("is vyakti ne message lene ke liye haan kaha hai"). |
| Tag leads | Type tags in the form (Enter or comma), tap "+ tag" on any lead, or select many leads and use "Tag lagayein / Tag hatayein". Tap tags at the top to filter (several tags = leads with all of them). Each lead also has a status: Naya, Baat hui, Interested, Grahak bana, Nahi chahiye. |
| Templates | "Templates" tab: four starter templates, add or edit your own. `{name}`, `{shop}`, `{owner}`, `{upi}` are filled per lead, with a live preview. `{shop}`, `{owner}` and `{upi}` come from Settings (gear icon). |
| Schedule | Pick one lead ("Schedule") or select many → "Template schedule karein" → choose the template → choose the time (quick picks like "Kal subah 10 baje", or any date and time). One message per lead; leads without number/consent are skipped and shown. |
| Sending | **Default:** at the chosen time the message moves to "Abhi bhejein" (optional browser notification); one tap opens WhatsApp with the text filled in and you tap send. **Automatic:** set `WHATSAPP_TOKEN` and `WHATSAPP_PHONE_NUMBER_ID` (WhatsApp Cloud API) and the server sends at the time by itself. |
| Track | "Scheduled" tab: due now, upcoming (change time or cancel), history (sent / failed / cancelled). A lead becomes "Baat hui" after its first message goes out. |

## Run it

```bash
npm install
cp .env.example .env      # set APP_EMAIL, APP_PASSWORD and SESSION_SECRET
npm run dev               # http://localhost:3000
```

| Command | What it does |
| --- | --- |
| `npm run dev` | Express server + Vite dev server |
| `npm run build` then `npm start` | Production build served by the same server |
| `npm test` | Tags, templates, scheduling, login, one-time sending, upload checks |
| `npm run lint` | TypeScript check |

Data is saved on the server: Postgres when `DATABASE_URL` is set, otherwise `./data/drip.json` (git-ignored;
it contains names and phone numbers). The browser saves a second after every change.

## Automatic sending

- `npm start` / `npm run dev`: the server checks for due messages every minute by itself.
- Vercel: call `GET /api/cron/send-due` every minute with `Authorization: Bearer $CRON_SECRET` (Vercel Cron on
  a Pro plan, or any external cron service; Hobby plans only allow daily cron jobs).
- WhatsApp only allows free text to people who messaged the business in the last 24 hours. For everyone else,
  create a template in Meta Business Manager, get it approved, and enter its name and language on the template
  in the app ("WhatsApp approved template"); `{{1}}` in it is filled with the lead's first name.
- Each message is written to a separate send log before it is sent, so it is never sent twice (two cron runs,
  or a browser uploading an older copy). Messages more than 24 hours late are not sent automatically; you can
  still send them by hand.
- Logs contain counts only, never names, numbers or message text.

## Deploy on Vercel

1. Storage → create a Neon (Postgres) database and connect it (sets `DATABASE_URL`).
2. Environment variables: `APP_EMAIL`, `APP_PASSWORD`, `SESSION_SECRET`; for automatic sending also
   `WHATSAPP_TOKEN`, `WHATSAPP_PHONE_NUMBER_ID`, `CRON_SECRET`.
3. Deploy. Without `DATABASE_URL` the app shows a warning: data in `/tmp` is lost on cold starts.

## Code

| Path | What |
| --- | --- |
| `src/lib/crm.ts` | Tags, templates, scheduling rules (pure functions) |
| `src/hooks/useCrm.ts` | Browser state, saving, picking up server send results |
| `src/components/CrmScreen.tsx` | Leads, Templates and Scheduled screens |
| `src/server/app.ts` | Login and data API |
| `src/server/crm.ts` | Send status, cron endpoint, WhatsApp Cloud API |
| `src/server/store.ts` | Postgres or JSON file storage, send log |
| `tests/crm.test.ts` | Tests |
