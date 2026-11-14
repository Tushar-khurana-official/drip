/**
 * WhatsApp API client (Meta Cloud API format, reached through the provider's gateway).
 *
 *   WHATSAPP_API_BASE          default https://crmapi.setu360.com/api/meta/v19.0
 *   WHATSAPP_TOKEN             sent as "Authorization: Bearer <token>"
 *   WHATSAPP_PHONE_NUMBER_ID   the sending number: POST {base}/{id}/messages
 *   WHATSAPP_WABA_ID           the WhatsApp Business Account: GET {base}/{waba}/message_templates?json=true
 *
 * Logs never contain phone numbers or message text.
 */
import type { WaTemplate } from '../types.js';

const base = () => (process.env.WHATSAPP_API_BASE || 'https://crmapi.setu360.com/api/meta/v19.0').replace(/\/+$/, '');

export function waConfig() {
  return {
    sending: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_PHONE_NUMBER_ID),
    templates: Boolean(process.env.WHATSAPP_TOKEN && process.env.WHATSAPP_WABA_ID),
  };
}

function errorText(body: unknown, status: number): string {
  const b = body as { error?: unknown; message?: string } | null;
  const e = b?.error as { message?: string; error_user_msg?: string; code?: number } | string | undefined;
  const msg = typeof e === 'string' ? e : e?.error_user_msg || e?.message || b?.message;
  return String(msg || `HTTP ${status}`).slice(0, 300);
}

async function request(method: 'GET' | 'POST', url: string, body?: unknown): Promise<{ ok: boolean; status: number; json: unknown }> {
  const res = await fetch(url, {
    method,
    headers: { Authorization: `Bearer ${process.env.WHATSAPP_TOKEN}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(20_000),
  });
  const json = await res.json().catch(() => null);
  const failed = !res.ok || (json && typeof json === 'object' && (json as { success?: boolean }).success === false) || (json as { error?: unknown })?.error;
  return { ok: !failed, status: res.status, json };
}

/** Accepts {data:[...]}, {templates:[...]}, {data:{data:[...]}} or a bare array. */
export function extractTemplates(json: unknown): WaTemplate[] {
  const j = json as Record<string, unknown> | unknown[] | null;
  const list = Array.isArray(j)
    ? j
    : (j?.data as { data?: unknown[] })?.data ?? (Array.isArray(j?.data) ? j?.data : null) ?? (j?.templates as unknown[]) ?? [];
  return (list as WaTemplate[])
    .filter((t) => t && typeof t.name === 'string')
    .map((t) => ({ ...t, language: String(t.language ?? 'en'), status: String(t.status ?? 'UNKNOWN').toUpperCase(), components: t.components ?? [] }));
}

let cache: { at: number; templates: WaTemplate[] } | null = null;

export async function fetchTemplates(force = false): Promise<WaTemplate[]> {
  if (!waConfig().templates) throw new Error('Set WHATSAPP_TOKEN and WHATSAPP_WABA_ID to load templates.');
  if (!force && cache && Date.now() - cache.at < 5 * 60_000) return cache.templates;
  const all: WaTemplate[] = [];
  let url: string | null = `${base()}/${process.env.WHATSAPP_WABA_ID}/message_templates?json=true&limit=100`;
  for (let page = 0; url && page < 20; page++) {
    const r = await request('GET', url);
    if (!r.ok) throw new Error(`Templates: ${errorText(r.json, r.status)}`);
    all.push(...extractTemplates(r.json));
    const next = (r.json as { paging?: { next?: string } })?.paging?.next;
    // Follow paging only through our own gateway.
    url = next && next.startsWith(base()) ? next : null;
  }
  cache = { at: Date.now(), templates: all };
  return all;
}

export type Sender = (payload: Record<string, unknown>) => Promise<{ ok: boolean; id?: string; error?: string }>;

/** Free-text message (only delivered within 24 hours of the lead's last message to us). */
export function textPayload(to: string, body: string): Record<string, unknown> {
  return { messaging_product: 'whatsapp', recipient_type: 'individual', to, type: 'text', text: { preview_url: false, body } };
}

export const sendMessage: Sender = async (payload) => {
  try {
    const r = await request('POST', `${base()}/${process.env.WHATSAPP_PHONE_NUMBER_ID}/messages`, payload);
    if (!r.ok) return { ok: false, error: errorText(r.json, r.status) };
    const id = (r.json as { messages?: Array<{ id?: string }> })?.messages?.[0]?.id;
    return { ok: true, id };
  } catch {
    return { ok: false, error: 'Could not reach the WhatsApp API' };
  }
};
