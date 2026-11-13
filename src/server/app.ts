/**
 * The Drip API as an Express app. Used by server.ts (local / Node host) and api/index.ts (Vercel).
 *
 *  POST /api/auth/login, POST /api/auth/logout, GET /api/auth/me
 *  GET  /api/data   the business profile, leads, templates and scheduled messages
 *  PUT  /api/data   save them (the browser saves a moment after every change)
 *  GET  /api/crm/status, GET /api/cron/send-due   see src/server/crm.ts
 *
 * Privacy: logs never contain names, phone numbers or message text; request bodies are never logged.
 */
import express, { Request, Response } from 'express';
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
import { applySendResults, registerCrmRoutes } from './crm.js';
import { getStore } from './store.js';
import { defaultTemplates } from '../lib/crm.js';
import { cleanProfile, validateData } from './validate.js';
import type { DripData } from './types.js';

dotenv.config();

export const app = express();
app.disable('x-powered-by');
app.set('trust proxy', true);
app.use(express.json({ limit: '4mb' }));

function log(event: string, fields: Record<string, string | number | boolean | null> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

function emptyData(): DripData {
  return { profile: { name: 'Meri Dukaan', owner: '', upi_id: '' }, leads: [], templates: defaultTemplates(), scheduled: [] };
}

app.get('/api/health', async (_req: Request, res: Response) => {
  const store = await getStore();
  res.json({ status: 'ok', storage: store.kind, storage_persistent: store.persistent, login_configured: loginConfigured() });
});

app.get('/api/auth/me', (req: Request, res: Response) => {
  res.json({ loggedIn: Boolean(getSession(req)), loginConfigured: loginConfigured() });
});

app.post('/api/auth/login', (req: Request, res: Response) => {
  const key = req.ip ?? 'unknown';
  if (loginRateLimited(key)) return res.status(429).json({ error: 'Bahut koshish ho gayi. 15 minute baad try karein.' });
  if (!loginConfigured()) return res.status(503).json({ error: 'Server par APP_EMAIL aur APP_PASSWORD set karein.' });
  const email = String(req.body?.email ?? '');
  const password = String(req.body?.password ?? '');
  if (!isOwnerLogin(email, password)) {
    log('login_failed');
    return res.status(401).json({ error: 'Email ya password galat hai' });
  }
  resetLoginAttempts(key);
  setSessionCookie(res, signSession());
  log('login');
  return res.json({ loggedIn: true });
});

app.post('/api/auth/logout', (_req: Request, res: Response) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

app.get('/api/data', requireLogin, async (_req: Request, res: Response) => {
  const store = await getStore();
  const { data, updated_at } = await store.getData();
  const out = data ?? emptyData();
  // Messages the server already sent through WhatsApp show as sent.
  out.scheduled = applySendResults(out.scheduled, await store.listSendResults()) ?? [];
  res.setHeader('Cache-Control', 'no-store');
  return res.json({ data: out, updated_at, storage_persistent: store.persistent });
});

app.put('/api/data', requireLogin, async (req: Request, res: Response) => {
  const problem = validateData(req.body?.data);
  if (problem) return res.status(400).json({ error: problem });
  const data = req.body.data as DripData;
  const clean: DripData = { profile: cleanProfile(data.profile), leads: data.leads, templates: data.templates, scheduled: data.scheduled };
  const store = await getStore();
  const saved_at = await store.saveData(clean);
  log('data_saved', { leads: clean.leads.length, scheduled: clean.scheduled.length });
  return res.json({ ok: true, saved_at });
});

registerCrmRoutes(app);
