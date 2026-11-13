/**
 * WhatsApp template helpers: find the variables a template needs, fill them for a lead, build the
 * request body for POST /{phone-number-id}/messages, and render a preview. Pure functions.
 */
import type { Lead, VarSource, WaComponent, WaTemplate } from '../types.js';
import { firstName } from './leads.js';

export interface TemplateVariable {
  /** Unique key used in a campaign's mapping, e.g. "body.1", "body.customer_name", "header.1", "button.0.1". */
  key: string;
  component: 'header' | 'body' | 'button';
  /** Positional number ("1") or the name for NAMED templates. */
  param: string;
  /** Button index for URL buttons. */
  buttonIndex?: number;
  example?: string;
}

const VAR_RE = /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g;

function varsIn(text: string | undefined): string[] {
  const out: string[] = [];
  for (const m of (text ?? '').matchAll(VAR_RE)) if (!out.includes(m[1])) out.push(m[1]);
  return out;
}

export const comp = (t: WaTemplate, type: string): WaComponent | undefined =>
  t.components?.find((c) => c.type?.toUpperCase() === type);

function examplesFor(c: WaComponent | undefined, kind: 'header' | 'body'): Record<string, string> {
  const ex = c?.example as Record<string, unknown> | undefined;
  const out: Record<string, string> = {};
  if (!ex) return out;
  const pos = (kind === 'body' ? (ex.body_text as string[][] | undefined)?.[0] : (ex.header_text as string[] | undefined)) ?? [];
  pos.forEach((v, i) => (out[String(i + 1)] = String(v)));
  const named = (kind === 'body' ? ex.body_text_named_params : ex.header_text_named_params) as Array<{ param_name: string; example: string }> | undefined;
  for (const n of named ?? []) out[n.param_name] = n.example;
  return out;
}

/** Every variable the template needs, in order: header, body, buttons. */
export function templateVariables(t: WaTemplate): TemplateVariable[] {
  const out: TemplateVariable[] = [];
  const header = comp(t, 'HEADER');
  if (header && (header.format ?? 'TEXT').toUpperCase() === 'TEXT') {
    const ex = examplesFor(header, 'header');
    for (const p of varsIn(header.text)) out.push({ key: `header.${p}`, component: 'header', param: p, example: ex[p] });
  }
  const body = comp(t, 'BODY');
  const bex = examplesFor(body, 'body');
  for (const p of varsIn(body?.text)) out.push({ key: `body.${p}`, component: 'body', param: p, example: bex[p] });
  (comp(t, 'BUTTONS')?.buttons ?? []).forEach((b, i) => {
    if (b.type?.toUpperCase() === 'URL') for (const p of varsIn(b.url)) out.push({ key: `button.${i}.${p}`, component: 'button', param: p, buttonIndex: i });
  });
  return out;
}

/** Header that needs a media link (IMAGE / VIDEO / DOCUMENT), or null. */
export function mediaHeader(t: WaTemplate): 'image' | 'video' | 'document' | null {
  const f = comp(t, 'HEADER')?.format?.toUpperCase();
  return f === 'IMAGE' ? 'image' : f === 'VIDEO' ? 'video' : f === 'DOCUMENT' ? 'document' : null;
}

export function isNamed(t: WaTemplate): boolean {
  return t.parameter_format?.toUpperCase() === 'NAMED';
}

/** A first guess for each variable: anything that looks like a name gets the lead's first name. */
export function defaultMapping(t: WaTemplate): Record<string, VarSource> {
  const vars = templateVariables(t);
  const map: Record<string, VarSource> = {};
  for (const v of vars) {
    // Named "...name..." parameters, and the first body variable (usually the greeting), get the first name.
    const looksLikeName = /name/i.test(v.param) || v.key === 'body.1';
    map[v.key] = looksLikeName ? { kind: 'first_name' } : { kind: 'text', text: v.example ?? '' };
  }
  return map;
}

export function resolveValue(src: VarSource | undefined, lead: Pick<Lead, 'name' | 'phone'>): string {
  if (!src) return '';
  switch (src.kind) {
    case 'name':
      return lead.name.trim();
    case 'first_name':
      return firstName(lead.name);
    case 'phone':
      return `+${lead.phone}`;
    case 'text':
      return src.text;
  }
}

/** Mapping problems that would make WhatsApp reject the message (empty values, missing media link). */
export function mappingProblems(t: WaTemplate, mapping: Record<string, VarSource>, headerMediaUrl: string | null): string[] {
  const problems: string[] = [];
  for (const v of templateVariables(t)) {
    const s = mapping[v.key];
    if (!s) problems.push(`No value for {{${v.param}}} (${v.component})`);
    else if (s.kind === 'text' && !s.text.trim()) problems.push(`Empty text for {{${v.param}}} (${v.component})`);
  }
  const media = mediaHeader(t);
  if (media && !/^https:\/\/\S+$/.test(headerMediaUrl ?? '')) problems.push(`The header needs a public https link to the ${media}`);
  return problems;
}

/** Request body for POST /{phone-number-id}/messages. */
export function buildTemplatePayload(
  t: WaTemplate,
  mapping: Record<string, VarSource>,
  lead: Pick<Lead, 'name' | 'phone'>,
  headerMediaUrl: string | null,
): Record<string, unknown> {
  const named = isNamed(t);
  const vars = templateVariables(t);
  const param = (v: TemplateVariable) => {
    const p: Record<string, string> = { type: 'text', text: resolveValue(mapping[v.key], lead) };
    if (named && v.component !== 'button') p.parameter_name = v.param;
    return p;
  };
  const components: Record<string, unknown>[] = [];
  const media = mediaHeader(t);
  if (media && headerMediaUrl) {
    components.push({ type: 'header', parameters: [{ type: media, [media]: { link: headerMediaUrl } }] });
  } else {
    const hv = vars.filter((v) => v.component === 'header');
    if (hv.length) components.push({ type: 'header', parameters: hv.map(param) });
  }
  const bv = vars.filter((v) => v.component === 'body');
  if (bv.length) components.push({ type: 'body', parameters: bv.map(param) });
  const buttons = new Map<number, TemplateVariable[]>();
  for (const v of vars.filter((x) => x.component === 'button')) buttons.set(v.buttonIndex!, [...(buttons.get(v.buttonIndex!) ?? []), v]);
  for (const [index, list] of buttons) {
    components.push({ type: 'button', sub_type: 'url', index: String(index), parameters: list.map(param) });
  }
  return {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: lead.phone,
    type: 'template',
    template: { name: t.name, language: { code: t.language }, ...(components.length ? { components } : {}) },
  };
}

/** Text the lead will see (header text, body, footer), with variables filled. */
export function renderPreview(
  t: WaTemplate,
  mapping: Record<string, VarSource>,
  lead: Pick<Lead, 'name' | 'phone'>,
): { header: string | null; body: string; footer: string | null; buttons: string[] } {
  const fill = (text: string | undefined, prefix: string) =>
    (text ?? '').replace(VAR_RE, (_m, p: string) => resolveValue(mapping[`${prefix}.${p}`], lead) || `{{${p}}}`);
  const header = comp(t, 'HEADER');
  return {
    header: header ? ((header.format ?? 'TEXT').toUpperCase() === 'TEXT' ? fill(header.text, 'header') : `[${header.format?.toLowerCase()}]`) : null,
    body: fill(comp(t, 'BODY')?.text, 'body'),
    footer: comp(t, 'FOOTER')?.text ?? null,
    buttons: (comp(t, 'BUTTONS')?.buttons ?? []).map((b) => b.text ?? b.type),
  };
}

/** Body text with variables shown as {{1}} etc. (for lists). */
export function bodyText(t: WaTemplate): string {
  return comp(t, 'BODY')?.text ?? '';
}
