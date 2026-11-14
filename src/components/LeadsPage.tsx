import React, { useMemo, useState } from 'react';
import { CheckSquare, MessageCircle, Pencil, Plus, Search, Send, ShieldCheck, Tag as TagIcon, Trash2, Upload } from 'lucide-react';
import type { Campaign, ChatEntry, Lead, LeadStatus, Message } from '../types';
import { LeadChat } from './LeadChat';
import { allTags, filterLeads, formatPhone, LEAD_STATUSES, normalizePhone, normalizeTags, parseCsv, rowsToLeads, STATUS_LABEL } from '../lib/leads';
import { api, ApiError } from '../services/api';
import { cls, Modal, STATUS_STYLE, Tag } from './ui';

interface Props {
  leads: Lead[];
  messages: Message[];
  campaigns: Campaign[];
  chats: ChatEntry[];
  sendingEnabled: boolean;
  onChanged: () => Promise<void>;
  onToast: (t: string) => void;
  onSendTemplate: (leadIds: string[]) => void;
}

export function LeadsPage({ leads, messages, campaigns, chats, sendingEnabled, onChanged, onToast, onSendTemplate }: Props) {
  const [chatFor, setChatFor] = useState<string | null>(null);
  /** Latest chat activity per lead, for the preview line and the "new reply" dot. */
  const lastActivity = useMemo(() => {
    const m = new Map<string, { text: string; at: string; incoming: boolean }>();
    const put = (leadId: string, text: string, at: string, incoming: boolean) => {
      const cur = m.get(leadId);
      if (!cur || at > cur.at) m.set(leadId, { text, at, incoming });
    };
    for (const c of chats) put(c.lead_id, c.kind === 'note' ? `Note: ${c.text}` : c.text, c.at, c.kind === 'in');
    for (const x of messages) if (x.status === 'sent' && x.sent_at) put(x.lead_id, x.text ? `You: ${x.text}` : 'Template sent', x.sent_at, false);
    return m;
  }, [chats, messages]);
  const [query, setQuery] = useState('');
  const [tags, setTags] = useState<string[]>([]);
  const [tagMode, setTagMode] = useState<'all' | 'any'>('any');
  const [status, setStatus] = useState<LeadStatus | 'all'>('all');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<Lead | 'new' | null>(null);
  const [importing, setImporting] = useState(false);
  const [bulkTag, setBulkTag] = useState('');

  const tagCounts = useMemo(() => allTags(leads), [leads]);
  const visible = useMemo(() => filterLeads(leads, { query, tags, tagMode, status }), [leads, query, tags, tagMode, status]);
  const pending = useMemo(() => {
    const m = new Map<string, number>();
    for (const x of messages) if (x.status === 'scheduled') m.set(x.lead_id, (m.get(x.lead_id) ?? 0) + 1);
    return m;
  }, [messages]);

  const sel = [...selected].filter((id) => leads.some((l) => l.id === id));
  const allVisibleSelected = visible.length > 0 && visible.every((l) => selected.has(l.id));
  const toggle = (id: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

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
      <div className="flex flex-col sm:flex-row gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input className={`${cls.input} pl-9`} placeholder="Search name, number or notes" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <select className={`${cls.input} sm:w-40`} value={status} onChange={(e) => setStatus(e.target.value as LeadStatus | 'all')} aria-label="Status filter">
          <option value="all">All statuses</option>
          {LEAD_STATUSES.map((s) => (
            <option key={s} value={s}>
              {STATUS_LABEL[s]}
            </option>
          ))}
        </select>
        <button className={cls.secondary} onClick={() => setImporting(true)}>
          <Upload className="w-4 h-4" /> Import
        </button>
        <button className={cls.primary} onClick={() => setEditing('new')}>
          <Plus className="w-4 h-4" /> Add lead
        </button>
      </div>

      {tagCounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-semibold text-slate-500 mr-1 flex items-center gap-1">
            <TagIcon className="w-3.5 h-3.5" /> Tags
          </span>
          {tagCounts.map(({ tag, count }) => (
            <Tag key={tag} tag={tag} count={count} active={tags.includes(tag)} onClick={() => setTags((t) => (t.includes(tag) ? t.filter((x) => x !== tag) : [...t, tag]))} />
          ))}
          {tags.length > 1 && (
            <button className="text-xs font-semibold text-indigo-700 ml-1" onClick={() => setTagMode((m) => (m === 'any' ? 'all' : 'any'))}>
              Match: {tagMode === 'any' ? 'any tag' : 'all tags'}
            </button>
          )}
          {tags.length > 0 && (
            <button className="text-xs font-semibold text-slate-500 ml-1" onClick={() => setTags([])}>
              Clear
            </button>
          )}
        </div>
      )}

      {sel.length > 0 && (
        <div className="sticky top-14 z-20 p-3 rounded-xl bg-indigo-50 border border-indigo-200 flex flex-wrap items-center gap-2">
          <span className="text-sm font-semibold text-indigo-900">{sel.length} selected</span>
          <button className={cls.primary} onClick={() => onSendTemplate(sel)}>
            <Send className="w-4 h-4" /> Send template
          </button>
          <div className="flex items-center gap-1">
            <input className="px-2 py-1.5 rounded-lg border border-indigo-200 text-sm w-32 bg-white" placeholder="tag" value={bulkTag} onChange={(e) => setBulkTag(e.target.value)} list="tag-list" />
            <button className={cls.secondary} disabled={!normalizeTags(bulkTag).length} onClick={() => run(() => api.bulk({ ids: sel, add_tags: normalizeTags(bulkTag) }), 'Tag added').then(() => setBulkTag(''))}>
              Add tag
            </button>
            <button className={cls.secondary} disabled={!normalizeTags(bulkTag).length} onClick={() => run(() => api.bulk({ ids: sel, remove_tags: normalizeTags(bulkTag) }), 'Tag removed').then(() => setBulkTag(''))}>
              Remove
            </button>
          </div>
          <select
            className="px-2 py-1.5 rounded-lg border border-indigo-200 text-sm bg-white"
            value=""
            onChange={(e) => e.target.value && run(() => api.bulk({ ids: sel, status: e.target.value as LeadStatus }), 'Status updated')}
            aria-label="Set status"
          >
            <option value="">Set status…</option>
            {LEAD_STATUSES.map((s) => (
              <option key={s} value={s}>
                {STATUS_LABEL[s]}
              </option>
            ))}
          </select>
          <button className={cls.secondary} onClick={() => run(() => api.bulk({ ids: sel, opted_in: true }), 'Marked as opted in')}>
            <ShieldCheck className="w-4 h-4" /> Opted in
          </button>
          <button
            className={cls.danger}
            onClick={() => {
              if (confirm(`Delete ${sel.length} leads? Their scheduled messages are cancelled.`)) run(() => api.bulk({ ids: sel, delete: true }), 'Deleted').then(() => setSelected(new Set()));
            }}
          >
            <Trash2 className="w-4 h-4" />
          </button>
          <button className="text-sm font-semibold text-slate-600 ml-auto" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}

      <div className={`${cls.card} overflow-hidden`}>
        <div className="flex items-center gap-3 px-4 py-2.5 border-b border-slate-100 bg-slate-50 text-xs font-semibold text-slate-500">
          <input
            type="checkbox"
            className="accent-indigo-600"
            aria-label="Select all shown"
            checked={allVisibleSelected}
            onChange={() =>
              setSelected((s) => {
                const n = new Set(s);
                for (const l of visible) {
                  if (allVisibleSelected) n.delete(l.id);
                  else n.add(l.id);
                }
                return n;
              })
            }
          />
          <span>
            {visible.length} of {leads.length} leads
          </span>
          {visible.length > 0 && !allVisibleSelected && (
            <button className="text-indigo-700 flex items-center gap-1" onClick={() => setSelected(new Set([...selected, ...visible.map((l) => l.id)]))}>
              <CheckSquare className="w-3.5 h-3.5" /> Select these
            </button>
          )}
        </div>

        {visible.length === 0 ? (
          <div className="p-10 text-center text-sm text-slate-500">
            {leads.length === 0 ? 'No leads yet. Add one or import a CSV.' : 'No leads match these filters.'}
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {visible.map((l) => (
              <li key={l.id} className="px-4 py-3 flex gap-3 items-start hover:bg-slate-50/60">
                <input type="checkbox" className="mt-1 accent-indigo-600" checked={selected.has(l.id)} onChange={() => toggle(l.id)} aria-label={`Select ${l.name}`} />
                <div className="flex-1 min-w-0 space-y-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <button className="font-semibold text-slate-900 hover:text-indigo-700 hover:underline text-left" onClick={() => setChatFor(l.id)}>
                      {l.name}
                    </button>
                    {lastActivity.get(l.id)?.incoming && <span className="w-2 h-2 rounded-full bg-emerald-500" title="Last message is from the lead" />}
                    <select
                      value={l.status}
                      onChange={(e) => run(() => api.updateLead(l.id, { status: e.target.value as LeadStatus }), 'Status updated')}
                      className={`text-xs font-semibold px-1.5 py-0.5 rounded-md border-0 ${STATUS_STYLE[l.status]}`}
                      aria-label="Status"
                    >
                      {LEAD_STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {STATUS_LABEL[s]}
                        </option>
                      ))}
                    </select>
                    {!l.opted_in_at && <span className="text-xs font-medium px-1.5 py-0.5 rounded-md bg-rose-50 text-rose-700">Not opted in</span>}
                    {(pending.get(l.id) ?? 0) > 0 && <span className="text-xs font-medium px-1.5 py-0.5 rounded-md bg-amber-50 text-amber-800">{pending.get(l.id)} scheduled</span>}
                  </div>
                  <p className="text-xs text-slate-500">
                    {formatPhone(l.phone)}
                    {l.source && ` · ${l.source}`}
                    {l.notes && ` · ${l.notes}`}
                  </p>
                  {lastActivity.get(l.id) && (
                    <button className="block max-w-full text-left text-xs text-slate-600 truncate hover:text-indigo-700" onClick={() => setChatFor(l.id)}>
                      {lastActivity.get(l.id)!.text.split('\n')[0]}
                    </button>
                  )}
                  {l.tags.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {l.tags.map((t) => (
                        <Tag key={t} tag={t} onRemove={() => run(() => api.updateLead(l.id, { tags: l.tags.filter((x) => x !== t) }), 'Tag removed')} />
                      ))}
                    </div>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  <button className={cls.secondary} onClick={() => setChatFor(l.id)} aria-label={`Chat with ${l.name}`} title="Chat & notes">
                    <MessageCircle className="w-4 h-4" />
                  </button>
                  <button className={cls.secondary} onClick={() => onSendTemplate([l.id])} disabled={!l.opted_in_at} aria-label={`Send template to ${l.name}`} title={l.opted_in_at ? 'Send template' : 'Lead has not opted in'}>
                    <Send className="w-4 h-4" />
                  </button>
                  <button className={cls.secondary} onClick={() => setEditing(l)} aria-label={`Edit ${l.name}`}>
                    <Pencil className="w-4 h-4" />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <datalist id="tag-list">
        {tagCounts.map((t) => (
          <option key={t.tag} value={t.tag} />
        ))}
      </datalist>

      {chatFor && leads.find((l) => l.id === chatFor) && (
        <LeadChat
          lead={leads.find((l) => l.id === chatFor)!}
          messages={messages}
          campaigns={campaigns}
          chats={chats}
          sendingEnabled={sendingEnabled}
          onClose={() => setChatFor(null)}
          onChanged={onChanged}
          onSendTemplate={() => {
            setChatFor(null);
            onSendTemplate([chatFor]);
          }}
        />
      )}
      {editing && (
        <LeadForm
          lead={editing === 'new' ? null : editing}
          tagSuggestions={tagCounts.map((t) => t.tag)}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            setEditing(null);
            await onChanged();
            onToast(msg);
          }}
        />
      )}
      {importing && (
        <ImportModal
          onClose={() => setImporting(false)}
          onDone={async (msg) => {
            setImporting(false);
            await onChanged();
            onToast(msg);
          }}
        />
      )}
    </div>
  );
}

function TagInput({ value, onChange, suggestions }: { value: string[]; onChange: (t: string[]) => void; suggestions: string[] }) {
  const [draft, setDraft] = useState('');
  const commit = (text = draft) => {
    onChange(normalizeTags([...value, ...normalizeTags(text)]));
    setDraft('');
  };
  const open = suggestions.filter((s) => !value.includes(s) && (!draft || s.includes(draft.toLowerCase()))).slice(0, 8);
  return (
    <div>
      <div className={`${cls.input} flex flex-wrap gap-1 items-center min-h-[38px]`}>
        {value.map((t) => (
          <Tag key={t} tag={t} onRemove={() => onChange(value.filter((x) => x !== t))} />
        ))}
        <input
          className="flex-1 min-w-[8rem] outline-none bg-transparent text-sm"
          value={draft}
          placeholder={value.length ? '' : 'Type a tag and press Enter'}
          onChange={(e) => (e.target.value.includes(',') ? commit(e.target.value) : setDraft(e.target.value))}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (draft.trim()) commit();
            } else if (e.key === 'Backspace' && !draft && value.length) onChange(value.slice(0, -1));
          }}
          onBlur={() => draft.trim() && commit()}
        />
      </div>
      {open.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1.5">
          {open.map((s) => (
            <button key={s} type="button" onClick={() => commit(s)} className="text-xs px-1.5 py-0.5 rounded-md border border-dashed border-slate-300 text-slate-600 hover:bg-slate-50">
              + {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function LeadForm({ lead, tagSuggestions, onClose, onSaved }: { lead: Lead | null; tagSuggestions: string[]; onClose: () => void; onSaved: (msg: string) => void }) {
  const [f, setF] = useState({
    name: lead?.name ?? '',
    phone: lead ? `+${lead.phone}` : '',
    tags: lead?.tags ?? [],
    source: lead?.source ?? '',
    notes: lead?.notes ?? '',
    opted_in: Boolean(lead?.opted_in_at),
    status: lead?.status ?? ('new' as LeadStatus),
  });
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const phoneOk = Boolean(normalizePhone(f.phone));

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (lead) await api.updateLead(lead.id, f);
      else await api.addLead(f);
      onSaved(lead ? 'Lead saved' : `${f.name} added`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal title={lead ? 'Edit lead' : 'Add lead'} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <label>
            <span className={cls.label}>Name *</span>
            <input className={cls.input} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} autoFocus />
          </label>
          <label>
            <span className={cls.label}>WhatsApp number *</span>
            <input className={cls.input} required inputMode="tel" placeholder="98765 43210 or +44…" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
            {f.phone && !phoneOk && <span className="text-xs text-rose-600">10-digit Indian number, or include the country code</span>}
          </label>
          <label>
            <span className={cls.label}>Source</span>
            <input className={cls.input} placeholder="Walk-in, Instagram, referral…" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })} />
          </label>
          {lead && (
            <label>
              <span className={cls.label}>Status</span>
              <select className={cls.input} value={f.status} onChange={(e) => setF({ ...f, status: e.target.value as LeadStatus })}>
                {LEAD_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABEL[s]}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>
        <div>
          <span className={cls.label}>Tags</span>
          <TagInput value={f.tags} onChange={(tags) => setF({ ...f, tags })} suggestions={tagSuggestions} />
        </div>
        <label className="block">
          <span className={cls.label}>Notes</span>
          <textarea className={cls.input} rows={2} value={f.notes} onChange={(e) => setF({ ...f, notes: e.target.value })} />
        </label>
        <label className="flex items-start gap-2 p-3 rounded-lg bg-slate-50 border border-slate-200 cursor-pointer">
          <input type="checkbox" className="mt-0.5 accent-indigo-600" checked={f.opted_in} onChange={(e) => setF({ ...f, opted_in: e.target.checked })} />
          <span className="text-sm text-slate-700">
            This person agreed to receive WhatsApp messages from us. <span className="text-slate-500">Messages are only sent to opted-in leads.</span>
          </span>
        </label>
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" className={cls.secondary} onClick={onClose}>
            Cancel
          </button>
          <button className={cls.primary} disabled={busy || !f.name.trim() || !phoneOk}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </Modal>
  );
}

/** Spreadsheet cell -> text (numbers stay whole: 9876543210, not 9.88E+09). */
function cellText(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return Number.isInteger(v) ? v.toFixed(0) : String(v);
  if (v instanceof Date) return v.toLocaleDateString('en-IN');
  return String(v);
}

function ImportModal({ onClose, onDone }: { onClose: () => void; onDone: (msg: string) => void }) {
  const [text, setText] = useState('');
  const [file, setFile] = useState<{ name: string; rows: string[][] } | null>(null);
  const [reading, setReading] = useState(false);
  const [tags, setTags] = useState('');
  const [optedIn, setOptedIn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const parsed = useMemo(() => rowsToLeads(file ? file.rows : parseCsv(text)), [file, text]);

  const readFile = async (f: File) => {
    setError(null);
    setReading(true);
    try {
      const name = f.name.toLowerCase();
      if (name.endsWith('.xlsx')) {
        const { readSheet } = await import('read-excel-file/browser');
        const data = await readSheet(f);
        setFile({ name: f.name, rows: data.map((row) => row.map(cellText)) });
      } else if (name.endsWith('.xls')) {
        setError('Old .xls files are not supported. In Excel use File → Save As → Excel Workbook (.xlsx), then choose that file.');
      } else {
        setFile({ name: f.name, rows: parseCsv(await f.text()) });
      }
    } catch {
      setError('Could not read this file. Make sure it is an Excel (.xlsx) or CSV file.');
    } finally {
      setReading(false);
    }
  };

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      const r = await api.importLeads({ rows: parsed.leads, tags: normalizeTags(tags), opted_in: optedIn, source: 'Import' });
      onDone(`${r.created} added, ${r.updated} updated${r.invalid ? `, ${r.invalid} skipped` : ''}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Import failed');
    } finally {
      setBusy(false);
    }
  };

  const hasInput = Boolean(file || text.trim());

  return (
    <Modal title="Import leads" onClose={onClose}>
      <div className="space-y-3">
        <p className="text-sm text-slate-600">
          Choose an <b>Excel (.xlsx)</b> or <b>CSV</b> file. First row = headings: <b>name, phone, tags, notes</b> (only phone is required; several tags
          separated by <code>|</code>). Numbers already in Drip keep their details and get the new tags.
        </p>

        <label
          className="flex flex-col items-center justify-center gap-1 p-5 rounded-xl border-2 border-dashed border-indigo-300 bg-indigo-50/50 hover:bg-indigo-50 cursor-pointer text-center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            const f = e.dataTransfer.files?.[0];
            if (f) readFile(f);
          }}
        >
          <Upload className="w-6 h-6 text-indigo-600" />
          <span className="text-sm font-semibold text-indigo-700">{reading ? 'Reading…' : file ? file.name : 'Click to choose a file'}</span>
          <span className="text-xs text-slate-500">{file ? 'Click to choose a different file' : 'or drag it here · .xlsx or .csv'}</span>
          <input
            type="file"
            className="sr-only"
            accept=".xlsx,.csv,.txt,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            onChange={(e) => {
              if (e.target.files?.[0]) readFile(e.target.files[0]);
              e.target.value = '';
            }}
          />
        </label>

        {!file && (
          <details className="text-sm">
            <summary className="cursor-pointer text-slate-600">…or paste rows copied from Excel</summary>
            <textarea
              className={`${cls.input} font-mono text-xs mt-2`}
              rows={5}
              placeholder={'name, phone, tags\nPriya Sharma, 9876543210, vip|follow up'}
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </details>
        )}

        {hasInput && parsed.leads.length > 0 && (
          <div className="rounded-lg border border-slate-200 overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-2 py-1.5 font-semibold">Name</th>
                  <th className="text-left px-2 py-1.5 font-semibold">Phone</th>
                  <th className="text-left px-2 py-1.5 font-semibold">Tags</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {parsed.leads.slice(0, 5).map((l, i) => (
                  <tr key={i}>
                    <td className="px-2 py-1.5 text-slate-900">{l.name}</td>
                    <td className="px-2 py-1.5 text-slate-600">{formatPhone(l.phone)}</td>
                    <td className="px-2 py-1.5 text-slate-600">{l.tags.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {parsed.leads.length > 5 && <p className="px-2 py-1.5 text-xs text-slate-500 bg-slate-50">…and {parsed.leads.length - 5} more</p>}
          </div>
        )}

        {hasInput && (
          <p className="text-sm text-slate-700">
            <b>{parsed.leads.length}</b> lead{parsed.leads.length === 1 ? '' : 's'} ready
            {parsed.invalid.length > 0 && (
              <span className="text-rose-600">
                {' '}· {parsed.invalid.length} row{parsed.invalid.length === 1 ? '' : 's'} without a valid phone number (row {parsed.invalid.slice(0, 8).join(', ')}
                {parsed.invalid.length > 8 ? '…' : ''})
              </span>
            )}
            {parsed.leads.length === 0 && <span className="block text-rose-600">No phone numbers found. Check that one column is called "phone" or "mobile".</span>}
          </p>
        )}

        <label className="block">
          <span className={cls.label}>Add these tags to everyone imported (optional)</span>
          <input className={cls.input} placeholder="e.g. camp-nov, walk-in" value={tags} onChange={(e) => setTags(e.target.value)} />
        </label>
        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input type="checkbox" className="mt-0.5 accent-indigo-600" checked={optedIn} onChange={(e) => setOptedIn(e.target.checked)} />
          Everyone in this list agreed to receive WhatsApp messages from us
        </label>
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <div className="flex justify-end gap-2">
          {file && (
            <button className={`${cls.secondary} mr-auto`} onClick={() => setFile(null)}>
              Remove file
            </button>
          )}
          <button className={cls.secondary} onClick={onClose}>
            Cancel
          </button>
          <button className={cls.primary} disabled={busy || reading || parsed.leads.length === 0} onClick={submit}>
            {busy ? 'Importing…' : `Import ${parsed.leads.length || ''}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
