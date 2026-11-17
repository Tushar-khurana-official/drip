/**
 * WhatsApp webhook (Meta Cloud API format): incoming messages from leads and delivery / read statuses
 * for messages Drip sent. The provider (setu360) must forward the webhook to:
 *
 *   https://<drip-server>/api/webhook/whatsapp?key=<WHATSAPP_WEBHOOK_KEY>
 *
 * The key in the URL proves the call comes from the provider. If Meta calls it directly, the GET
 * verification uses the same value as hub.verify_token, and X-Hub-Signature-256 is checked when
 * WHATSAPP_APP_SECRET is set.
 */
import crypto from 'node:crypto';
import type { ChatEntry, DripDoc, Lead } from '../types.js';
import { normalizePhone } from '../lib/leads.js';

export interface WebhookEvents {
  messages: Array<{ wa_id: string; from: string; name?: string; text: string; type: string; at: string }>;
  statuses: Array<{ wa_id: string; status: string; at: string; error?: string }>;
}

const ts = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : new Date().toISOString();
};

/** Text shown in the chat for any incoming message type. */
function describe(m: Record<string, any>): string {
  switch (m.type) {
    case 'text':
      return String(m.text?.body ?? '');
    case 'button':
      return String(m.button?.text ?? '');
    case 'interactive':
      return String(m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? '[reply]');
    case 'image':
    case 'video':
    case 'document':
    case 'audio':
    case 'sticker': {
      const caption = m[m.type]?.caption || m[m.type]?.filename;
      return caption ? `[${m.type}] ${caption}` : `[${m.type}]`;
    }
    case 'location':
      return `[location] ${m.location?.name ?? ''} ${m.location?.latitude ?? ''},${m.location?.longitude ?? ''}`.trim();
    case 'reaction':
      return `[reaction] ${m.reaction?.emoji ?? ''}`;
    default:
      return `[${m.type ?? 'message'}]`;
  }
}

/**
 * Pull messages and statuses out of a webhook body. Accepts Meta's format ({entry:[{changes:[{value}]}]})
 * and the shapes gateways commonly forward: an array of those, {data: ...}, a bare change {field, value},
 * or a bare value {messages, statuses, contacts}.
 */
export function parseWebhook(body: unknown): WebhookEvents {
  const out: WebhookEvents = { messages: [], statuses: [] };
  const values: Array<Record<string, any>> = [];
  const visit = (x: unknown, depth = 0) => {
    if (!x || typeof x !== 'object' || depth > 4) return;
    if (Array.isArray(x)) return x.forEach((y) => visit(y, depth + 1));
    const o = x as Record<string, any>;
    if (Array.isArray(o.entry)) return o.entry.forEach((e: any) => (e?.changes ?? []).forEach((c: any) => visit(c?.value, depth + 1)));
    if (o.value && typeof o.value === 'object' && !Array.isArray(o.value)) return visit(o.value, depth + 1);
    if (Array.isArray(o.messages) || Array.isArray(o.statuses)) return void values.push(o);
    for (const k of ['data', 'payload', 'body', 'webhook']) if (o[k] && typeof o[k] === 'object') return visit(o[k], depth + 1);
  };
  visit(body);
  for (const v of values) {
    const names = new Map<string, string>((v.contacts ?? []).map((x: any) => [String(x.wa_id), String(x.profile?.name ?? '')]));
    for (const m of v.messages ?? []) {
      if (!m?.from || !m?.id) continue;
      out.messages.push({ wa_id: String(m.id), from: String(m.from), name: names.get(String(m.from)) || undefined, text: describe(m), type: String(m.type ?? 'text'), at: ts(m.timestamp) });
    }
    for (const st of v.statuses ?? []) {
      if (!st?.id || !st?.status) continue;
      const err = st.errors?.[0];
      out.statuses.push({ wa_id: String(st.id), status: String(st.status), at: ts(st.timestamp), error: err ? String(err.error_data?.details || err.title || err.message || err.code) : undefined });
    }
  }
  return out;
}

const RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3 };

/** Apply webhook events to the document. Returns counts. Unknown numbers become new leads. */
export function applyWebhook(doc: DripDoc, ev: WebhookEvents, makeId: (p: string) => string) {
  let messages = 0, statuses = 0, newLeads = 0;
  const repliedLeadIds = new Set<string>();
  doc.chats ??= [];
  const seen = new Set(doc.chats.filter((c) => c.wa_message_id).map((c) => c.wa_message_id));
  for (const m of ev.messages) {
    if (seen.has(m.wa_id)) continue; // webhooks can be delivered more than once
    const phone = normalizePhone(m.from) ?? m.from.replace(/\D/g, '');
    let lead = doc.leads.find((l) => l.phone === phone);
    if (!lead) {
      const now = new Date().toISOString();
      lead = { id: makeId('lead'), name: m.name || `+${phone}`, phone, tags: ['whatsapp'], status: 'new', source: 'WhatsApp', notes: '', opted_in_at: null, created_at: now, updated_at: now } as Lead;
      doc.leads.unshift(lead);
      newLeads++;
    }
    const entry: ChatEntry = { id: makeId('chat'), lead_id: lead.id, kind: 'in', text: m.text, at: m.at, wa_message_id: m.wa_id };
    if (m.type !== 'text') entry.media_type = m.type;
    doc.chats.push(entry);
    seen.add(m.wa_id);
    repliedLeadIds.add(lead.id);
    lead.last_inbound_at = !lead.last_inbound_at || m.at > lead.last_inbound_at ? m.at : lead.last_inbound_at;
    if (lead.status === 'new' || lead.status === 'contacted') lead.status = 'interested';
    lead.updated_at = new Date().toISOString();
    messages++;
  }
  for (const s of ev.statuses) {
    const msg = doc.messages.find((x) => x.wa_message_id === s.wa_id);
    const chat = doc.chats.find((x) => x.kind === 'out' && x.wa_message_id === s.wa_id);
    if (!msg && !chat) continue;
    statuses++;
    if (s.status === 'failed') {
      if (msg) Object.assign(msg, { status: 'failed', error: s.error ?? 'Not delivered' });
      if (chat) Object.assign(chat, { status: 'failed', error: s.error ?? 'Not delivered' });
      continue;
    }
    if (msg) {
      if (s.status === 'delivered' && !msg.delivered_at) msg.delivered_at = s.at;
      if (s.status === 'read') {
        msg.read_at ??= s.at;
        msg.delivered_at ??= s.at;
      }
    }
    if (chat && (RANK[s.status] ?? 0) > (RANK[chat.status ?? 'sent'] ?? 0)) chat.status = s.status as ChatEntry['status'];
  }
  return { messages, statuses, newLeads, repliedLeadIds: [...repliedLeadIds] };
}

export function webhookKeyOk(key: unknown): boolean {
  const want = process.env.WHATSAPP_WEBHOOK_KEY?.trim();
  if (!want || typeof key !== 'string') return false;
  const a = crypto.createHash('sha256').update(key.trim()).digest();
  const b = crypto.createHash('sha256').update(want).digest();
  return crypto.timingSafeEqual(a, b);
}

export function signatureOk(raw: Buffer | undefined, header: unknown): boolean {
  const secret = process.env.WHATSAPP_APP_SECRET;
  if (!secret) return true;
  if (!raw || typeof header !== 'string' || !header.startsWith('sha256=')) return false;
  const want = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  const got = header.slice(7);
  return got.length === want.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want));
}

/** WhatsApp only delivers free text within 24 hours of the lead's last message. */
export function canReply(lead: Pick<Lead, 'last_inbound_at'>, now = Date.now()): boolean {
  return Boolean(lead.last_inbound_at && now - Date.parse(lead.last_inbound_at) < 24 * 3600_000);
}
