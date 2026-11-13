import React, { useEffect, useMemo, useState } from 'react';
import { CalendarClock, RefreshCw, Search, Send } from 'lucide-react';
import type { Lead, VarSource, WaTemplate } from '../types';
import { allTags, filterLeads, normalizePhone } from '../lib/leads';
import { bodyText, defaultMapping, mappingProblems, mediaHeader, templateVariables } from '../lib/templates';
import { api, ApiError } from '../services/api';
import { cls, formatWhen, Modal, quickTimes, Tag, toLocalInput } from './ui';
import { TemplatePreview } from './TemplatePreview';

interface Props {
  leads: Lead[];
  initialLeadIds: string[];
  templatesEnabled: boolean;
  onClose: () => void;
  onDone: (msg: string) => void;
}

const SOURCE_LABEL: Record<VarSource['kind'], string> = {
  first_name: "Lead's first name",
  name: "Lead's full name",
  phone: "Lead's phone",
  text: 'Fixed text',
};

export function CampaignComposer({ leads, initialLeadIds, templatesEnabled, onClose, onDone }: Props) {
  /* ---- audience ---- */
  const [mode, setMode] = useState<'selected' | 'tags'>(initialLeadIds.length ? 'selected' : 'tags');
  const [audienceTags, setAudienceTags] = useState<string[]>([]);
  const tagCounts = useMemo(() => allTags(leads), [leads]);
  const audience = useMemo(() => {
    if (mode === 'selected') return leads.filter((l) => initialLeadIds.includes(l.id));
    return audienceTags.length ? filterLeads(leads, { tags: audienceTags, tagMode: 'any' }) : [];
  }, [mode, leads, initialLeadIds, audienceTags]);
  const reachable = audience.filter((l) => l.opted_in_at);

  /* ---- templates ---- */
  const [templates, setTemplates] = useState<WaTemplate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tplQuery, setTplQuery] = useState('');
  const [template, setTemplate] = useState<WaTemplate | null>(null);
  const load = async (refresh = false) => {
    setLoadError(null);
    try {
      setTemplates((await api.templates(refresh)).templates);
    } catch (e) {
      setLoadError(e instanceof ApiError ? e.message : 'Could not load templates');
      setTemplates([]);
    }
  };
  useEffect(() => {
    if (templatesEnabled) load();
  }, [templatesEnabled]);
  const approved = (templates ?? []).filter((t) => t.status === 'APPROVED' && (!tplQuery || t.name.toLowerCase().includes(tplQuery.toLowerCase())));

  /* ---- variables ---- */
  const [mapping, setMapping] = useState<Record<string, VarSource>>({});
  const [mediaUrl, setMediaUrl] = useState('');
  const pick = (t: WaTemplate) => {
    setTemplate(t);
    setMapping(defaultMapping(t));
    setMediaUrl('');
  };
  const vars = template ? templateVariables(template) : [];
  const media = template ? mediaHeader(template) : null;
  const problems = template ? mappingProblems(template, mapping, mediaUrl.trim() || null) : ['Choose a template'];

  /* ---- time ---- */
  const quick = useMemo(() => quickTimes(), []);
  const [when, setWhen] = useState(() => toLocalInput(quick[0]?.at ?? new Date(Date.now() + 15 * 60_000)));
  const sendAt = new Date(when);
  const timeOk = !Number.isNaN(sendAt.getTime()) && sendAt.getTime() > Date.now() - 60_000;

  const [name, setName] = useState('');
  const [testPhone, setTestPhone] = useState('');
  const [busy, setBusy] = useState<'test' | 'save' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sample = reachable[0] ?? audience[0] ?? { name: 'Priya Sharma', phone: '919876543210' };

  const input = () => ({
    name: name.trim() || undefined,
    template_name: template!.name,
    template_language: template!.language,
    mapping,
    header_media_url: mediaUrl.trim() || null,
  });

  const test = async () => {
    setBusy('test');
    setError(null);
    try {
      await api.testSend({ ...input(), phone: testPhone, sample_name: sample.name });
      onDone(`Test sent to ${testPhone}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Test failed');
    } finally {
      setBusy(null);
    }
  };

  const schedule = async () => {
    setBusy('save');
    setError(null);
    try {
      const r = await api.createCampaign({ ...input(), send_at: sendAt.toISOString(), lead_ids: reachable.map((l) => l.id) });
      onDone(`${r.scheduled} message${r.scheduled === 1 ? '' : 's'} scheduled for ${formatWhen(sendAt.toISOString())}`);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not schedule');
    } finally {
      setBusy(null);
    }
  };

  const step = 'text-sm font-bold text-slate-900 mb-2 flex items-center gap-2';
  const num = 'w-5 h-5 rounded-full bg-indigo-600 text-white text-xs flex items-center justify-center';

  return (
    <Modal title="Send a template" onClose={onClose} wide>
      <div className="space-y-6">
        {/* 1. Audience */}
        <section>
          <h3 className={step}>
            <span className={num}>1</span> Who gets it
          </h3>
          <div className="flex gap-2 mb-2">
            {initialLeadIds.length > 0 && (
              <button className={mode === 'selected' ? cls.primary : cls.secondary} onClick={() => setMode('selected')}>
                Selected leads ({initialLeadIds.length})
              </button>
            )}
            <button className={mode === 'tags' ? cls.primary : cls.secondary} onClick={() => setMode('tags')}>
              Leads with tags
            </button>
          </div>
          {mode === 'tags' && (
            <div className="flex flex-wrap gap-1.5 mb-2">
              {tagCounts.length === 0 && <span className="text-sm text-slate-500">No tags yet.</span>}
              {tagCounts.map(({ tag, count }) => (
                <Tag key={tag} tag={tag} count={count} active={audienceTags.includes(tag)} onClick={() => setAudienceTags((t) => (t.includes(tag) ? t.filter((x) => x !== tag) : [...t, tag]))} />
              ))}
            </div>
          )}
          <p className="text-sm text-slate-700">
            <b>{reachable.length}</b> lead{reachable.length === 1 ? '' : 's'} will get the message
            {reachable.length > 0 && <span className="text-slate-500">: {reachable.slice(0, 4).map((l) => l.name).join(', ')}{reachable.length > 4 ? ` +${reachable.length - 4}` : ''}</span>}
            {audience.length > reachable.length && <span className="text-rose-600"> · {audience.length - reachable.length} skipped (not opted in)</span>}
          </p>
        </section>

        {/* 2. Template */}
        <section>
          <div className="flex items-center justify-between mb-2">
            <h3 className={step + ' mb-0'}>
              <span className={num}>2</span> Template
            </h3>
            {templatesEnabled && (
              <button className="text-xs font-semibold text-indigo-700 flex items-center gap-1" onClick={() => load(true)}>
                <RefreshCw className="w-3.5 h-3.5" /> Refresh
              </button>
            )}
          </div>
          {!templatesEnabled ? (
            <p className="text-sm p-3 rounded-lg bg-amber-50 text-amber-900 border border-amber-200">Templates are not connected yet: the server needs WHATSAPP_WABA_ID.</p>
          ) : templates === null ? (
            <p className="text-sm text-slate-500">Loading templates…</p>
          ) : loadError ? (
            <p className="text-sm text-rose-600">{loadError}</p>
          ) : (
            <>
              <div className="relative mb-2">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input className={`${cls.input} pl-9`} placeholder={`Search ${templates.filter((t) => t.status === 'APPROVED').length} approved templates`} value={tplQuery} onChange={(e) => setTplQuery(e.target.value)} />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 max-h-56 overflow-y-auto pr-1">
                {approved.map((t) => {
                  const active = template?.name === t.name && template.language === t.language;
                  return (
                    <button
                      key={`${t.name}:${t.language}`}
                      onClick={() => pick(t)}
                      className={`text-left p-2.5 rounded-lg border transition ${active ? 'border-indigo-500 bg-indigo-50 ring-1 ring-indigo-500' : 'border-slate-200 hover:bg-slate-50'}`}
                    >
                      <span className="text-sm font-semibold text-slate-900 block truncate">{t.name}</span>
                      <span className="text-xs text-slate-500">
                        {t.language} · {t.category?.toLowerCase()}
                        {mediaHeader(t) ? ` · ${mediaHeader(t)}` : ''}
                      </span>
                      <span className="text-xs text-slate-600 line-clamp-2 mt-0.5">{bodyText(t)}</span>
                    </button>
                  );
                })}
                {approved.length === 0 && <p className="text-sm text-slate-500">No approved templates found.</p>}
              </div>
            </>
          )}
        </section>

        {/* 3. Variables + preview */}
        {template && (
          <section>
            <h3 className={step}>
              <span className={num}>3</span> Fill in the template
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-3">
                {vars.length === 0 && !media && <p className="text-sm text-slate-500">This template has nothing to fill in.</p>}
                {media && (
                  <label className="block">
                    <span className={cls.label}>Header {media} link (public https URL) *</span>
                    <input className={cls.input} placeholder="https://…" value={mediaUrl} onChange={(e) => setMediaUrl(e.target.value)} />
                  </label>
                )}
                {vars.map((v) => {
                  const s = mapping[v.key] ?? { kind: 'text', text: '' };
                  return (
                    <div key={v.key}>
                      <span className={cls.label}>
                        {`{{${v.param}}}`} in {v.component}
                        {v.example && <span className="font-normal text-slate-400"> · e.g. {v.example}</span>}
                      </span>
                      <div className="flex gap-2">
                        <select
                          className={`${cls.input.replace('w-full ', '')} w-40 shrink-0`}
                          value={s.kind}
                          onChange={(e) => {
                            const kind = e.target.value as VarSource['kind'];
                            setMapping({ ...mapping, [v.key]: kind === 'text' ? { kind, text: v.example ?? '' } : { kind } });
                          }}
                        >
                          {(Object.keys(SOURCE_LABEL) as Array<VarSource['kind']>).map((k) => (
                            <option key={k} value={k}>
                              {SOURCE_LABEL[k]}
                            </option>
                          ))}
                        </select>
                        {s.kind === 'text' && (
                          <input className={`${cls.input} min-w-0`} value={s.text} onChange={(e) => setMapping({ ...mapping, [v.key]: { kind: 'text', text: e.target.value } })} placeholder="Text" />
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div>
                <span className={cls.label}>Preview for {sample.name}</span>
                <TemplatePreview template={template} mapping={mapping} lead={sample} mediaUrl={mediaUrl} />
              </div>
            </div>
          </section>
        )}

        {/* 4. Time */}
        <section>
          <h3 className={step}>
            <span className={num}>{template ? 4 : 3}</span> When
          </h3>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {quick.map((q) => (
              <button
                key={q.label}
                onClick={() => setWhen(toLocalInput(q.at))}
                className={`text-xs font-semibold px-2.5 py-1.5 rounded-full border ${when === toLocalInput(q.at) ? 'bg-indigo-600 text-white border-indigo-600' : 'border-slate-300 text-slate-700 hover:bg-slate-50'}`}
              >
                {q.label}
              </button>
            ))}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input type="datetime-local" className={cls.input} value={when} min={toLocalInput(new Date())} onChange={(e) => setWhen(e.target.value)} aria-label="Send at" />
            <input className={cls.input} placeholder="Campaign name (optional)" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          {timeOk ? <p className="text-xs text-slate-500 mt-1">{formatWhen(sendAt.toISOString())} (your local time)</p> : <p className="text-xs text-rose-600 mt-1">Pick a future time</p>}
        </section>

        {template && problems.length > 0 && (
          <ul className="text-sm text-rose-600 list-disc pl-5">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-rose-600">{error}</p>}

        <div className="flex flex-col sm:flex-row gap-2 sm:items-center justify-between pt-2 border-t border-slate-100">
          <div className="flex gap-2">
            <input className={`${cls.input} sm:w-44`} placeholder="Your number for a test" inputMode="tel" value={testPhone} onChange={(e) => setTestPhone(e.target.value)} />
            <button className={cls.secondary} disabled={!template || problems.length > 0 || !normalizePhone(testPhone) || busy !== null} onClick={test}>
              <Send className="w-4 h-4" /> {busy === 'test' ? 'Sending…' : 'Send test'}
            </button>
          </div>
          <button className={cls.primary} disabled={!template || problems.length > 0 || !timeOk || reachable.length === 0 || busy !== null} onClick={schedule}>
            <CalendarClock className="w-4 h-4" /> {busy === 'save' ? 'Scheduling…' : `Schedule for ${reachable.length}`}
          </button>
        </div>
      </div>
    </Modal>
  );
}
