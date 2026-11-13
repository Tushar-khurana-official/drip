import React, { useMemo, useState } from 'react';
import { CalendarClock, ChevronDown, ChevronRight, Play, RotateCcw, X } from 'lucide-react';
import type { Campaign, Lead, Message, MessageStatus } from '../types';
import { formatPhone } from '../lib/leads';
import { api, ApiError } from '../services/api';
import { cls, formatWhen, toLocalInput } from './ui';

const STATUS_STYLE: Record<MessageStatus, string> = {
  scheduled: 'bg-sky-50 text-sky-700',
  sending: 'bg-amber-50 text-amber-800',
  sent: 'bg-emerald-50 text-emerald-700',
  failed: 'bg-rose-50 text-rose-700',
  cancelled: 'bg-slate-100 text-slate-500',
};

interface Props {
  campaigns: Campaign[];
  messages: Message[];
  leads: Lead[];
  sendingEnabled: boolean;
  onChanged: () => Promise<void>;
  onToast: (t: string) => void;
  onNew: () => void;
}

export function CampaignsPage({ campaigns, messages, leads, sendingEnabled, onChanged, onToast, onNew }: Props) {
  const [open, setOpen] = useState<string | null>(null);
  const [resched, setResched] = useState<{ id: string; when: string } | null>(null);
  const byCampaign = useMemo(() => {
    const m = new Map<string, Message[]>();
    for (const x of messages) m.set(x.campaign_id, [...(m.get(x.campaign_id) ?? []), x]);
    return m;
  }, [messages]);
  const leadById = useMemo(() => new Map(leads.map((l) => [l.id, l])), [leads]);
  const dueNow = messages.filter((m) => m.status === 'scheduled' && Date.parse(m.send_at) <= Date.now()).length;

  const run = async (fn: () => Promise<unknown>, ok: string) => {
    try {
      await fn();
      await onChanged();
      onToast(ok);
    } catch (e) {
      onToast(e instanceof ApiError ? e.message : 'Something went wrong');
    }
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <button className={cls.primary} onClick={onNew}>
          <CalendarClock className="w-4 h-4" /> New campaign
        </button>
        {sendingEnabled && dueNow > 0 && (
          <button className={cls.secondary} onClick={() => run(async () => { const r = await api.sendDue(); onToast(`${r.sent} sent, ${r.failed} failed`); }, 'Done')}>
            <Play className="w-4 h-4" /> Send {dueNow} due now
          </button>
        )}
      </div>

      {campaigns.length === 0 ? (
        <div className={`${cls.card} p-10 text-center text-sm text-slate-500`}>No campaigns yet. Select leads and send a template, or start a new campaign.</div>
      ) : (
        <div className="space-y-3">
          {campaigns.map((c) => {
            const list = byCampaign.get(c.id) ?? [];
            const count = (s: MessageStatus) => list.filter((m) => m.status === s).length;
            const isOpen = open === c.id;
            const pending = count('scheduled');
            return (
              <div key={c.id} className={`${cls.card} overflow-hidden`}>
                <div className="p-4 flex flex-col sm:flex-row sm:items-center gap-3">
                  <button className="flex-1 min-w-0 text-left flex items-start gap-2" onClick={() => setOpen(isOpen ? null : c.id)}>
                    {isOpen ? <ChevronDown className="w-4 h-4 mt-1 text-slate-400 shrink-0" /> : <ChevronRight className="w-4 h-4 mt-1 text-slate-400 shrink-0" />}
                    <div className="min-w-0">
                      <p className="font-semibold text-slate-900 truncate">{c.name}</p>
                      <p className="text-xs text-slate-500">
                        {c.template.name} ({c.template.language}) · {formatWhen(c.send_at)} · {list.length} lead{list.length === 1 ? '' : 's'}
                      </p>
                      <div className="flex flex-wrap gap-1 mt-1.5">
                        {(['scheduled', 'sending', 'sent', 'failed', 'cancelled'] as MessageStatus[]).map((s) =>
                          count(s) ? (
                            <span key={s} className={`text-xs font-medium px-1.5 py-0.5 rounded-md ${STATUS_STYLE[s]}`}>
                              {count(s)} {s}
                            </span>
                          ) : null,
                        )}
                      </div>
                    </div>
                  </button>
                  {pending > 0 && (
                    <div className="flex flex-wrap gap-1.5 shrink-0">
                      {resched?.id === c.id ? (
                        <>
                          <input type="datetime-local" className="px-2 py-1.5 rounded-lg border border-slate-300 text-sm" value={resched.when} onChange={(e) => setResched({ id: c.id, when: e.target.value })} />
                          <button className={cls.primary} onClick={() => run(() => api.rescheduleCampaign(c.id, new Date(resched.when).toISOString()), 'Rescheduled').then(() => setResched(null))}>
                            Save
                          </button>
                          <button className={cls.secondary} onClick={() => setResched(null)}>
                            <X className="w-4 h-4" />
                          </button>
                        </>
                      ) : (
                        <>
                          <button className={cls.secondary} onClick={() => setResched({ id: c.id, when: toLocalInput(new Date(c.send_at)) })}>
                            Change time
                          </button>
                          <button className={cls.danger} onClick={() => confirm(`Cancel ${pending} scheduled messages?`) && run(() => api.cancelCampaign(c.id), 'Cancelled')}>
                            Cancel
                          </button>
                        </>
                      )}
                    </div>
                  )}
                </div>
                {isOpen && (
                  <ul className="border-t border-slate-100 divide-y divide-slate-100 max-h-96 overflow-y-auto">
                    {list.map((m) => {
                      const lead = leadById.get(m.lead_id);
                      return (
                        <li key={m.id} className="px-4 py-2.5 flex items-center gap-3 text-sm">
                          <div className="flex-1 min-w-0">
                            <span className="font-medium text-slate-900">{lead?.name ?? 'Deleted lead'}</span>
                            {lead && <span className="text-slate-500"> · {formatPhone(lead.phone)}</span>}
                            {m.sent_at && <span className="text-slate-500"> · sent {formatWhen(m.sent_at)}</span>}
                            {m.error && <p className="text-xs text-rose-600 truncate">{m.error}</p>}
                          </div>
                          <span className={`text-xs font-medium px-1.5 py-0.5 rounded-md ${STATUS_STYLE[m.status]}`}>{m.status}</span>
                          {m.status === 'scheduled' && (
                            <button className="text-xs font-semibold text-slate-500 hover:text-rose-600" onClick={() => run(() => api.cancelMessage(m.id), 'Cancelled')}>
                              Cancel
                            </button>
                          )}
                          {m.status === 'failed' && lead && (
                            <button className="text-xs font-semibold text-indigo-700 flex items-center gap-1" onClick={() => run(() => api.retryMessage(m.id), 'Retrying')}>
                              <RotateCcw className="w-3.5 h-3.5" /> Retry
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
