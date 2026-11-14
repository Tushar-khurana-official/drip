/** Browser client for the Drip API. The session is an httpOnly cookie. */
import type { BusinessSettings, Campaign, ChatEntry, Lead, LeadStatus, Message, VarSource, WaTemplate } from '../types';

export interface AppState {
  settings: BusinessSettings;
  leads: Lead[];
  campaigns: Campaign[];
  messages: Message[];
  chats: ChatEntry[];
  whatsapp: { sending: boolean; templates: boolean };
  storage_persistent: boolean;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

/**
 * Where the API lives. Empty = same server as this page (npm start / Vercel). Set VITE_API_URL at build time
 * when the page is hosted elsewhere (GitHub Pages); login then uses a token kept in this browser.
 */
export const API_URL = String(import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');
const TOKEN_KEY = 'drip_token';
/** Static hosting without an API configured: nothing can work, show the setup screen. */
export const apiMissing = !API_URL && /\.github\.io$/.test(window.location.hostname);

function token(): string | null {
  try {
    return API_URL ? localStorage.getItem(TOKEN_KEY) : null;
  } catch {
    return null;
  }
}
function setToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN_KEY, t);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // private mode: login lasts until the page is closed
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  const t = token();
  try {
    res = await fetch(API_URL + url, {
      method,
      credentials: API_URL ? 'omit' : 'same-origin',
      headers: {
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(t ? { Authorization: `Bearer ${t}` } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Cannot reach the server. Check your internet connection.', 0);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError('The server did not answer properly.', res.status || 0);
  }
  if (res.status === 401 && !url.startsWith('/api/auth/')) {
    setToken(null);
    window.location.reload();
  }
  if (!res.ok) throw new ApiError(String(json.error ?? `Error ${res.status}`), res.status);
  return json as T;
}

export interface CampaignInput {
  name?: string;
  template_name: string;
  template_language: string;
  mapping: Record<string, VarSource>;
  header_media_url: string | null;
  send_at?: string;
  lead_ids?: string[];
}

export const api = {
  me: () => call<{ loggedIn: boolean; loginConfigured: boolean }>('GET', '/api/auth/me'),
  login: async (email: string, password: string) => {
    const r = await call<{ loggedIn: boolean; token?: string }>('POST', '/api/auth/login', { email, password });
    if (API_URL && r.token) setToken(r.token);
    return r;
  },
  logout: async () => {
    setToken(null);
    return call('POST', '/api/auth/logout');
  },
  state: () => call<AppState>('GET', '/api/state'),
  saveSettings: (name: string) => call('PUT', '/api/settings', { name }),

  addLead: (l: { name: string; phone: string; tags: string[]; source: string; notes: string; opted_in: boolean }) =>
    call<{ lead: Lead }>('POST', '/api/leads', l),
  updateLead: (id: string, l: Partial<{ name: string; phone: string; tags: string[]; status: LeadStatus; source: string; notes: string; opted_in: boolean }>) =>
    call<{ lead: Lead }>('PATCH', `/api/leads/${encodeURIComponent(id)}`, l),
  bulk: (b: { ids: string[]; add_tags?: string[]; remove_tags?: string[]; status?: LeadStatus; opted_in?: boolean; delete?: boolean }) =>
    call<{ changed: number }>('POST', '/api/leads/bulk', b),
  importLeads: (b: { rows: Array<{ name: string; phone: string; tags: string[]; notes: string }>; tags: string[]; opted_in: boolean; source: string }) =>
    call<{ created: number; updated: number; invalid: number }>('POST', '/api/leads/import', b),

  templates: (refresh = false) => call<{ templates: WaTemplate[] }>('GET', `/api/templates${refresh ? '?refresh=1' : ''}`),
  createCampaign: (c: CampaignInput) => call<{ scheduled: number; skipped_not_opted_in: number }>('POST', '/api/campaigns', c),
  testSend: (c: CampaignInput & { phone: string; sample_name: string }) => call<{ ok: boolean }>('POST', '/api/campaigns/test', c),
  cancelCampaign: (id: string) => call<{ cancelled: number }>('POST', `/api/campaigns/${encodeURIComponent(id)}/cancel`),
  rescheduleCampaign: (id: string, send_at: string) => call('POST', `/api/campaigns/${encodeURIComponent(id)}/reschedule`, { send_at }),
  cancelMessage: (id: string) => call('POST', `/api/messages/${encodeURIComponent(id)}/cancel`),
  retryMessage: (id: string) => call('POST', `/api/messages/${encodeURIComponent(id)}/retry`),
  addNote: (leadId: string, text: string) => call<{ entry: ChatEntry }>('POST', `/api/leads/${encodeURIComponent(leadId)}/notes`, { text }),
  deleteNote: (id: string) => call('DELETE', `/api/chats/${encodeURIComponent(id)}`),
  reply: (leadId: string, text: string) => call<{ entry: ChatEntry }>('POST', `/api/leads/${encodeURIComponent(leadId)}/reply`, { text }),
  sendDue: () => call<{ sent: number; failed: number }>('POST', '/api/send-due'),
};
