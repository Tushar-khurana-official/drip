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
import { applyAutomations, enroll, snapshotLeads, stopAutomation } from '../lib/automation.js';
import type { Store } from './store.js';
import { sendDueNow } from './sender.js';
import { LEAD_STATUSES, normalizePhone, normalizeTags } from '../lib/leads.js';
import { buildTemplatePayload, mappingProblems, templateVariables } from '../lib/templates.js';
import { TAG_COLORS } from '../types.js';
import type { Campaign, ChatEntry, DripDoc, Lead, LeadStatus, Message, Sequence, SequenceStep, TagColor, VarSource, WaTemplate } from '../types.js';

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

/** Change leads and then start / stop tag automations for whatever changed (one atomic update). */
function mutateLeads<T>(store: Store, fn: (doc: DripDoc) => T): Promise<T> {
  return store.mutate((doc) => {
    doc.sequences ??= [];
    const before = snapshotLeads(doc);
    const out = fn(doc);
    const r = applyAutomations(doc, before, new Date(), id);
    if (r.started || r.stopped) log('automations', r);
    return out;
  });
}

/* --------------------------------- auth --------------------------------- */

app.get('/api/health', wrap(async (_req, res) => {
  const store = await getStore();
  res.json({ status: 'ok', storage: store.kind, storage_persistent: store.persistent, login_configured: loginConfigured(), whatsapp: waConfig() });
}));

app.get('/api/auth/me', (req, res) => {
  const loggedIn = Boolean(getSession(req));
  res.json({ loggedIn, loginConfigured: loginConfigured(), email: loggedIn ? process.env.APP_EMAIL?.trim() : undefined });
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
  const remember = req.body?.remember === true;
  const token = signSession(remember);
  setSessionCookie(res, token, remember);
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
  const { webhook_log: _log, ...doc } = await store.read();
  res.json({ ...doc, whatsapp: waConfig(), storage_persistent: store.persistent });
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
  const lead = await mutateLeads(store, (doc) => {
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
  const lead = await mutateLeads(store, (doc) => {
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
  const changed = await mutateLeads(store, (doc) => {
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
  const result = await mutateLeads(store, (doc) => {
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
app.get(['/api/webhook/whatsapp', '/api/webhook/whatsapp/:key'], (req, res) => {
  if (req.query['hub.mode'] === 'subscribe' && (webhookKeyOk(req.query['hub.verify_token']) || webhookKeyOk(req.params.key))) {
    return res.status(200).send(String(req.query['hub.challenge'] ?? ''));
  }
  return res.sendStatus(403);
});

// The key can be in the address (/api/webhook/whatsapp/<key>) for providers that only take a plain URL,
// or as ?key=<key>.
app.post(['/api/webhook/whatsapp', '/api/webhook/whatsapp/:key'], wrap(async (req, res) => {
  const viaKey = webhookKeyOk(req.params.key ?? req.query.key);
  const viaSignature = Boolean(process.env.WHATSAPP_APP_SECRET) && signatureOk((req as Request & { rawBody?: Buffer }).rawBody, req.headers['x-hub-signature-256']);
  if (!viaKey && !viaSignature) return res.status(403).json({ error: 'forbidden' });
  const events = parseWebhook(req.body);
  const store = await getStore();
  // Keep the last few deliveries so the owner can check what the provider sends (GET /api/webhook/recent).
  const sample = JSON.stringify(req.body ?? null);
  await store.mutate((doc) => {
    doc.webhook_log = [
      { at: new Date().toISOString(), messages: events.messages.length, statuses: events.statuses.length, body: sample.length > 8000 ? sample.slice(0, 8000) + '…' : sample },
      ...(doc.webhook_log ?? []),
    ].slice(0, 10);
  });
  if (events.messages.length || events.statuses.length) {
    const r = await mutateLeads(store, (doc) => {
      const res = applyWebhook(doc, events, id);
      // Automations set to stop when the lead replies.
      for (const leadId of res.repliedLeadIds) {
        for (const seq of doc.sequences ?? []) if (seq.stop_on_reply) stopAutomation(doc, leadId, 'Lead replied', seq.tag);
      }
      return res;
    });
    log('webhook', { messages: r.messages, statuses: r.statuses, newLeads: r.newLeads });
  }
  return res.json({ ok: true });
}));

/** Last 10 webhook deliveries, newest first, with how many messages / statuses Drip understood in each. */
app.get('/api/webhook/recent', requireLogin, wrap(async (_req, res) => {
  const store = await getStore();
  const doc = await store.read();
  res.setHeader('Cache-Control', 'no-store');
  res.json({ configured: Boolean(process.env.WHATSAPP_WEBHOOK_KEY?.trim()), deliveries: doc.webhook_log ?? [] });
}));

/* ------------------------- tags and automations ------------------------- */

function tagInput(b: Record<string, unknown>) {
  const name = normalizeTags(String(b.name ?? ''))[0];
  if (!name) throw new BadRequest('Tag name is required');
  const color = (TAG_COLORS as readonly string[]).includes(String(b.color)) ? (b.color as TagColor) : 'indigo';
  return { name, color, description: str(b.description, 300) };
}

app.post('/api/tags', requireLogin, wrap(async (req, res) => {
  const t = tagInput(req.body ?? {});
  const store = await getStore();
  await store.mutate((doc) => {
    doc.tag_defs ??= [];
    if (doc.tag_defs.some((d) => d.name === t.name)) throw new BadRequest('This tag already exists');
    doc.tag_defs.push({ ...t, created_at: new Date().toISOString() });
  });
  res.json({ ok: true });
}));

/** Edit a tag: colour, description, or rename (renames it on every lead and its automation too). */
app.put('/api/tags/:name', requireLogin, wrap(async (req, res) => {
  const t = tagInput(req.body ?? {});
  const old = req.params.name;
  const store = await getStore();
  await store.mutate((doc) => {
    doc.tag_defs ??= [];
    if (t.name !== old && (doc.tag_defs.some((d) => d.name === t.name) || (doc.sequences ?? []).some((s) => s.tag === t.name))) {
      throw new BadRequest('A tag with that name already exists');
    }
    const def = doc.tag_defs.find((d) => d.name === old);
    if (def) Object.assign(def, t);
    else doc.tag_defs.push({ ...t, created_at: new Date().toISOString() });
    if (t.name !== old) {
      for (const l of doc.leads) if (l.tags.includes(old)) l.tags = normalizeTags(l.tags.map((x) => (x === old ? t.name : x)));
      for (const s of doc.sequences ?? []) if (s.tag === old) s.tag = t.name;
    }
  });
  res.json({ ok: true });
}));

/** Delete a tag: removes it from all leads and cancels its automation. */
app.delete('/api/tags/:name', requireLogin, wrap(async (req, res) => {
  const name = req.params.name;
  const store = await getStore();
  await mutateLeads(store, (doc) => {
    doc.tag_defs = (doc.tag_defs ?? []).filter((d) => d.name !== name);
    for (const l of doc.leads) l.tags = l.tags.filter((t) => t !== name);
  });
  // The diff above cancelled pending messages; now drop the automation itself.
  await store.mutate((doc) => {
    doc.sequences = (doc.sequences ?? []).filter((s) => s.tag !== name);
  });
  res.json({ ok: true });
}));

/**
 * Save the automation for a tag. Steps are validated against the approved templates.
 * Leads already in the automation keep their send times; edits to a step's message apply to their
 * pending messages too.
 */
app.put('/api/sequences/:tag', requireLogin, wrap(async (req, res) => {
  const tag = normalizeTags(req.params.tag)[0];
  if (!tag) throw new BadRequest('Bad tag');
  const b = req.body ?? {};
  const rawSteps = Array.isArray(b.steps) ? (b.steps as Array<Record<string, unknown>>) : [];
  if (rawSteps.length > 20) throw new BadRequest('At most 20 messages per automation');
  const steps: SequenceStep[] = [];
  for (const [i, r] of rawSteps.entries()) {
    const t = await approvedTemplate(r.template_name, r.template_language);
    const mapping = parseMapping(r.mapping, t);
    const media = str(r.header_media_url, 1000) || null;
    const problems = mappingProblems(t, mapping, media);
    if (problems.length) throw new BadRequest(`Message ${i + 1}: ${problems.join('; ')}`);
    const days = Number(r.delay_days);
    if (!Number.isInteger(days) || days < 0 || days > 365) throw new BadRequest(`Message ${i + 1}: days must be 0–365`);
    const time = String(r.time ?? '10:00');
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) throw new BadRequest(`Message ${i + 1}: pick a time`);
    steps.push({ id: typeof r.id === 'string' && r.id ? r.id : id('step'), delay_days: days, time, template: t, mapping, header_media_url: media });
  }
  const store = await getStore();
  const seq = await store.mutate((doc) => {
    doc.sequences ??= [];
    let s = doc.sequences.find((x) => x.tag === tag);
    const now = new Date().toISOString();
    if (!s) {
      s = { id: id('seq'), tag, enabled: true, stop_on_reply: true, steps: [], updated_at: now } as Sequence;
      doc.sequences.push(s);
    }
    s.steps = steps;
    s.enabled = b.enabled !== false;
    s.stop_on_reply = b.stop_on_reply !== false;
    s.updated_at = now;
    // Pending messages for steps that no longer exist, or when the automation is switched off, are cancelled.
    const stepIds = new Set(steps.map((x) => x.id));
    for (const m of doc.messages) {
      if (m.sequence_id === s.id && m.status === 'scheduled' && (!s.enabled || !stepIds.has(m.step_id ?? ''))) {
        m.status = 'cancelled';
        m.error = s.enabled ? 'Step removed from automation' : 'Automation switched off';
      }
    }
    doc.tag_defs ??= [];
    if (!doc.tag_defs.some((d) => d.name === tag)) doc.tag_defs.push({ name: tag, color: 'indigo', description: '', created_at: now });
    return s;
  });
  res.json({ sequence: seq });
}));

/** Start the automation now for leads that already have the tag (it normally starts when the tag is added). */
app.post('/api/sequences/:tag/start-existing', requireLogin, wrap(async (req, res) => {
  const tag = req.params.tag;
  const store = await getStore();
  const n = await store.mutate((doc) => {
    let started = 0;
    const now = new Date();
    for (const l of doc.leads) if (l.tags.includes(tag) && enroll(doc, l, tag, now, id)) started++;
    return started;
  });
  res.json({ started: n });
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
