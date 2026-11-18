import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { Server } from 'node:http';
import type { WaTemplate } from '../src/types';

/* ---------- a fake WhatsApp API (same shape as Meta / the gateway) ---------- */

const TEMPLATES: WaTemplate[] = [
  {
    name: 'appointment_reminder', language: 'en', status: 'APPROVED', category: 'UTILITY',
    components: [
      { type: 'HEADER', format: 'TEXT', text: 'Hi {{1}}' , example: { header_text: ['Priya'] } },
      { type: 'BODY', text: 'Dear {{1}}, your appointment at {{2}} is on {{3}}.', example: { body_text: [['Priya', 'Clinic', 'Monday']] } },
      { type: 'FOOTER', text: 'Reply STOP to opt out' },
      { type: 'BUTTONS', buttons: [{ type: 'URL', text: 'Details', url: 'https://example.com/a/{{1}}' }, { type: 'QUICK_REPLY', text: 'OK' }] },
    ],
  },
  {
    name: 'offer_named', language: 'hi', status: 'APPROVED', category: 'MARKETING', parameter_format: 'NAMED',
    components: [
      { type: 'HEADER', format: 'IMAGE' },
      { type: 'BODY', text: 'Namaste {{customer_name}}, {{offer}} sirf aaj!' },
    ],
  },
  { name: 'draft_one', language: 'en', status: 'PENDING', components: [{ type: 'BODY', text: 'Hello' }] },
];

const sent: any[] = [];
let failNext = false;
const fake = http.createServer((req, res) => {
  const auth = req.headers.authorization;
  res.setHeader('Content-Type', 'application/json');
  if (auth !== 'Bearer test-token') return res.end(JSON.stringify({ success: false, error: 'unauthorized access' }));
  if (req.method === 'GET' && req.url?.startsWith('/v19.0/WABA1/message_templates')) return res.end(JSON.stringify({ data: TEMPLATES, paging: {} }));
  if (req.method === 'POST' && req.url === '/v19.0/PHONE1/messages') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (failNext) {
        failNext = false;
        res.statusCode = 400;
        return res.end(JSON.stringify({ error: { message: 'Recipient not on WhatsApp', code: 131026 } }));
      }
      sent.push(JSON.parse(body));
      res.end(JSON.stringify({ messaging_product: 'whatsapp', messages: [{ id: `wamid.${sent.length}` }] }));
    });
    return;
  }
  res.statusCode = 404;
  res.end(JSON.stringify({ error: 'invalid path request' }));
});

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drip-test-'));
let server: Server;
let base = '';
let cookie = '';

let L: typeof import('../src/lib/leads');
let T: typeof import('../src/lib/templates');
let W: typeof import('../src/server/whatsapp');
let S: typeof import('../src/server/sender');
let ST: typeof import('../src/server/store');

before(async () => {
  fake.listen(0);
  await new Promise((r) => fake.once('listening', r));
  const fa = fake.address();
  Object.assign(process.env, {
    DATA_DIR: dataDir,
    APP_EMAIL: 'owner@example.test',
    APP_PASSWORD: 'owner-test-password',
    SESSION_SECRET: 'test-secret-test-secret-1234',
    CRON_SECRET: 'cron-secret',
    WHATSAPP_API_BASE: `http://127.0.0.1:${typeof fa === 'object' && fa ? fa.port : 0}/v19.0`,
    WHATSAPP_TOKEN: 'test-token',
    WHATSAPP_PHONE_NUMBER_ID: 'PHONE1',
    WHATSAPP_WABA_ID: 'WABA1',
    WHATSAPP_WEBHOOK_KEY: 'hook-key',
  });
  delete process.env.DATABASE_URL;
  L = await import('../src/lib/leads');
  T = await import('../src/lib/templates');
  W = await import('../src/server/whatsapp');
  S = await import('../src/server/sender');
  ST = await import('../src/server/store');
  const { app } = await import('../src/server/app');
  server = app.listen(0);
  await new Promise((r) => server.once('listening', r));
  const a = server.address();
  base = `http://127.0.0.1:${typeof a === 'object' && a ? a.port : 0}`;
  const login = await call('POST', '/api/auth/login', { email: 'owner@example.test', password: 'owner-test-password' });
  cookie = login.cookie!;
});
after(() => {
  server.close();
  fake.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function call(method: string, url: string, body?: unknown, withCookie = true, headers: Record<string, string> = {}) {
  const res = await fetch(base + url, {
    method,
    headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(withCookie && cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const setCookie = res.headers.get('set-cookie');
  return { status: res.status, json: (await res.json()) as Record<string, any>, cookie: setCookie ? setCookie.split(';')[0] : undefined };
}

/* --------------------------------- pure logic --------------------------------- */

test('phone numbers: Indian 10-digit gets +91, international kept, junk rejected', () => {
  assert.equal(L.normalizePhone('98765 43210'), '919876543210');
  assert.equal(L.normalizePhone('+91-98765-43210'), '919876543210');
  assert.equal(L.normalizePhone('09876543210'), '919876543210');
  assert.equal(L.normalizePhone('+44 7700 900123'), '447700900123');
  assert.equal(L.normalizePhone('0044 7700 900123'), '447700900123');
  assert.equal(L.normalizePhone('12345'), null);
  assert.equal(L.normalizePhone('5876543210'), null); // 10 digits not starting 6-9
});

test('tags are normalised and filtered with any / all', () => {
  assert.deepEqual(L.normalizeTags('VIP, vip , #Follow  Up,,'), ['vip', 'follow up']);
  const lead = (id: string, tags: string[]) => ({ id, name: id, phone: '91', tags, status: 'new' as const, source: '', notes: '', opted_in_at: null, created_at: '', updated_at: '' });
  const ls = [lead('a', ['vip', 'diwali']), lead('b', ['vip']), lead('c', ['diwali'])];
  assert.deepEqual(L.filterLeads(ls, { tags: ['vip', 'diwali'], tagMode: 'all' }).map((l) => l.id), ['a']);
  assert.deepEqual(L.filterLeads(ls, { tags: ['vip', 'diwali'], tagMode: 'any' }).map((l) => l.id), ['a', 'b', 'c']);
});

test('CSV import: header detection, quoted tags, invalid rows reported', () => {
  const rows = L.parseCsv('Name,Mobile,Tags\n"Sharma, R",98765 43210,"vip|camp"\nBad,123,\n,9811122233,\n');
  const r = L.rowsToLeads(rows);
  assert.equal(r.leads.length, 2);
  assert.deepEqual(r.leads[0], { name: 'Sharma, R', phone: '919876543210', tags: ['vip', 'camp'], notes: '' });
  assert.equal(r.leads[1].name, '+91 98111 22233');
  assert.deepEqual(r.invalid, [3]);
  // no header: name, phone, tags
  assert.equal(L.rowsToLeads(L.parseCsv('Asha,9876500000,new')).leads[0].tags[0], 'new');
});

test('template variables: header, body, URL button, named params, media header', () => {
  const [appt, offer] = TEMPLATES;
  assert.deepEqual(T.templateVariables(appt).map((v) => v.key), ['header.1', 'body.1', 'body.2', 'body.3', 'button.0.1']);
  assert.equal(T.templateVariables(appt)[2].example, 'Clinic');
  assert.deepEqual(T.templateVariables(offer).map((v) => v.key), ['body.customer_name', 'body.offer']);
  assert.equal(T.mediaHeader(offer), 'image');
  const m = T.defaultMapping(appt);
  assert.equal(m['body.1'].kind, 'first_name');
  assert.deepEqual(m['body.2'], { kind: 'text', text: 'Clinic' });
});

test('payload matches the WhatsApp Cloud API template format', () => {
  const [appt, offer] = TEMPLATES;
  const lead = { name: 'Priya Sharma', phone: '919876543210' };
  const p = T.buildTemplatePayload(appt, { ...T.defaultMapping(appt), 'body.3': { kind: 'text', text: 'Mon 10am' }, 'button.0.1': { kind: 'text', text: 'X9' } }, lead, null) as any;
  assert.equal(p.to, '919876543210');
  assert.equal(p.type, 'template');
  assert.deepEqual(p.template.language, { code: 'en' });
  assert.deepEqual(p.template.components, [
    { type: 'header', parameters: [{ type: 'text', text: 'Priya' }] },
    { type: 'body', parameters: [{ type: 'text', text: 'Priya' }, { type: 'text', text: 'Clinic' }, { type: 'text', text: 'Mon 10am' }] },
    { type: 'button', sub_type: 'url', index: '0', parameters: [{ type: 'text', text: 'X9' }] },
  ]);
  const n = T.buildTemplatePayload(offer, { 'body.customer_name': { kind: 'name' }, 'body.offer': { kind: 'text', text: '20% off' } }, lead, 'https://x.test/a.jpg') as any;
  assert.deepEqual(n.template.components[0], { type: 'header', parameters: [{ type: 'image', image: { link: 'https://x.test/a.jpg' } }] });
  assert.deepEqual(n.template.components[1].parameters[0], { type: 'text', text: 'Priya Sharma', parameter_name: 'customer_name' });
  assert.equal(T.renderPreview(offer, { 'body.customer_name': { kind: 'first_name' }, 'body.offer': { kind: 'text', text: '20% off' } }, lead).body, 'Namaste Priya, 20% off sirf aaj!');
});

test('mapping problems: empty text and missing media link', () => {
  const [, offer] = TEMPLATES;
  const p = T.mappingProblems(offer, { 'body.customer_name': { kind: 'first_name' }, 'body.offer': { kind: 'text', text: ' ' } }, null);
  assert.equal(p.length, 2);
});

test('template list formats from different gateways are understood', () => {
  assert.equal(W.extractTemplates({ data: TEMPLATES }).length, 3);
  assert.equal(W.extractTemplates({ data: { data: TEMPLATES } }).length, 3);
  assert.equal(W.extractTemplates(TEMPLATES).length, 3);
  assert.equal(W.extractTemplates({ success: false }).length, 0);
});

/* ----------------------------------- server ----------------------------------- */

test('everything needs a login', async () => {
  for (const [m, u] of [['GET', '/api/state'], ['POST', '/api/leads'], ['GET', '/api/templates'], ['POST', '/api/campaigns'], ['POST', '/api/send-due']]) {
    assert.equal((await call(m, u, m === 'POST' ? {} : undefined, false)).status, 401, `${m} ${u}`);
  }
  assert.equal((await call('POST', '/api/auth/login', { email: 'owner@example.test', password: 'x' }, false)).status, 401);
  assert.equal((await call('GET', '/api/cron/send-due', undefined, false)).status, 401);
});

test('leads: add, duplicate number refused, edit, import merges tags', async () => {
  const a = await call('POST', '/api/leads', { name: 'Priya', phone: '98765 43210', tags: 'VIP, follow up', opted_in: true });
  assert.equal(a.status, 200);
  assert.deepEqual(a.json.lead.tags, ['vip', 'follow up']);
  assert.ok(a.json.lead.opted_in_at);
  assert.equal((await call('POST', '/api/leads', { name: 'Dup', phone: '+91 98765 43210' })).status, 400);
  assert.equal((await call('POST', '/api/leads', { name: 'X', phone: '123' })).status, 400);
  const e = await call('PATCH', `/api/leads/${a.json.lead.id}`, { status: 'interested' });
  assert.equal(e.json.lead.status, 'interested');
  const imp = await call('POST', '/api/leads/import', {
    rows: [{ name: 'Priya again', phone: '9876543210', tags: ['camp'] }, { name: 'Rahul', phone: '9811122233', tags: [] }, { name: 'Bad', phone: '1' }, { name: 'NoOpt', phone: '9811100000' }],
    tags: ['nov'], opted_in: false,
  });
  assert.deepEqual(imp.json, { created: 2, updated: 1, invalid: 1 });
  const st = await call('GET', '/api/state');
  const priya = st.json.leads.find((l: any) => l.phone === '919876543210');
  assert.equal(priya.name, 'Priya'); // existing details kept
  assert.deepEqual(priya.tags, ['vip', 'follow up', 'camp', 'nov']);
  const rahul = st.json.leads.find((l: any) => l.name === 'Rahul');
  await call('POST', '/api/leads/bulk', { ids: [rahul.id], opted_in: true, add_tags: ['vip'] });
  const st2 = await call('GET', '/api/state');
  assert.ok(st2.json.leads.find((l: any) => l.name === 'Rahul').opted_in_at);
});

test('templates come from the WhatsApp API', async () => {
  const r = await call('GET', '/api/templates?refresh=1');
  assert.equal(r.status, 200);
  assert.equal(r.json.templates.length, 3);
});

test('campaign: only approved templates, only opted-in leads; sender sends once and records results', async () => {
  const st = await call('GET', '/api/state');
  const ids = st.json.leads.map((l: any) => l.id);
  const soon = new Date(Date.now() + 60_000).toISOString();
  const mapping = { 'header.1': { kind: 'first_name' }, 'body.1': { kind: 'first_name' }, 'body.2': { kind: 'text', text: 'Dr A Clinic' }, 'body.3': { kind: 'text', text: 'Monday' }, 'button.0.1': { kind: 'text', text: 'abc' } };

  const pending = await call('POST', '/api/campaigns', { template_name: 'draft_one', template_language: 'en', mapping: {}, send_at: soon, lead_ids: ids });
  assert.equal(pending.status, 400);
  const empty = await call('POST', '/api/campaigns', { template_name: 'appointment_reminder', template_language: 'en', mapping: { ...mapping, 'body.2': { kind: 'text', text: '' } }, send_at: soon, lead_ids: ids });
  assert.equal(empty.status, 400);

  const c = await call('POST', '/api/campaigns', { template_name: 'appointment_reminder', template_language: 'en', mapping, send_at: soon, lead_ids: ids });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.equal(c.json.scheduled, 2); // Priya + Rahul opted in; NoOpt skipped
  assert.equal(c.json.skipped_not_opted_in, 1);

  const store = await ST.getStore();
  // Not due yet
  assert.deepEqual(await S.runDue(store, W.sendMessage, new Date()), { sent: 0, failed: 0, more: false });
  // Due: one succeeds, one fails at WhatsApp
  failNext = true;
  const r = await S.runDue(store, W.sendMessage, new Date(Date.now() + 120_000));
  assert.equal(r.sent + r.failed, 2);
  assert.equal(r.sent, 1);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].template.name, 'appointment_reminder');
  assert.match(sent[0].to, /^91\d{10}$/);
  // Run again: nothing is sent twice
  await S.runDue(store, W.sendMessage, new Date(Date.now() + 180_000));
  assert.equal(sent.length, 1);

  const st2 = await call('GET', '/api/state');
  const msgs = st2.json.messages;
  const ok = msgs.find((m: any) => m.status === 'sent');
  const bad = msgs.find((m: any) => m.status === 'failed');
  assert.equal(ok.wa_message_id, 'wamid.1');
  assert.equal(bad.error, 'Recipient not on WhatsApp');
  const lead = st2.json.leads.find((l: any) => l.id === ok.lead_id);
  assert.notEqual(lead.status, 'new');

  // Retry the failed one: it is sent now
  assert.equal((await call('POST', `/api/messages/${bad.id}/retry`)).status, 200);
  await new Promise((r) => setTimeout(r, 200));
  assert.equal(sent.length, 2);
});

test('cancel, reschedule, opt-out cancels pending, late messages are not sent', async () => {
  const st = await call('GET', '/api/state');
  const priya = st.json.leads.find((l: any) => l.name === 'Priya');
  const at = new Date(Date.now() + 3600_000).toISOString();
  const mapping = { 'body.customer_name': { kind: 'first_name' }, 'body.offer': { kind: 'text', text: '10% off' } };
  const c = await call('POST', '/api/campaigns', { template_name: 'offer_named', template_language: 'hi', mapping, header_media_url: 'https://x.test/a.jpg', send_at: at, lead_ids: [priya.id] });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  const cid = c.json.campaign.id;
  const later = new Date(Date.now() + 7200_000).toISOString();
  assert.equal((await call('POST', `/api/campaigns/${cid}/reschedule`, { send_at: later })).json.rescheduled, 1);
  await call('PATCH', `/api/leads/${priya.id}`, { opted_in: false });
  const st2 = await call('GET', '/api/state');
  assert.equal(st2.json.messages.find((m: any) => m.campaign_id === cid).status, 'cancelled');

  // A message 2 days late is marked failed, not sent.
  const store = await ST.getStore();
  const before = sent.length;
  await store.mutate((doc) => {
    doc.messages.push({ id: 'old', campaign_id: cid, lead_id: priya.id, send_at: new Date(Date.now() - 2 * 86400_000).toISOString(), status: 'scheduled' });
  });
  await S.runDue(store, W.sendMessage);
  assert.equal(sent.length, before);
  const old = (await store.read()).messages.find((m) => m.id === 'old')!;
  assert.equal(old.status, 'failed');
});

test('test send goes out immediately to the given number', async () => {
  const before = sent.length;
  const r = await call('POST', '/api/campaigns/test', {
    template_name: 'offer_named', template_language: 'hi', header_media_url: 'https://x.test/a.jpg',
    mapping: { 'body.customer_name': { kind: 'first_name' }, 'body.offer': { kind: 'text', text: 'Test offer' } }, phone: '9800000001', sample_name: 'Asha K',
  });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).to, '919800000001');
  assert.equal(sent.at(-1).template.components[1].parameters[0].text, 'Asha');
});

test('front end on GitHub Pages: bearer token login and CORS for allowed origins only', async () => {
  const login = await call('POST', '/api/auth/login', { email: 'owner@example.test', password: 'owner-test-password' }, false);
  assert.ok(login.json.token);
  const withToken = await call('GET', '/api/state', undefined, false, { Authorization: `Bearer ${login.json.token}` });
  assert.equal(withToken.status, 200);
  assert.equal((await call('GET', '/api/state', undefined, false, { Authorization: 'Bearer forged.token' })).status, 401);

  const pre = await fetch(base + '/api/state', { method: 'OPTIONS', headers: { Origin: 'https://itsasoeternity.github.io', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'https://itsasoeternity.github.io');
  assert.match(pre.headers.get('access-control-allow-headers') ?? '', /Authorization/);
  const evil = await fetch(base + '/api/state', { method: 'OPTIONS', headers: { Origin: 'https://evil.example' } });
  assert.equal(evil.status, 403);
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

const hook = (value: unknown) => ({ object: 'whatsapp_business_account', entry: [{ id: 'WABA1', changes: [{ field: 'messages', value }] }] });

test('webhook: needs the key; replies land in the lead chat once; unknown numbers become leads', async () => {
  const body = hook({
    contacts: [{ wa_id: '919876543210', profile: { name: 'Priya S' } }],
    messages: [{ id: 'wamid.in1', from: '919876543210', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'Kal aa sakti hoon?' } }],
  });
  assert.equal((await call('POST', '/api/webhook/whatsapp', body, false)).status, 403);
  assert.equal((await call('POST', '/api/webhook/whatsapp?key=wrong', body, false)).status, 403);
  assert.equal((await call('POST', '/api/webhook/whatsapp?key=hook-key', body, false)).status, 200);
  assert.equal((await call('POST', '/api/webhook/whatsapp?key=hook-key', body, false)).status, 200); // duplicate delivery
  const stranger = hook({
    contacts: [{ wa_id: '447700900123', profile: { name: 'New Person' } }],
    messages: [{ id: 'wamid.in2', from: '447700900123', timestamp: '1700000000', type: 'image', image: { caption: 'report' } }],
  });
  await call('POST', '/api/webhook/whatsapp?key=hook-key', stranger, false);

  const st = await call('GET', '/api/state');
  const priya = st.json.leads.find((l: any) => l.phone === '919876543210');
  const inMsgs = st.json.chats.filter((c: any) => c.lead_id === priya.id && c.kind === 'in');
  assert.equal(inMsgs.length, 1);
  assert.equal(inMsgs[0].text, 'Kal aa sakti hoon?');
  assert.ok(priya.last_inbound_at);
  const newLead = st.json.leads.find((l: any) => l.phone === '447700900123');
  assert.equal(newLead.name, 'New Person');
  assert.deepEqual(newLead.tags, ['whatsapp']);
  assert.equal(newLead.opted_in_at, null);
  assert.equal(st.json.chats.find((c: any) => c.lead_id === newLead.id).text, '[image] report');

  // Meta verification handshake
  const v = await fetch(base + '/api/webhook/whatsapp?hub.mode=subscribe&hub.verify_token=hook-key&hub.challenge=abc');
  assert.equal(await v.text(), 'abc');
});

test('chat: notes saved and deletable; reply only within 24 h; statuses update ticks', async () => {
  const st = await call('GET', '/api/state');
  const priya = st.json.leads.find((l: any) => l.phone === '919876543210');
  const rahul = st.json.leads.find((l: any) => l.name === 'Rahul');
  const note = await call('POST', `/api/leads/${priya.id}/notes`, { text: 'Called, coming Monday 11am' });
  assert.equal(note.status, 200);
  assert.equal(note.json.entry.kind, 'note');

  // Rahul never wrote to us: free text is refused
  const no = await call('POST', `/api/leads/${rahul.id}/reply`, { text: 'Hello' });
  assert.equal(no.status, 400);
  assert.match(no.json.error, /24 hours/);

  // Priya wrote just now: reply goes out as WhatsApp text
  const before = sent.length;
  const yes = await call('POST', `/api/leads/${priya.id}/reply`, { text: 'Haan, 11 baje aa jaiye' });
  assert.equal(yes.status, 200, JSON.stringify(yes.json));
  assert.equal(sent.length, before + 1);
  assert.deepEqual(sent.at(-1).text, { preview_url: false, body: 'Haan, 11 baje aa jaiye' });
  const waId = yes.json.entry.wa_message_id;

  // delivery + read receipts for the reply and for a template message
  const st2 = await call('GET', '/api/state');
  const tpl = st2.json.messages.find((m: any) => m.status === 'sent' && m.wa_message_id);
  assert.ok(tpl.text, 'sent template keeps the text the lead received');
  await call('POST', '/api/webhook/whatsapp?key=hook-key', hook({ statuses: [
    { id: waId, status: 'delivered', timestamp: '1700000001' },
    { id: waId, status: 'read', timestamp: '1700000002' },
    { id: waId, status: 'delivered', timestamp: '1700000003' }, // late, must not downgrade
    { id: tpl.wa_message_id, status: 'read', timestamp: '1700000004' },
  ] }), false);
  const st3 = await call('GET', '/api/state');
  assert.equal(st3.json.chats.find((c: any) => c.wa_message_id === waId).status, 'read');
  const tpl2 = st3.json.messages.find((m: any) => m.id === tpl.id);
  assert.ok(tpl2.read_at && tpl2.delivered_at);

  // only notes can be deleted
  assert.equal((await call('DELETE', `/api/chats/${yes.json.entry.id}`)).status, 400);
  assert.equal((await call('DELETE', `/api/chats/${note.json.entry.id}`)).status, 200);
});

/* ------------------------------ tag automations ------------------------------ */

test('automation timing: days later at a fixed India time, never in the past', async () => {
  const A = await import('../src/lib/automation');
  // 14 Nov 2026 15:00 IST = 09:30 UTC
  const tagged = new Date('2026-11-14T09:30:00Z');
  assert.equal(A.stepTime(tagged, 3, '10:00').toISOString(), '2026-11-17T04:30:00.000Z'); // 17 Nov 10:00 IST
  // late evening IST that is still "yesterday" in UTC: 14 Nov 23:30 IST = 18:00 UTC
  assert.equal(A.stepTime(new Date('2026-11-14T18:00:00Z'), 1, '09:00').toISOString(), '2026-11-15T03:30:00.000Z');
  const plan = A.planSteps({ steps: [
    { id: 'a', delay_days: 0, time: '10:00' }, // already past 10:00 today -> a minute from now
    { id: 'b', delay_days: 3, time: '10:00' },
    { id: 'c', delay_days: 4, time: '18:30' },
  ] as any }, tagged);
  assert.equal(plan[0].at.toISOString(), '2026-11-14T09:31:00.000Z');
  assert.equal(plan[1].at.toISOString(), '2026-11-17T04:30:00.000Z');
  assert.equal(plan[2].at.toISOString(), '2026-11-21T13:00:00.000Z'); // 21 Nov 18:30 IST
});

test('tags: create with colour, rename moves it on leads, delete removes it', async () => {
  assert.equal((await call('POST', '/api/tags', { name: 'Follow Up', color: 'rose', description: 'Needs a call' })).status, 200);
  assert.equal((await call('POST', '/api/tags', { name: 'follow up' })).status, 400); // duplicate
  const a = await call('POST', '/api/leads', { name: 'Tag Test', phone: '9822200001', tags: ['follow up'] });
  assert.equal((await call('PUT', '/api/tags/follow%20up', { name: 'callback', color: 'amber', description: 'x' })).status, 200);
  let st = await call('GET', '/api/state');
  assert.deepEqual(st.json.leads.find((l: any) => l.id === a.json.lead.id).tags, ['callback']);
  assert.equal(st.json.tag_defs.find((d: any) => d.name === 'callback').color, 'amber');
  assert.equal((await call('DELETE', '/api/tags/callback')).status, 200);
  st = await call('GET', '/api/state');
  assert.deepEqual(st.json.leads.find((l: any) => l.id === a.json.lead.id).tags, []);
});

test('automation: adding the tag schedules all steps; removing tag / reply / converted stops them', async () => {
  const step = (days: number, time: string) => ({
    template_name: 'appointment_reminder', template_language: 'en', delay_days: days, time,
    mapping: { 'header.1': { kind: 'first_name' }, 'body.1': { kind: 'first_name' }, 'body.2': { kind: 'text', text: 'Clinic' }, 'body.3': { kind: 'text', text: 'soon' }, 'button.0.1': { kind: 'text', text: 'x' } },
  });
  const bad = await call('PUT', '/api/sequences/new%20patient', { steps: [{ ...step(3, '10:00'), template_name: 'draft_one' }] });
  assert.equal(bad.status, 400); // pending template
  const ok = await call('PUT', '/api/sequences/new%20patient', { steps: [step(3, '10:00'), step(4, '18:00')] });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const seqId = ok.json.sequence.id;

  const pending = async (leadId: string) => (await call('GET', '/api/state')).json.messages.filter((m: any) => m.lead_id === leadId && m.sequence_id === seqId);

  // 1. opted-in lead gets the tag -> 2 messages scheduled, 3 days and 7 days out
  const l1 = (await call('POST', '/api/leads', { name: 'Auto One', phone: '9833300001', opted_in: true })).json.lead;
  await call('POST', '/api/leads/bulk', { ids: [l1.id], add_tags: ['new patient'] });
  let ms = await pending(l1.id);
  assert.equal(ms.length, 2);
  const days = (iso: string) => (Date.parse(iso) - Date.now()) / 86400_000;
  assert.ok(days(ms[0].send_at) > 2 && days(ms[0].send_at) < 4, ms[0].send_at);
  assert.ok(days(ms[1].send_at) > 6 && days(ms[1].send_at) < 8, ms[1].send_at);
  // adding the tag again does not double it
  await call('PATCH', `/api/leads/${l1.id}`, { tags: ['new patient', 'vip'] });
  assert.equal((await pending(l1.id)).filter((m: any) => m.status === 'scheduled').length, 2);
  // removing the tag cancels
  await call('POST', '/api/leads/bulk', { ids: [l1.id], remove_tags: ['new patient'] });
  ms = await pending(l1.id);
  assert.ok(ms.every((m: any) => m.status === 'cancelled'));
  assert.match(ms[0].error, /removed/);

  // 2. not opted in -> nothing; opting in later starts it
  const l2 = (await call('POST', '/api/leads', { name: 'Auto Two', phone: '9833300002', tags: ['new patient'] })).json.lead;
  assert.equal((await pending(l2.id)).length, 0);
  await call('PATCH', `/api/leads/${l2.id}`, { opted_in: true });
  assert.equal((await pending(l2.id)).length, 2);
  // converted -> stops
  await call('PATCH', `/api/leads/${l2.id}`, { status: 'converted' });
  assert.ok((await pending(l2.id)).every((m: any) => m.status === 'cancelled'));

  // 3. import with the tag starts it; the lead replying stops it
  await call('POST', '/api/leads/import', { rows: [{ name: 'Auto Three', phone: '9833300003', tags: ['new patient'] }], tags: [], opted_in: true });
  const l3 = (await call('GET', '/api/state')).json.leads.find((l: any) => l.phone === '919833300003');
  assert.equal((await pending(l3.id)).length, 2);
  await call('POST', '/api/webhook/whatsapp?key=hook-key', hook({ messages: [{ id: 'wamid.auto3', from: '919833300003', timestamp: String(Math.floor(Date.now() / 1000)), type: 'text', text: { body: 'ok' } }] }), false);
  ms = await pending(l3.id);
  assert.ok(ms.every((m: any) => m.status === 'cancelled'));
  assert.equal(ms[0].error, 'Lead replied');

  // 4. the sender sends an automation step when it is due
  const l4 = (await call('POST', '/api/leads', { name: 'Auto Four', phone: '9833300004', opted_in: true, tags: ['new patient'] })).json.lead;
  const store = await ST.getStore();
  const before = sent.length;
  const first = (await pending(l4.id)).sort((a: any, b: any) => a.send_at.localeCompare(b.send_at))[0];
  await S.runDue(store, W.sendMessage, new Date(Date.parse(first.send_at) + 60_000));
  assert.equal(sent.length, before + 1);
  assert.equal(sent.at(-1).to, '919833300004');
  ms = await pending(l4.id);
  assert.equal(ms.filter((m: any) => m.status === 'sent').length, 1);
  assert.ok(ms.find((m: any) => m.status === 'sent').text.includes('Dear Auto'));

  // switching the automation off cancels what is pending
  await call('PUT', '/api/sequences/new%20patient', { enabled: false, steps: [step(3, '10:00'), step(4, '18:00')] });
  assert.ok((await pending(l4.id)).filter((m: any) => m.status === 'scheduled').length === 0);
});

test('webhook: gateway formats (array, data wrapper, bare value) are understood; recent deliveries are kept', async () => {
  const W2 = await import('../src/server/webhook');
  const value = { messages: [{ id: 'x1', from: '919800000009', timestamp: '1700000000', type: 'text', text: { body: 'hi' } }], statuses: [{ id: 'y1', status: 'read', timestamp: '1700000001' }] };
  for (const body of [hook(value), [hook(value)], { data: hook(value) }, { field: 'messages', value }, value]) {
    const ev = W2.parseWebhook(body);
    assert.equal(ev.messages.length, 1, JSON.stringify(body).slice(0, 80));
    assert.equal(ev.statuses.length, 1);
  }
  assert.equal(W2.parseWebhook({ hello: 'world' }).messages.length, 0);

  await call('POST', '/api/webhook/whatsapp?key=hook-key', { something: 'unexpected' }, false);
  const recent = await call('GET', '/api/webhook/recent');
  assert.equal(recent.status, 200);
  assert.equal(recent.json.configured, true);
  assert.equal(recent.json.deliveries[0].messages, 0);
  assert.match(recent.json.deliveries[0].body, /unexpected/);
  assert.equal((await call('GET', '/api/webhook/recent', undefined, false)).status, 401);
  assert.equal((await call('GET', '/api/state')).json.webhook_log, undefined);
});

test('webhook: key can be part of the URL path', async () => {
  const body = hook({ messages: [{ id: 'wamid.path1', from: '919800000077', timestamp: '1700000000', type: 'text', text: { body: 'via path' } }] });
  assert.equal((await call('POST', '/api/webhook/whatsapp/wrong', body, false)).status, 403);
  assert.equal((await call('POST', '/api/webhook/whatsapp/hook-key', body, false)).status, 200);
  const st = await call('GET', '/api/state');
  assert.ok(st.json.chats.some((c: any) => c.text === 'via path'));
  const v = await fetch(base + '/api/webhook/whatsapp/hook-key?hub.mode=subscribe&hub.challenge=ok1');
  assert.equal(await v.text(), 'ok1');
});

test('login: ends with the browser unless "keep me signed in"; /me shows the email', async () => {
  const raw = async (remember: boolean) =>
    (await fetch(base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'owner@example.test', password: 'owner-test-password', remember }) })).headers.get('set-cookie') ?? '';
  assert.doesNotMatch(await raw(false), /Max-Age/);
  assert.match(await raw(true), /Max-Age=2592000/);
  const me = await call('GET', '/api/auth/me');
  assert.equal(me.json.email, 'owner@example.test');
  assert.equal((await call('GET', '/api/auth/me', undefined, false)).json.email, undefined);
});
