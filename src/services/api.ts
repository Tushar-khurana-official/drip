/** Browser client for the Drip API. The session is an httpOnly cookie. */
import type { BusinessProfile, Lead, MessageTemplate, ScheduledMessage } from '../types';

export interface DripData {
  profile: BusinessProfile;
  leads: Lead[];
  templates: MessageTemplate[];
  scheduled: ScheduledMessage[];
}

export class ApiError extends Error {
  constructor(message: string, public status: number) {
    super(message);
  }
}

async function call<T>(method: string, url: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      credentials: 'same-origin',
      headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Server se connect nahi ho paya. Internet check karein.', 0);
  }
  const text = await res.text();
  let json: Record<string, unknown> = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    throw new ApiError('Server (API) nahi mila.', res.status || 0);
  }
  if (!res.ok) throw new ApiError(String(json.error ?? `Error ${res.status}`), res.status);
  return json as T;
}

export const api = {
  me: () => call<{ loggedIn: boolean; loginConfigured: boolean }>('GET', '/api/auth/me'),
  login: (email: string, password: string) => call<{ loggedIn: boolean }>('POST', '/api/auth/login', { email, password }),
  logout: () => call<{ ok: boolean }>('POST', '/api/auth/logout'),
  loadData: () => call<{ data: DripData; updated_at: string | null; storage_persistent: boolean }>('GET', '/api/data'),
  saveData: (data: DripData) => call<{ ok: boolean; saved_at: string }>('PUT', '/api/data', { data }),
};
