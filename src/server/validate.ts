import type { DripData } from './types.js';

const LIMITS: Record<string, number> = { leads: 20000, templates: 200, scheduled: 100000 };

/** Shape and size checks on data uploaded by the browser. Returns an error message or null. */
export function validateData(d: unknown): string | null {
  if (!d || typeof d !== 'object') return 'data must be an object';
  const x = d as Record<string, unknown>;
  const p = x.profile as Record<string, unknown> | undefined;
  if (!p || typeof p !== 'object' || typeof p.name !== 'string') return 'profile missing';
  for (const [k, max] of Object.entries(LIMITS)) {
    if (!Array.isArray(x[k])) return `${k} must be an array`;
    if ((x[k] as unknown[]).length > max) return `too many ${k}`;
  }
  for (const l of x.leads as Array<Record<string, unknown>>) {
    if (typeof l.id !== 'string' || typeof l.name !== 'string' || !Array.isArray(l.tags)) return 'bad lead';
  }
  for (const m of x.scheduled as Array<Record<string, unknown>>) {
    if (typeof m.id !== 'string' || typeof m.lead_id !== 'string' || typeof m.template_id !== 'string') return 'bad scheduled message';
    if (typeof m.send_at !== 'string' || Number.isNaN(Date.parse(m.send_at))) return 'bad send_at';
    if (!['scheduled', 'sent', 'failed', 'cancelled'].includes(m.status as string)) return 'bad scheduled status';
  }
  for (const t of x.templates as Array<Record<string, unknown>>) {
    if (typeof t.body !== 'string' || t.body.length > 2000) return 'template body must be text up to 2000 characters';
  }
  return null;
}

export function cleanProfile(p: DripData['profile']): DripData['profile'] {
  const c = (v: unknown, max = 120) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
  return { name: c(p.name) || 'Meri Dukaan', owner: c(p.owner), upi_id: c(p.upi_id, 260) };
}
