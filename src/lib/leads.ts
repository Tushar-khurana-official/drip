import type { Lead, LeadStatus } from '../types.js';

export const LEAD_STATUSES: LeadStatus[] = ['new', 'contacted', 'interested', 'converted', 'lost'];
export const STATUS_LABEL: Record<LeadStatus, string> = {
  new: 'New',
  contacted: 'Contacted',
  interested: 'Interested',
  converted: 'Converted',
  lost: 'Lost',
};

/** "VIP, vip , #Follow up" -> ["vip", "follow up"] */
export function normalizeTags(input: string | string[]): string[] {
  const parts = Array.isArray(input) ? input : input.split(',');
  const out: string[] = [];
  for (const p of parts) {
    const t = String(p).trim().toLowerCase().replace(/\s+/g, ' ').replace(/^#/, '').slice(0, 40);
    if (t && !out.includes(t)) out.push(t);
  }
  return out;
}

/**
 * Phone -> digits with country code. A 10-digit number starting 6-9 is taken as Indian (+91);
 * "0" + 10 digits likewise. Anything with a country code (11-15 digits, optional +) is kept.
 */
export function normalizePhone(input: string, defaultCountry = '91'): string | null {
  const raw = String(input).trim();
  let d = raw.replace(/\D/g, '');
  if (raw.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && /^[6-9]/.test(d)) return defaultCountry + d;
  if (d.length === 11 && d.startsWith('0') && /^[6-9]/.test(d[1])) return defaultCountry + d.slice(1);
  if (d.length >= 11 && d.length <= 15 && !d.startsWith('0')) return d;
  return null;
}

export function formatPhone(digits: string): string {
  if (digits.startsWith('91') && digits.length === 12) return `+91 ${digits.slice(2, 7)} ${digits.slice(7)}`;
  return `+${digits}`;
}

export function firstName(name: string): string {
  const clean = name.replace(/\(.*?\)/g, '').trim();
  return clean.split(/\s+/)[0] || clean;
}

export function allTags(leads: Pick<Lead, 'tags'>[]): Array<{ tag: string; count: number }> {
  const counts = new Map<string, number>();
  for (const l of leads) for (const t of l.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts].map(([tag, count]) => ({ tag, count })).sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

export interface LeadFilter {
  query?: string;
  tags?: string[];
  tagMode?: 'all' | 'any';
  status?: LeadStatus | 'all';
}

export function filterLeads<T extends Lead>(leads: T[], f: LeadFilter): T[] {
  const q = f.query?.trim().toLowerCase() ?? '';
  const qDigits = q.replace(/\D/g, '');
  const tags = f.tags ?? [];
  return leads.filter((l) => {
    if (f.status && f.status !== 'all' && l.status !== f.status) return false;
    if (tags.length) {
      const ok = f.tagMode === 'any' ? tags.some((t) => l.tags.includes(t)) : tags.every((t) => l.tags.includes(t));
      if (!ok) return false;
    }
    if (!q) return true;
    return l.name.toLowerCase().includes(q) || (qDigits.length >= 3 && l.phone.includes(qDigits)) || l.notes.toLowerCase().includes(q);
  });
}

/** Minimal CSV parser (quotes, commas and newlines inside quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ',' || c === '\t' || c === ';') {
      row.push(cell);
      cell = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell);
      if (row.some((x) => x.trim())) rows.push(row);
      row = [];
      cell = '';
    } else cell += c;
  }
  row.push(cell);
  if (row.some((x) => x.trim())) rows.push(row);
  return rows;
}

export interface ImportRow {
  name: string;
  phone: string;
  tags: string[];
  notes: string;
}

/**
 * CSV -> leads. Recognises a header row (name / phone / mobile / number / tags / notes); without one the
 * columns are name, phone, tags. Returns rows plus the line numbers that had no valid phone.
 */
export function rowsToLeads(rows: string[][]): { leads: ImportRow[]; invalid: number[] } {
  if (!rows.length) return { leads: [], invalid: [] };
  const head = rows[0].map((h) => h.trim().toLowerCase());
  const find = (...names: string[]) => head.findIndex((h) => names.some((n) => h === n || h.includes(n)));
  let col = { name: find('name'), phone: find('phone', 'mobile', 'number', 'whatsapp'), tags: find('tag'), notes: find('note', 'remark') };
  let body = rows.slice(1);
  if (col.phone < 0) {
    col = { name: 0, phone: 1, tags: 2, notes: 3 };
    body = rows;
  }
  const leads: ImportRow[] = [];
  const invalid: number[] = [];
  body.forEach((r, i) => {
    const phone = normalizePhone(r[col.phone] ?? '');
    if (!phone) {
      invalid.push(i + (body === rows ? 1 : 2));
      return;
    }
    leads.push({
      name: (col.name >= 0 ? r[col.name] : '')?.trim() || formatPhone(phone),
      phone,
      tags: col.tags >= 0 ? normalizeTags((r[col.tags] ?? '').split(/[|,]/)) : [],
      notes: col.notes >= 0 ? (r[col.notes] ?? '').trim() : '',
    });
  });
  return { leads, invalid };
}
