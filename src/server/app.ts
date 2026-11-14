/**
 * Drip API (Express). Used by server.ts (Node) and api/index.ts (Vercel). Everything except login,
 * health and the cron hook needs the owner's login.
 *
 * Privacy: logs never contain names, phone numbers or message text; request bodies are never logged.
 */
import crypto from 'node:crypto';
import express, { NextFunction, Request, Response } from 'express';
import dotenv from 'dotenv';
import {
  clearSessionCookie,
  getSession,
  isOwnerLogin,
  loginConfigured,
  loginRateLimited,
  requireLogin,
  resetLoginAttempts,
  setSessionCookie,
  signSession,
} from './auth.js';
import { getStore } from './store.js';
import { fetchTemplates, sendMessage, textPayload, waConfig } from './whatsapp.js';
import { applyWebhook, canReply, parseWebhook, signatureOk, webhookKeyOk } from './webhook.js';
import { sendDueNow } from './sender.js';
import { LEAD_STATUSES, normalizePhone, normalizeTags } from '../lib/leads.js';
import { buildTemplatePayload, mappingProblems, templateVariables } from '../lib/templates.js';
import type { Campaign, ChatEntry, Lead, LeadStatus, Message, VarSource, WaTemplate } from '../types.js';

dotenv.config();

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
// Keep the raw body for the WhatsApp webhook signature check.
app.use(express.json({ limit: '5mb', verify: (req, _res, buf) => ((req as Request & { rawBody?: Buffer }).rawBody = buf) }));

/**
 * CORS for a front end hosted on another site (GitHub Pages). Only the origins in ALLOWED_ORIGINS may call
 * the API from a browser; they log in with a bearer token, not a cookie, so no credentials are allowed.
 */
const allowedOrigins = (process.env.ALLOWED_ORIGINS ?? 'https://itsasoeternity.github.io')
  .split(',')
  .map((o) => o.trim().replace(/\/+$/, ''))
  .filter(Boolean);
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin && allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    res.setHeader('Access-Control-Max-Age', '86400');
  }
  if (req.method === 'OPTIONS') return res.status(origin && allowedOrigins.includes(origin) ? 204 : 403).end();
  next();
});

const id = (p: string) => `${p}_${crypto.randomBytes(8).toString('hex')}`;
const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
function log(event: string, fields: Record<string, string | number | boolean | null> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}
type Handler = (req: Request, res: Response) => Promise<unknown>;
const wrap = (h: Handler) => (req: Request, res: Response, next: NextFunction) => h(req, res).catch(next);

class BadRequest extends Error {}

/* --------------------------------- auth --------------------------------- */

app.get('/api/health', wrap(async (_req, res) => {
  const store = await getStore();
  res.json({ status: 'ok', storage: store.kind, storage_persistent: store.persistent, login_configured: loginConfigured(), whatsapp: waConfig() });
}));

app.get('/api/auth/me', (req, res) => {
  res.json({ loggedIn: Boolean(getSession(req)), loginConfigured: loginConfigured() });
});

app.post('/api/auth/login', (req, res) => {
  const key = req.ip ?? 'unknown';
  if (loginRateLimited(key)) return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  if (!loginConfigured()) return res.status(503).json({ error: 'Set APP_EMAIL and APP_PASSWORD on the server.' });
  if (!isOwnerLogin(String(req.body?.email ?? ''), String(req.body?.password ?? ''))) {
    log('login_failed');
    return res.status(401).json({ error: 'Wrong email or password' });
  }
  resetLoginAttempts(key);
  const token = signSession();
  setSessionCookie(res, token);
  // The token is also returned for front ends on another site (see CORS above).
  return res.json({ loggedIn: true, token });
});

app.post('/api/auth/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

/* -------------------------------- state -------------------------------- */

app.get('/api/state', requireLogin, wrap(async (_req, res) => {
  const store = await getStore();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ ...(await store.read()), whatsapp: waConfig(), storage_persistent: store.persistent });
}));

app.put('/api/settings', requireLogin, wrap(async (req, res) => {
  const name = str(req.body?.name, 120);
  if (!name) throw new BadRequest('Business name is required');
  const store = await getStore();
  await store.mutate((doc) => {
    doc.settings.name = name;
  });
  res.json({ ok: true });
}));

/* -------------------------------- leads -------------------------------- */

function leadInput(b: Record<string, unknown>, partial = false): Partial<Lead> {
  const out: Partial<Lead> = {};
  if (!partial || b.name !== undefined) {
    out.name = str(b.name, 120);
    if (!out.name) throw new BadRequest('Name is required');
  }
  if (!partial || b.phone !== undefined) {
    const phone = normalizePhone(String(b.phone ?? ''));
    if (!phone) throw new BadRequest('Enter a valid WhatsApp number (10 digits, or with country code)');
    out.phone = phone;
  }
  if (b.tags !== undefined) out.tags = normalizeTags(Array.isArray(b.tags) ? (b.tags as string[]) : String(b.tags));
  if (b.status !== undefined) {
    if (!LEAD_STATUSES.includes(b.status as LeadStatus)) throw new BadRequest('Bad status');
    out.status = b.status as LeadStatus;
  }
  if (b.source !== undefined) out.source = str(b.source, 120);
  if (b.notes !== undefined) out.notes = str(b.notes, 2000);
  if (b.opted_in !== undefined) out.opted_in_at = b.opted_in ? new Date().toISOString() : null;
  return out;
}

app.post('/api/leads', requireLogin, wrap(async (req, res) => {
  const input = leadInput(req.body ?? {});
  const store = await getStore();
  const lead = await store.mutate((doc) => {
    if (doc.leads.some((l) => l.phone === input.phone)) throw new BadRequest('A lead with this number already exists');
    const now = new Date().toISOString();
    const l: Lead = {
      id: id('lead'), name: input.name!, phone: input.phone!, tags: input.tags ?? [], status: input.status ?? 'new',
      source: input.source ?? '', notes: input.notes ?? '', opted_in_at: input.opted_in_at ?? null, created_at: now, updated_at: now,
    };
    doc.leads.unshift(l);
    return l;
  });
  res.json({ lead });
}));

app.patch('/api/leads/:id', requireLogin, wrap(async (req, res) => {
  const input = leadInput(req.body ?? {}, true);
  const store = await getStore();
  const lead = await store.mutate((doc) => {
    const l = doc.leads.find((x) => x.id === req.params.id);
    if (!l) throw new BadRequest('Lead not found');
    if (input.phone && doc.leads.some((x) => x.phone === input.phone && x.id !== l.id)) throw new BadRequest('Another lead has this number');
    // Keep the original opt-in date when it is just re-confirmed.
    if (input.opted_in_at && l.opted_in_at) delete input.opted_in_at;
    Object.assign(l, input, { updated_at: new Date().toISOString() });
    if (!l.opted_in_at) cancelPending(doc.messages, (m) => m.lead_id === l.id, 'Lead opted out');
    return l;
  });
  res.json({ lead });
}));

function cancelPending(messages: Message[], match: (m: Message) => boolean, reason = 'Cancelled') {
  let n = 0;
  for (const m of messages) {
    if (m.status === 'scheduled' && match(m)) {
      m.status = 'cancelled';
      m.error = reason;
      n++;
    }
  }
  return n;
}

/** Bulk: add/remove tags, set status, opt in/out, or delete many leads. */
app.post('/api/leads/bulk', requireLogin, wrap(async (req, res) => {
  const ids = new Set(Array.isArray(req.body?.ids) ? (req.body.ids as string[]) : []);
  if (!ids.size) throw new BadRequest('No leads selected');
  const add = normalizeTags(req.body?.add_tags ?? []);
  const remove = normalizeTags(req.body?.remove_tags ?? []);
  const status = req.body?.status as LeadStatus | undefined;
  if (status && !LEAD_STATUSES.includes(status)) throw new BadRequest('Bad status');
  const store = await getStore();
  const changed = await store.mutate((doc) => {
    if (req.body?.delete) {
      const before = doc.leads.length;
      doc.leads = doc.leads.filter((l) => !ids.has(l.id));
      doc.chats = (doc.chats ?? []).filter((c) => !ids.has(c.lead_id));
      cancelPending(doc.messages, (m) => ids.has(m.lead_id), 'Lead deleted');
      return before - doc.leads.length;
    }
    const now = new Date().toISOString();
    let n = 0;
    for (const l of doc.leads) {
      if (!ids.has(l.id)) continue;
      n++;
      l.tags = normalizeTags([...l.tags.filter((t) => !remove.includes(t)), ...add]);
      if (status) l.status = status;
      if (req.body?.opted_in === true && !l.opted_in_at) l.opted_in_at = now;
      if (req.body?.opted_in === false) l.opted_in_at = null;
      l.updated_at = now;
    }
    if (req.body?.opted_in === false) cancelPending(doc.messages, (m) => ids.has(m.lead_id), 'Lead opted out');
    return n;
  });
  res.json({ ok: true, changed });
}));

/** Import: rows of {name, phone, tags, notes}. Existing numbers get the new tags merged in. */
app.post('/api/leads/import', requireLogin, wrap(async (req, res) => {
  const rows = Array.isArray(req.body?.rows) ? (req.body.rows as Array<Record<string, unknown>>) : [];
  if (rows.length > 20000) throw new BadRequest('Import at most 20,000 rows at a time');
  const extraTags = normalizeTags(req.body?.tags ?? []);
  const optedIn = Boolean(req.body?.opted_in);
  const source = str(req.body?.source, 120) || 'Import';
  const store = await getStore();
  const result = await store.mutate((doc) => {
    const byPhone = new Map(doc.leads.map((l) => [l.phone, l]));
    const now = new Date().toISOString();
    let created = 0, updated = 0, invalid = 0;
    for (const r of rows) {
      const phone = normalizePhone(String(r.phone ?? ''));
      if (!phone) {
        invalid++;
        continue;
      }
      const tags = normalizeTags([...normalizeTags(Array.isArray(r.tags) ? (r.tags as string[]) : String(r.tags ?? '')), ...extraTags]);
      const existing = byPhone.get(phone);
      if (existing) {
        existing.tags = normalizeTags([...existing.tags, ...tags]);
        if (optedIn && !existing.opted_in_at) existing.opted_in_at = now;
        existing.updated_at = now;
        updated++;
        continue;
      }
      const l: Lead = {
        id: id('lead'), name: str(r.name, 120) || `+${phone}`, phone, tags, status: 'new', source,
        notes: str(r.notes, 2000), opted_in_at: optedIn ? now : null, created_at: now, updated_at: now,
      };
      doc.leads.unshift(l);
      byPhone.set(phone, l);
      created++;
    }
    return { created, updated, invalid };
  });
  log('leads_imported', result);
  res.json(result);
}));

/* -------------------------------- chat -------------------------------- */

/** A note the team writes on a lead's chat (call, visit, what was discussed). Never sent. */
app.post('/api/leads/:id/notes', requireLogin, wrap(async (req, res) => {
  const text = str(req.body?.text, 4000);
  if (!text) throw new BadRequest('Write something first');
  const store = await getStore();
  const entry = await store.mutate((doc) => {
    const lead = doc.leads.find((l) => l.id === req.params.id);
    if (!lead) throw new BadRequest('Lead not found');
    const e: ChatEntry = { id: id('chat'), lead_id: lead.id, kind: 'note', text, at: new Date().toISOString() };
    (doc.chats ??= []).push(e);
    lead.updated_at = e.at;
    return e;
  });
  res.json({ entry });
}));

app.delete('/api/chats/:id', requireLogin, wrap(async (req, res) => {
  const store = await getStore();
  await store.mutate((doc) => {
    const e = (doc.chats ?? []).find((c) => c.id === req.params.id);
    if (!e || e.kind !== 'note') throw new BadRequest('Only notes can be deleted');
    doc.chats = doc.chats.filter((c) => c.id !== e.id);
  });
  res.json({ ok: true });
}));

/** Free-text WhatsApp reply. WhatsApp allows it only within 24 h of the lead's last message. */
app.post('/api/leads/:id/reply', requireLogin, wrap(async (req, res) => {
  if (!waConfig().sending) throw new BadRequest('Sending is off: set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID');
  const text = str(req.body?.text, 4096);
  if (!text) throw new BadRequest('Write a message first');
  const store = await getStore();
  const lead = (await store.read()).leads.find((l) => l.id === req.params.id);
  if (!lead) throw new BadRequest('Lead not found');
  if (!canReply(lead)) throw new BadRequest('WhatsApp only allows a free-text reply within 24 hours of the lead\'s last message. Send an approved template instead.');
  const r = await sendMessage(textPayload(lead.phone, text));
  const entry: ChatEntry = {
    id: id('chat'), lead_id: lead.id, kind: 'out', text, at: new Date().toISOString(),
    wa_message_id: r.id, status: r.ok ? 'sent' : 'failed', error: r.ok ? undefined : r.error,
  };
  await store.mutate((doc) => {
    (doc.chats ??= []).push(entry);
  });
  if (!r.ok) throw new BadRequest(`WhatsApp: ${r.error}`);
  res.json({ entry });
}));

/* ------------------------------- webhook ------------------------------- */

// Meta's verification handshake (only needed if Meta calls Drip directly).
app.get('/api/webhook/whatsapp', (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && webhookKeyOk(req.query['hub.verify_token'])) return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
  return res.sendStatus(403);
});

app.post('/api/webhook/whatsapp', wrap(async (req, res) => {
  const viaKey = webhookKeyOk(req.query.key);
  const viaSignature = Boolean(process.env.WHATSAPP_APP_SECRET) && signatureOk((req as Request & { rawBody?: Buffer }).rawBody, req.headers['x-hub-signature-256']);
  if (!viaKey && !viaSignature) return res.status(403).json({ error: 'forbidden' });
  const events = parseWebhook(req.body);
  if (events.messages.length || events.statuses.length) {
    const store = await getStore();
    const r = await store.mutate((doc) => applyWebhook(doc, events, id));
    log('webhook', r);
  }
  return res.json({ ok: true });
}));

/* ------------------------------ templates ------------------------------ */

app.get('/api/templates', requireLogin, wrap(async (req, res) => {
  try {
    const templates = await fetchTemplates(req.query.refresh === '1');
    res.json({ templates });
  } catch (err) {
    res.status(502).json({ error: err instanceof Error ? err.message : 'Could not load templates' });
  }
}));

/* ------------------------------ campaigns ------------------------------ */

function parseMapping(raw: unknown, t: WaTemplate): Record<string, VarSource> {
  const m = (raw ?? {}) as Record<string, { kind?: string; text?: unknown }>;
  const out: Record<string, VarSource> = {};
  for (const v of templateVariables(t)) {
    const s = m[v.key];
    if (s?.kind === 'name' || s?.kind === 'first_name' || s?.kind === 'phone') out[v.key] = { kind: s.kind };
    else out[v.key] = { kind: 'text', text: str(s?.text, 1000) };
  }
  return out;
}

/** Look the template up from the API so the campaign uses what WhatsApp has approved. */
async function approvedTemplate(name: unknown, language: unknown): Promise<WaTemplate> {
  const templates = await fetchTemplates();
  const t = templates.find((x) => x.name === name && x.language === language);
  if (!t) throw new BadRequest('Template not found. Refresh templates and try again.');
  if (t.status !== 'APPROVED') throw new BadRequest(`Template is ${t.status.toLowerCase()}, not approved`);
  return t;
}

app.post('/api/campaigns', requireLogin, wrap(async (req, res) => {
  const b = req.body ?? {};
  const t = await approvedTemplate(b.template_name, b.template_language);
  const mapping = parseMapping(b.mapping, t);
  const media = str(b.header_media_url, 1000) || null;
  const problems = mappingProblems(t, mapping, media);
  if (problems.length) throw new BadRequest(problems.join('; '));
  const sendAt = new Date(String(b.send_at ?? ''));
  if (Number.isNaN(sendAt.getTime())) throw new BadRequest('Pick a date and time');
  if (sendAt.getTime() < Date.now() - 5 * 60_000) throw new BadRequest('That time has passed');
  const leadIds = new Set(Array.isArray(b.lead_ids) ? (b.lead_ids as string[]) : []);
  if (!leadIds.size) throw new BadRequest('Select at least one lead');

  const store = await getStore();
  const result = await store.mutate((doc) => {
    const leads = doc.leads.filter((l) => leadIds.has(l.id));
    const ok = leads.filter((l) => l.opted_in_at);
    if (!ok.length) throw new BadRequest('None of the selected leads has opted in');
    const campaign: Campaign = {
      id: id('cmp'),
      name: str(b.name, 120) || `${t.name} · ${sendAt.toISOString().slice(0, 16).replace('T', ' ')}`,
      template: t, mapping, header_media_url: media, send_at: sendAt.toISOString(), created_at: new Date().toISOString(),
    };
    doc.campaigns.unshift(campaign);
    for (const l of ok) doc.messages.push({ id: id('msg'), campaign_id: campaign.id, lead_id: l.id, send_at: campaign.send_at, status: 'scheduled' });
    return { campaign, scheduled: ok.length, skipped_not_opted_in: leads.length - ok.length };
  });
  log('campaign_created', { scheduled: result.scheduled });
  res.json(result);
}));

/** Send one message right now to a number (yours), to check how the template looks. Not saved. */
app.post('/api/campaigns/test', requireLogin, wrap(async (req, res) => {
  if (!waConfig().sending) throw new BadRequest('Set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID to send');
  const b = req.body ?? {};
  const t = await approvedTemplate(b.template_name, b.template_language);
  const mapping = parseMapping(b.mapping, t);
  const media = str(b.header_media_url, 1000) || null;
  const problems = mappingProblems(t, mapping, media);
  if (problems.length) throw new BadRequest(problems.join('; '));
  const phone = normalizePhone(String(b.phone ?? ''));
  if (!phone) throw new BadRequest('Enter a valid number for the test');
  const r = await sendMessage(buildTemplatePayload(t, mapping, { name: str(b.sample_name, 120) || 'Test', phone }, media));
  if (!r.ok) throw new BadRequest(`WhatsApp: ${r.error}`);
  res.json({ ok: true, wa_message_id: r.id });
}));

app.post('/api/campaigns/:id/cancel', requireLogin, wrap(async (req, res) => {
  const store = await getStore();
  const n = await store.mutate((doc) => cancelPending(doc.messages, (m) => m.campaign_id === req.params.id));
  res.json({ ok: true, cancelled: n });
}));

app.post('/api/campaigns/:id/reschedule', requireLogin, wrap(async (req, res) => {
  const at = new Date(String(req.body?.send_at ?? ''));
  if (Number.isNaN(at.getTime()) || at.getTime() < Date.now() - 60_000) throw new BadRequest('Pick a future time');
  const store = await getStore();
  const n = await store.mutate((doc) => {
    const c = doc.campaigns.find((x) => x.id === req.params.id);
    if (!c) throw new BadRequest('Campaign not found');
    c.send_at = at.toISOString();
    let count = 0;
    for (const m of doc.messages) if (m.campaign_id === c.id && m.status === 'scheduled') {
      m.send_at = c.send_at;
      count++;
    }
    return count;
  });
  res.json({ ok: true, rescheduled: n });
}));

app.post('/api/messages/:id/cancel', requireLogin, wrap(async (req, res) => {
  const store = await getStore();
  const n = await store.mutate((doc) => cancelPending(doc.messages, (m) => m.id === req.params.id));
  res.json({ ok: true, cancelled: n });
}));

/** Failed message -> schedule again now. */
app.post('/api/messages/:id/retry', requireLogin, wrap(async (req, res) => {
  const store = await getStore();
  await store.mutate((doc) => {
    const m = doc.messages.find((x) => x.id === req.params.id);
    if (!m || m.status !== 'failed') throw new BadRequest('Only failed messages can be retried');
    Object.assign(m, { status: 'scheduled', send_at: new Date().toISOString(), error: undefined, claimed_at: undefined });
  });
  sendDueNow().catch(() => undefined);
  res.json({ ok: true });
}));

/* ------------------------------- sending ------------------------------- */

app.post('/api/send-due', requireLogin, wrap(async (_req, res) => {
  if (!waConfig().sending) throw new BadRequest('Sending is off: set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID');
  res.json(await sendDueNow());
}));

// For Vercel Cron or any external scheduler: GET with "Authorization: Bearer $CRON_SECRET".
app.get('/api/cron/send-due', wrap(async (req, res) => {
  const secret = process.env.CRON_SECRET;
  if (!secret || req.headers.authorization !== `Bearer ${secret}`) return res.status(401).json({ error: 'unauthorized' });
  if (!waConfig().sending) return res.json({ ok: true, sending: false });
  res.json({ ok: true, ...(await sendDueNow()) });
}));

/* -------------------------------- errors -------------------------------- */

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof BadRequest) return res.status(400).json({ error: err.message });
  log('server_error', { message: err instanceof Error ? err.message.slice(0, 200) : 'unknown' });
  return res.status(500).json({ error: 'Something went wrong' });
});
