/**
 * Tag automations: when a tag is added to a lead, schedule that tag's steps; when the tag is removed,
 * the lead opts out, becomes converted / lost, or replies (if the automation says so), cancel what is
 * still pending. Pure functions over the document; the server calls them inside one atomic update.
 */
import type { DripDoc, Lead, Message, Sequence } from '../types.js';

const IST_OFFSET_MIN = 330; // India: UTC+5:30, no daylight saving

/** The moment "days later at HH:MM India time", counted from `from`. */
export function stepTime(from: Date, days: number, time: string): Date {
  const [h, m] = (/^\d{1,2}:\d{2}$/.test(time) ? time : '10:00').split(':').map(Number);
  const ist = new Date(from.getTime() + IST_OFFSET_MIN * 60_000); // shift so UTC fields read as IST
  const d = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() + days, h, m);
  return new Date(d - IST_OFFSET_MIN * 60_000);
}

/** Send times for every step, starting when the tag was added. Never in the past. */
export function planSteps(seq: Pick<Sequence, 'steps'>, taggedAt: Date, now = taggedAt): Array<{ step_id: string; at: Date }> {
  const out: Array<{ step_id: string; at: Date }> = [];
  let base = taggedAt;
  for (const s of seq.steps) {
    let at = stepTime(base, Math.max(0, Math.floor(s.delay_days)), s.time);
    const floor = new Date(Math.max(now.getTime(), base.getTime()) + 60_000);
    if (at < floor) at = floor; // e.g. "0 days at 10:00" when it is already 3 pm: send in a minute
    out.push({ step_id: s.id, at });
    base = at;
  }
  return out;
}

const pendingFor = (doc: DripDoc, leadId: string, seqId: string) =>
  doc.messages.filter((m) => m.lead_id === leadId && m.sequence_id === seqId && m.status === 'scheduled');

/** Schedule a tag's automation for a lead. Returns how many messages were scheduled (0 if not possible). */
export function enroll(doc: DripDoc, lead: Lead, tag: string, now: Date, makeId: (p: string) => string): number {
  const seq = doc.sequences?.find((s) => s.tag === tag);
  if (!seq || !seq.enabled || !seq.steps.length) return 0;
  if (!lead.opted_in_at || lead.status === 'converted' || lead.status === 'lost') return 0;
  if (pendingFor(doc, lead.id, seq.id).length) return 0; // already running
  const plan = planSteps(seq, now, now);
  for (const p of plan) {
    doc.messages.push({ id: makeId('msg'), campaign_id: '', sequence_id: seq.id, step_id: p.step_id, lead_id: lead.id, send_at: p.at.toISOString(), status: 'scheduled' });
  }
  return plan.length;
}

/** Cancel pending automation messages for a lead (all automations, or only the one for `tag`). */
export function stopAutomation(doc: DripDoc, leadId: string, reason: string, tag?: string): number {
  const seqIds = new Set((doc.sequences ?? []).filter((s) => !tag || s.tag === tag).map((s) => s.id));
  let n = 0;
  for (const m of doc.messages) {
    if (m.lead_id === leadId && m.sequence_id && seqIds.has(m.sequence_id) && m.status === 'scheduled') {
      m.status = 'cancelled';
      m.error = reason;
      n++;
    }
  }
  return n;
}

export type LeadSnapshot = Map<string, { tags: string[]; opted: boolean; status: Lead['status'] }>;

export function snapshotLeads(doc: DripDoc): LeadSnapshot {
  return new Map(doc.leads.map((l) => [l.id, { tags: [...l.tags], opted: Boolean(l.opted_in_at), status: l.status }]));
}

/**
 * Compare leads before and after a change and start / stop automations:
 * - tag added (or new lead with the tag)          -> start that tag's automation
 * - lead opted in while carrying automated tags    -> start them
 * - tag removed                                    -> stop that tag's automation
 * - became converted or lost                        -> stop all automations
 */
export function applyAutomations(doc: DripDoc, before: LeadSnapshot, now: Date, makeId: (p: string) => string) {
  let started = 0, stopped = 0;
  if (!doc.sequences?.length) return { started, stopped };
  for (const lead of doc.leads) {
    const prev = before.get(lead.id);
    const prevTags = prev?.tags ?? [];
    const justOpted = Boolean(lead.opted_in_at) && prev !== undefined && !prev.opted;
    if ((lead.status === 'converted' || lead.status === 'lost') && prev?.status !== lead.status) {
      stopped += stopAutomation(doc, lead.id, `Lead marked ${lead.status}`);
      continue;
    }
    for (const t of prevTags) if (!lead.tags.includes(t)) stopped += stopAutomation(doc, lead.id, `Tag "${t}" removed`, t);
    for (const t of lead.tags) if (!prevTags.includes(t) || justOpted) started += enroll(doc, lead, t, now, makeId) ? 1 : 0;
  }
  return { started, stopped };
}

/** Pending automation messages for a lead, soonest first (for the lead list). */
export function nextAutomated(messages: Message[], leadId: string): Message | undefined {
  return messages
    .filter((m) => m.lead_id === leadId && m.sequence_id && m.status === 'scheduled')
    .sort((a, b) => a.send_at.localeCompare(b.send_at))[0];
}
