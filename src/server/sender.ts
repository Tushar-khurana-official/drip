/**
 * Sends scheduled messages whose time has come.
 *
 * 1. claim: atomically mark due messages "sending" (so two runs never send the same message);
 * 2. send each through the WhatsApp API (outside the lock);
 * 3. record the result ("sent" with WhatsApp's message id, or "failed" with the reason).
 *
 * A message stuck in "sending" (the server died mid-send) is marked failed after 15 minutes and is
 * never retried automatically, because it may already have been delivered.
 * Messages more than MAX_LATE late (e.g. the server was down) are marked failed, not sent.
 */
import type { DripDoc, Message } from '../types.js';
import { buildTemplatePayload, renderPreview } from '../lib/templates.js';
import { getStore, Store } from './store.js';
import { Sender, sendMessage, waConfig } from './whatsapp.js';

const BATCH = 50;
const MAX_LATE_MS = 24 * 3600_000;
const STUCK_MS = 15 * 60_000;

function log(event: string, fields: Record<string, string | number | boolean | null> = {}) {
  console.log(JSON.stringify({ t: new Date().toISOString(), event, ...fields }));
}

export async function runDue(store: Store, send: Sender, now = new Date()) {
  const t = now.getTime();
  const nowIso = now.toISOString();
  const claimed = await store.mutate((doc: DripDoc) => {
    for (const m of doc.messages) {
      if (m.status === 'sending' && m.claimed_at && t - Date.parse(m.claimed_at) > STUCK_MS) {
        m.status = 'failed';
        m.error = 'Interrupted while sending; check WhatsApp before resending';
      }
    }
    const due = doc.messages
      .filter((m) => m.status === 'scheduled' && Date.parse(m.send_at) <= t)
      .sort((a, b) => a.send_at.localeCompare(b.send_at));
    const out: Array<{ msg: Message; payload: Record<string, unknown> | null; text?: string; error?: string }> = [];
    for (const m of due) {
      if (out.length >= BATCH) break;
      if (t - Date.parse(m.send_at) > MAX_LATE_MS) {
        m.status = 'failed';
        m.error = 'Not sent: more than 24 hours late';
        continue;
      }
      const lead = doc.leads.find((l) => l.id === m.lead_id);
      const campaign = doc.campaigns.find((c) => c.id === m.campaign_id);
      m.status = 'sending';
      m.claimed_at = nowIso;
      if (!lead || !campaign) out.push({ msg: m, payload: null, error: 'Lead or campaign was deleted' });
      else if (!lead.opted_in_at) out.push({ msg: m, payload: null, error: 'Lead has not opted in' });
      else {
        const p = renderPreview(campaign.template, campaign.mapping, lead);
        const text = [p.header, p.body, p.footer].filter(Boolean).join('\n\n');
        out.push({ msg: { ...m }, payload: buildTemplatePayload(campaign.template, campaign.mapping, lead, campaign.header_media_url), text });
      }
    }
    return out;
  });

  const results: Array<{ id: string; ok: boolean; wa_id?: string; text?: string; error?: string }> = [];
  for (const c of claimed) {
    if (!c.payload) {
      results.push({ id: c.msg.id, ok: false, error: c.error });
      continue;
    }
    const r = await send(c.payload);
    results.push({ id: c.msg.id, ok: r.ok, wa_id: r.id, text: c.text, error: r.error });
  }

  if (results.length) {
    const sentAt = new Date().toISOString();
    await store.mutate((doc) => {
      for (const r of results) {
        const m = doc.messages.find((x) => x.id === r.id);
        if (!m) continue;
        if (r.ok) {
          Object.assign(m, { status: 'sent', sent_at: sentAt, wa_message_id: r.wa_id, text: r.text, error: undefined });
          const lead = doc.leads.find((l) => l.id === m.lead_id);
          if (lead && lead.status === 'new') lead.status = 'contacted';
        } else Object.assign(m, { status: 'failed', error: r.error ?? 'Failed' });
      }
    });
  }
  const sent = results.filter((r) => r.ok).length;
  return { sent, failed: results.length - sent, more: claimed.length >= BATCH };
}

let running = false;

/** One pass (keeps going while there are more than BATCH due). Safe to call from a timer or cron. */
export async function sendDueNow(send: Sender = sendMessage) {
  if (running) return { busy: true, sent: 0, failed: 0 };
  running = true;
  try {
    const store = await getStore();
    const total = { sent: 0, failed: 0 };
    for (let i = 0; i < 20; i++) {
      const r = await runDue(store, send);
      total.sent += r.sent;
      total.failed += r.failed;
      if (!r.more) break;
    }
    if (total.sent || total.failed) log('send_due', total);
    return { busy: false, ...total };
  } finally {
    running = false;
  }
}

/** Normal Node server: check every 30 seconds. */
export function startSenderTimer() {
  if (!waConfig().sending) {
    log('sender_off', { reason: 'WHATSAPP_TOKEN or WHATSAPP_PHONE_NUMBER_ID not set' });
    return;
  }
  setInterval(() => {
    sendDueNow().catch(() => log('send_due_error'));
  }, 30_000);
  log('sender_started');
}
