import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Check, CheckCheck, Clock, MessageSquareText, Send, StickyNote, Trash2, X } from 'lucide-react';
import type { Campaign, ChatEntry, Lead, Message } from '../types';
import { formatPhone, STATUS_LABEL } from '../lib/leads';
import { renderPreview } from '../lib/templates';
import { api, ApiError } from '../services/api';
import { cls, STATUS_STYLE, Tag } from './ui';

type Item =
  | { kind: 'template'; at: string; msg: Message; campaign?: Campaign; text: string }
  | { kind: 'chat'; at: string; entry: ChatEntry };

const day = (iso: string) => new Date(iso).toLocaleDateString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const time = (iso: string) => new Date(iso).toLocaleTimeString('en-IN', { hour: 'numeric', minute: '2-digit' });

function Ticks({ status }: { status: 'scheduled' | 'sending' | 'sent' | 'delivered' | 'read' | 'failed' | 'cancelled' }) {
  if (status === 'scheduled' || status === 'sending') return <Clock className="w-3.5 h-3.5 text-slate-400" aria-label={status} />;
  if (status === 'failed') return <AlertCircle className="w-3.5 h-3.5 text-rose-600" aria-label="failed" />;
  if (status === 'cancelled') return <X className="w-3.5 h-3.5 text-slate-400" aria-label="cancelled" />;
  if (status === 'read') return <CheckCheck className="w-3.5 h-3.5 text-sky-500" aria-label="read" />;
  if (status === 'delivered') return <CheckCheck className="w-3.5 h-3.5 text-slate-400" aria-label="delivered" />;
  return <Check className="w-3.5 h-3.5 text-slate-400" aria-label="sent" />;
}

interface Props {
  lead: Lead;
  messages: Message[];
  campaigns: Campaign[];
  chats: ChatEntry[];
  sendingEnabled: boolean;
  onClose: () => void;
  onChanged: () => Promise<void>;
  onSendTemplate: () => void;
}

/** Everything that happened with one lead, as a WhatsApp-style chat. */
export function LeadChat({ lead, messages, campaigns, chats, sendingEnabled, onClose, onChanged, onSendTemplate }: Props) {
  const [mode, setMode] = useState<'note' | 'reply'>('note');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);

  const replyOpen = Boolean(lead.last_inbound_at && Date.now() - Date.parse(lead.last_inbound_at) < 24 * 3600_000);
  useEffect(() => {
    setMode(replyOpen && sendingEnabled ? 'reply' : 'note');
  }, [replyOpen, sendingEnabled]);

  const items = useMemo(() => {
    const byCampaign = new Map(campaigns.map((c) => [c.id, c]));
    const list: Item[] = [];
    for (const m of messages) {
      if (m.lead_id !== lead.id) continue;
      const c = byCampaign.get(m.campaign_id);
      let t = m.text;
      if (!t && c) {
        const p = renderPreview(c.template, c.mapping, lead);
        t = [p.header, p.body, p.footer].filter(Boolean).join('\n\n');
      }
      list.push({ kind: 'template', at: m.sent_at ?? m.send_at, msg: m, campaign: c, text: t ?? '' });
    }
    for (const e of chats) if (e.lead_id === lead.id) list.push({ kind: 'chat', at: e.at, entry: e });
    return list.sort((a, b) => a.at.localeCompare(b.at));
  }, [messages, campaigns, chats, lead]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: 'end' });
  }, [items.length]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    setError(null);
    try {
      if (mode === 'reply') await api.reply(lead.id, text.trim());
      else await api.addNote(lead.id, text.trim());
      setText('');
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
      await onChanged().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  };

  let lastDay = '';
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-900/30" onMouseDown={onClose}>
      <aside className="w-full sm:max-w-md h-full bg-white shadow-2xl flex flex-col" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label={`Chat with ${lead.name}`}>
        {/* header */}
        <div className="px-4 py-3 border-b border-slate-200 flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-indigo-100 text-indigo-700 font-bold flex items-center justify-center shrink-0">{lead.name.trim()[0]?.toUpperCase() ?? '?'}</div>
          <div className="flex-1 min-w-0">
            <p className="font-bold text-slate-900 truncate">{lead.name}</p>
            <p className="text-xs text-slate-500">
              {formatPhone(lead.phone)} · <span className={`px-1 rounded ${STATUS_STYLE[lead.status]}`}>{STATUS_LABEL[lead.status]}</span>
              {!lead.opted_in_at && <span className="text-rose-600"> · not opted in</span>}
            </p>
            {lead.tags.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-1">
                {lead.tags.map((t) => (
                  <Tag key={t} tag={t} />
                ))}
              </div>
            )}
          </div>
          <button onClick={onClose} className="p-1 rounded-md hover:bg-slate-100" aria-label="Close">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>

        {/* conversation */}
        <div className="flex-1 overflow-y-auto bg-[#efeae2] px-3 py-4 space-y-2">
          {lead.notes && (
            <div className="mx-auto max-w-[90%] text-xs bg-amber-50 text-amber-900 border border-amber-200 rounded-lg px-3 py-2">
              <b>Lead notes:</b> {lead.notes}
            </div>
          )}
          {items.length === 0 && (
            <div className="text-center text-sm text-slate-600 bg-white/70 rounded-lg p-4 mx-6">
              Nothing yet. Send a template, or write a note about a call or visit below.
            </div>
          )}
          {items.map((it) => {
            const d = day(it.at);
            const sep = d !== lastDay ? (
              <div className="text-center my-2">
                <span className="text-[11px] font-medium text-slate-600 bg-white/80 rounded-md px-2 py-0.5 shadow-sm">{d}</span>
              </div>
            ) : null;
            lastDay = d;
            if (it.kind === 'template') {
              const m = it.msg;
              const status = m.status === 'sent' ? (m.read_at ? 'read' : m.delivered_at ? 'delivered' : 'sent') : m.status;
              return (
                <React.Fragment key={m.id}>
                  {sep}
                  <div className="flex justify-end">
                    <div className={`max-w-[85%] rounded-lg rounded-tr-none px-3 py-2 shadow-sm ${m.status === 'cancelled' ? 'bg-slate-100 opacity-70' : 'bg-[#d9fdd3]'}`}>
                      <p className="text-[11px] font-semibold text-emerald-800 mb-0.5">
                        Template · {it.campaign?.template.name ?? 'deleted'}
                        {m.status === 'scheduled' && ` · scheduled`}
                        {m.status === 'cancelled' && ` · cancelled`}
                      </p>
                      <p className="text-sm text-slate-900 whitespace-pre-wrap break-words">{it.text}</p>
                      {m.error && <p className="text-xs text-rose-600 mt-1">{m.error}</p>}
                      <div className="flex items-center justify-end gap-1 mt-0.5 text-[11px] text-slate-500">
                        {time(it.at)} <Ticks status={status} />
                      </div>
                    </div>
                  </div>
                </React.Fragment>
              );
            }
            const e = it.entry;
            if (e.kind === 'note') {
              return (
                <React.Fragment key={e.id}>
                  {sep}
                  <div className="flex justify-center">
                    <div className="group max-w-[90%] rounded-lg px-3 py-2 bg-amber-50 border border-amber-200 shadow-sm">
                      <p className="text-[11px] font-semibold text-amber-800 mb-0.5 flex items-center gap-1">
                        <StickyNote className="w-3 h-3" /> Note
                      </p>
                      <p className="text-sm text-slate-900 whitespace-pre-wrap break-words">{e.text}</p>
                      <div className="flex items-center justify-end gap-2 mt-0.5 text-[11px] text-slate-500">
                        <button
                          className="opacity-0 group-hover:opacity-100 focus:opacity-100 hover:text-rose-600"
                          aria-label="Delete note"
                          onClick={async () => {
                            if (!confirm('Delete this note?')) return;
                            await api.deleteNote(e.id);
                            await onChanged();
                          }}
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                        {time(e.at)}
                      </div>
                    </div>
                  </div>
                </React.Fragment>
              );
            }
            const incoming = e.kind === 'in';
            return (
              <React.Fragment key={e.id}>
                {sep}
                <div className={`flex ${incoming ? 'justify-start' : 'justify-end'}`}>
                  <div className={`max-w-[85%] rounded-lg px-3 py-2 shadow-sm ${incoming ? 'bg-white rounded-tl-none' : 'bg-[#d9fdd3] rounded-tr-none'}`}>
                    <p className="text-sm text-slate-900 whitespace-pre-wrap break-words">{e.text}</p>
                    {e.error && <p className="text-xs text-rose-600 mt-1">{e.error}</p>}
                    <div className="flex items-center justify-end gap-1 mt-0.5 text-[11px] text-slate-500">
                      {time(e.at)} {!incoming && <Ticks status={e.status ?? 'sent'} />}
                    </div>
                  </div>
                </div>
              </React.Fragment>
            );
          })}
          <div ref={bottom} />
        </div>

        {/* composer */}
        <form onSubmit={submit} className="border-t border-slate-200 p-3 space-y-2 bg-white">
          <div className="flex gap-1 text-xs font-semibold">
            <button type="button" onClick={() => setMode('note')} className={`px-2.5 py-1 rounded-md flex items-center gap-1 ${mode === 'note' ? 'bg-amber-100 text-amber-900' : 'text-slate-500 hover:bg-slate-100'}`}>
              <StickyNote className="w-3.5 h-3.5" /> Note
            </button>
            <button
              type="button"
              disabled={!replyOpen || !sendingEnabled}
              onClick={() => setMode('reply')}
              title={replyOpen ? 'Send a WhatsApp message' : 'Possible only within 24 hours of the lead\'s last message'}
              className={`px-2.5 py-1 rounded-md flex items-center gap-1 disabled:opacity-40 ${mode === 'reply' ? 'bg-emerald-100 text-emerald-900' : 'text-slate-500 hover:bg-slate-100'}`}
            >
              <MessageSquareText className="w-3.5 h-3.5" /> WhatsApp reply
            </button>
            <button type="button" onClick={onSendTemplate} disabled={!lead.opted_in_at} className="ml-auto px-2.5 py-1 rounded-md text-indigo-700 hover:bg-indigo-50 disabled:opacity-40 flex items-center gap-1">
              <Send className="w-3.5 h-3.5" /> Template
            </button>
          </div>
          <div className="flex gap-2 items-end">
            <textarea
              rows={2}
              className={`${cls.input} resize-none`}
              placeholder={mode === 'reply' ? 'Type a WhatsApp message…' : 'What was discussed? e.g. "Called, will visit on Monday"'}
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  (e.currentTarget.form as HTMLFormElement).requestSubmit();
                }
              }}
            />
            <button className={mode === 'reply' ? 'p-2.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-40' : cls.primary} disabled={busy || !text.trim()} aria-label={mode === 'reply' ? 'Send' : 'Save note'}>
              {mode === 'reply' ? <Send className="w-4 h-4" /> : 'Save'}
            </button>
          </div>
          {!replyOpen && <p className="text-[11px] text-slate-500">WhatsApp replies open for 24 hours after the lead messages you. Until then, use a template.</p>}
          {error && <p className="text-xs text-rose-600">{error}</p>}
        </form>
      </aside>
    </div>
  );
}
