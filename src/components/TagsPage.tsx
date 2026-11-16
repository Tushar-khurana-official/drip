import React, { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, Workflow, Zap } from 'lucide-react';
import { TAG_COLORS } from '../types';
import type { Lead, Message, Sequence, TagColor, TagDef, VarSource, WaTemplate } from '../types';
import { normalizeTags } from '../lib/leads';
import { bodyText, defaultMapping, mappingProblems, mediaHeader, templateVariables } from '../lib/templates';
import { api, ApiError } from '../services/api';
import { cls, Modal, SWATCH, Tag } from './ui';
import { TemplatePreview } from './TemplatePreview';

interface Props {
  leads: Lead[];
  messages: Message[];
  tagDefs: TagDef[];
  sequences: Sequence[];
  templatesEnabled: boolean;
  onChanged: () => Promise<void>;
  onToast: (t: string) => void;
}

/** "Day 3 at 10:00 → +4 days at 18:00" */
export function describeSteps(seq: Sequence): string {
  if (!seq.steps.length) return 'No messages yet';
  let total = 0;
  return seq.steps
    .map((s) => {
      total += s.delay_days;
      return `day ${total} ${s.time}`;
    })
    .join(' → ');
}

export function TagsPage({ leads, messages, tagDefs, sequences, templatesEnabled, onChanged, onToast }: Props) {
  const [editing, setEditing] = useState<TagDef | 'new' | null>(null);
  const [automating, setAutomating] = useState<string | null>(null);

  // Defined tags first, then tags that are only used on leads.
  const rows = useMemo(() => {
    const counts = new Map<string, number>();
    for (const l of leads) for (const t of l.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
    const defs = tagDefs.map((d) => ({ name: d.name, def: d as TagDef | null, count: counts.get(d.name) ?? 0 }));
    const adhoc = [...counts.keys()].filter((t) => !tagDefs.some((d) => d.name === t)).sort().map((t) => ({ name: t, def: null, count: counts.get(t)! }));
    return [...defs, ...adhoc];
  }, [leads, tagDefs]);

  const active = (seqId: string) => new Set(messages.filter((m) => m.sequence_id === seqId && m.status === 'scheduled').map((m) => m.lead_id)).size;

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
      <div className="flex flex-wrap items-center gap-3">
        <button className={cls.primary} onClick={() => setEditing('new')}>
          <Plus className="w-4 h-4" /> New tag
        </button>
        <p className="text-sm text-slate-600">
          Give each tag an automation: when you add the tag to a lead, its messages go out by themselves on the days you choose.
        </p>
      </div>

      {rows.length === 0 && <div className={`${cls.card} p-10 text-center text-sm text-slate-500`}>No tags yet. Create one, e.g. "new patient" or "follow up".</div>}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {rows.map((r) => {
          const seq = sequences.find((s) => s.tag === r.name);
          return (
            <div key={r.name} className={`${cls.card} p-4 space-y-3`}>
              <div className="flex items-start gap-2">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <Tag tag={r.name} />
                    <span className="text-xs text-slate-500">
                      {r.count} lead{r.count === 1 ? '' : 's'}
                    </span>
                  </div>
                  {r.def?.description ? <p className="text-sm text-slate-600 mt-1">{r.def.description}</p> : !r.def && <p className="text-xs text-slate-400 mt-1">Used on leads; not set up as a tag yet.</p>}
                </div>
                <button
                  className={cls.secondary}
                  aria-label={`Edit ${r.name}`}
                  onClick={() => setEditing(r.def ?? { name: r.name, color: 'indigo', description: '', created_at: '' })}
                >
                  <Pencil className="w-4 h-4" />
                </button>
                {r.def && (
                  <button
                    className={cls.danger}
                    aria-label={`Delete ${r.name}`}
                    onClick={() =>
                      confirm(`Delete the tag "${r.name}"? It is removed from ${r.count} lead(s) and its automation stops.`) &&
                      run(() => api.deleteTag(r.name), 'Tag deleted')
                    }
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>

              <div className={`rounded-xl p-3 ${seq?.enabled && seq.steps.length ? 'bg-emerald-50 border border-emerald-200' : 'bg-slate-50 border border-slate-200'}`}>
                <div className="flex items-center gap-2">
                  <Zap className={`w-4 h-4 ${seq?.enabled && seq.steps.length ? 'text-emerald-600' : 'text-slate-400'}`} />
                  <span className="text-sm font-semibold text-slate-900 flex-1">
                    {seq?.steps.length ? (seq.enabled ? 'Automation on' : 'Automation off') : 'No automation'}
                  </span>
                  <button className="text-sm font-semibold text-indigo-700" onClick={() => setAutomating(r.name)}>
                    {seq?.steps.length ? 'Edit' : 'Set up'}
                  </button>
                </div>
                {seq && seq.steps.length > 0 && (
                  <>
                    <p className="text-xs text-slate-600 mt-1">
                      {seq.steps.length} message{seq.steps.length === 1 ? '' : 's'}: {describeSteps(seq)} (after the tag is added)
                    </p>
                    <p className="text-xs text-slate-500 mt-0.5">{active(seq.id)} lead(s) waiting for a message</p>
                  </>
                )}
              </div>
            </div>
          );
        })}
      </div>

      {editing && (
        <TagForm
          tag={editing === 'new' ? null : editing}
          isNew={editing === 'new' || !tagDefs.some((d) => d.name === (editing as TagDef).name)}
          onClose={() => setEditing(null)}
          onSaved={async (msg) => {
            setEditing(null);
            await onChanged();
            onToast(msg);
          }}
        />
      )}
      {automating && (
        <SequenceEditor
          tag={automating}
          sequence={sequences.find((s) => s.tag === automating) ?? null}
          leadsWithTag={leads.filter((l) => l.tags.includes(automating))}
          templatesEnabled={templatesEnabled}
          onClose={() => setAutomating(null)}
          onSaved={async (msg) => {
            setAutomating(null);
            await onChanged();
            onToast(msg);
          }}
        />
      )}
    </div>
  );
}

function TagForm({ tag, isNew, onClose, onSaved }: { tag: TagDef | null; isNew: boolean; onClose: () => void; onSaved: (msg: string) => void }) {
  const [name, setName] = useState(tag?.name ?? '');
  const [color, setColor] = useState<TagColor>(tag?.color ?? 'indigo');
  const [description, setDescription] = useState(tag?.description ?? '');
  const [error, setError] = useState<string | null>(null);
  const clean = normalizeTags(name)[0] ?? '';

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      if (tag) await api.updateTag(tag.name, { name: clean, color, description });
      else await api.createTag({ name: clean, color, description });
      onSaved(isNew ? `Tag "${clean}" created` : 'Tag saved');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not save');
    }
  };

  return (
    <Modal title={tag && !isNew ? 'Edit tag' : 'New tag'} onClose={onClose}>
      <form onSubmit={save} className="space-y-3">
        <label className="block">
          <span className={cls.label}>Name *</span>
          <input className={cls.input} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. new patient" autoFocus />
          {tag && clean && clean !== tag.name && <span className="text-xs text-slate-500">Renames it on every lead.</span>}
        </label>
        <div>
          <span className={cls.label}>Colour</span>
          <div className="flex flex-wrap gap-2">
            {TAG_COLORS.map((c) => (
              <button
                type="button"
                key={c}
                onClick={() => setColor(c)}
                aria-label={c}
                className={`w-7 h-7 rounded-full ${SWATCH[c]} ${color === c ? 'ring-2 ring-offset-2 ring-slate-900' : ''}`}
              />
            ))}
          </div>
        </div>
        <label className="block">
          <span className={cls.label}>What it means (optional)</span>
          <input className={cls.input} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. First visit booked, not yet come" />
        </label>
        {clean && (
          <p className="text-sm text-slate-600 flex items-center gap-2">
            Preview: <TagPreview name={clean} color={color} />
          </p>
        )}
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <div className="flex justify-end gap-2">
          <button type="button" className={cls.secondary} onClick={onClose}>
            Cancel
          </button>
          <button className={cls.primary} disabled={!clean}>
            Save
          </button>
        </div>
      </form>
    </Modal>
  );
}

function TagPreview({ name, color }: { name: string; color: TagColor }) {
  return <span className={`inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium text-white ${SWATCH[color]}`}>{name}</span>;
}

/* ------------------------------ automation editor ------------------------------ */

interface DraftStep {
  id?: string;
  delay_days: number;
  time: string;
  template: WaTemplate | null;
  mapping: Record<string, VarSource>;
  media: string;
}

const SOURCE_LABEL: Record<VarSource['kind'], string> = {
  first_name: "Lead's first name",
  name: "Lead's full name",
  phone: "Lead's phone",
  text: 'Fixed text',
};

function SequenceEditor({
  tag,
  sequence,
  leadsWithTag,
  templatesEnabled,
  onClose,
  onSaved,
}: {
  tag: string;
  sequence: Sequence | null;
  leadsWithTag: Lead[];
  templatesEnabled: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void;
}) {
  const [enabled, setEnabled] = useState(sequence?.enabled ?? true);
  const [stopOnReply, setStopOnReply] = useState(sequence?.stop_on_reply ?? true);
  const [steps, setSteps] = useState<DraftStep[]>(
    sequence?.steps.map((s) => ({ id: s.id, delay_days: s.delay_days, time: s.time, template: s.template, mapping: s.mapping, media: s.header_media_url ?? '' })) ?? [
      { delay_days: 3, time: '10:00', template: null, mapping: {}, media: '' },
    ],
  );
  const [templates, setTemplates] = useState<WaTemplate[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [startExisting, setStartExisting] = useState(false);
  const sample = leadsWithTag[0] ?? { name: 'Priya Sharma', phone: '919876543210' };

  useEffect(() => {
    if (!templatesEnabled) return;
    api
      .templates()
      .then((r) => setTemplates(r.templates.filter((t) => t.status === 'APPROVED')))
      .catch((e) => setLoadError(e instanceof ApiError ? e.message : 'Could not load templates'));
  }, [templatesEnabled]);

  const update = (i: number, patch: Partial<DraftStep>) => setSteps((s) => s.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  const move = (i: number, d: -1 | 1) =>
    setSteps((s) => {
      const n = [...s];
      [n[i], n[i + d]] = [n[i + d], n[i]];
      return n;
    });

  const problems = steps.flatMap((s, i) => (!s.template ? [`Message ${i + 1}: choose a template`] : mappingProblems(s.template, s.mapping, s.media.trim() || null).map((p) => `Message ${i + 1}: ${p}`)));
  const notOpted = leadsWithTag.filter((l) => !l.opted_in_at).length;

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.saveSequence(tag, {
        enabled,
        stop_on_reply: stopOnReply,
        steps: steps.map((s) => ({ id: s.id, delay_days: s.delay_days, time: s.time, template_name: s.template!.name, template_language: s.template!.language, mapping: s.mapping, header_media_url: s.media.trim() || null })),
      });
      let msg = 'Automation saved';
      if (startExisting && enabled && steps.length) {
        const r = await api.startExisting(tag);
        msg += `; started for ${r.started} lead${r.started === 1 ? '' : 's'}`;
      }
      onSaved(msg);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not save');
    } finally {
      setBusy(false);
    }
  };

  let total = 0;
  return (
    <Modal title={`Automation for "${tag}"`} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="flex flex-wrap gap-4 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-indigo-600" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
            Automation on
          </label>
          <label className="flex items-center gap-2">
            <input type="checkbox" className="accent-indigo-600" checked={stopOnReply} onChange={(e) => setStopOnReply(e.target.checked)} />
            Stop when the lead replies
          </label>
        </div>
        <p className="text-xs text-slate-500">
          Starts when this tag is added to an opted-in lead. Stops when the tag is removed, the lead opts out, or is marked Converted / Lost. Times are India
          time.
        </p>

        {!templatesEnabled && <p className="text-sm p-3 rounded-lg bg-amber-50 text-amber-900 border border-amber-200">Templates are not connected yet (WHATSAPP_WABA_ID), so messages cannot be chosen.</p>}
        {loadError && <p className="text-sm text-rose-600">{loadError}</p>}

        <ol className="space-y-3">
          {steps.map((s, i) => {
            total += s.delay_days;
            const vars = s.template ? templateVariables(s.template) : [];
            const media = s.template ? mediaHeader(s.template) : null;
            return (
              <li key={i} className="rounded-xl border border-slate-200 p-3 space-y-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="w-6 h-6 rounded-full bg-indigo-600 text-white text-xs font-bold flex items-center justify-center">{i + 1}</span>
                  <span className="text-sm text-slate-700">Wait</span>
                  <input
                    type="number"
                    min={0}
                    max={365}
                    className="w-16 px-2 py-1.5 rounded-lg border border-slate-300 text-sm"
                    value={s.delay_days}
                    onChange={(e) => update(i, { delay_days: Math.max(0, Math.min(365, Math.floor(Number(e.target.value) || 0))) })}
                    aria-label={`Days to wait for message ${i + 1}`}
                  />
                  <span className="text-sm text-slate-700">day{s.delay_days === 1 ? '' : 's'} {i === 0 ? 'after the tag is added' : 'after message ' + i}, send at</span>
                  <input type="time" className="px-2 py-1.5 rounded-lg border border-slate-300 text-sm" value={s.time} onChange={(e) => update(i, { time: e.target.value || '10:00' })} aria-label={`Time for message ${i + 1}`} />
                  <span className="text-xs text-slate-500">(day {total})</span>
                  <div className="ml-auto flex gap-1">
                    <button className="p-1.5 rounded-md hover:bg-slate-100 disabled:opacity-30" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up">
                      <ArrowUp className="w-4 h-4" />
                    </button>
                    <button className="p-1.5 rounded-md hover:bg-slate-100 disabled:opacity-30" disabled={i === steps.length - 1} onClick={() => move(i, 1)} aria-label="Move down">
                      <ArrowDown className="w-4 h-4" />
                    </button>
                    <button className="p-1.5 rounded-md hover:bg-rose-50 text-rose-600" onClick={() => setSteps((x) => x.filter((_, j) => j !== i))} aria-label={`Remove message ${i + 1}`}>
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>

                <select
                  className={cls.input}
                  value={s.template ? `${s.template.name}:${s.template.language}` : ''}
                  onChange={(e) => {
                    const t = templates?.find((x) => `${x.name}:${x.language}` === e.target.value) ?? null;
                    update(i, { template: t, mapping: t ? defaultMapping(t) : {}, media: '' });
                  }}
                  aria-label={`Template for message ${i + 1}`}
                >
                  <option value="">{templates ? 'Choose a template…' : s.template ? `${s.template.name} (${s.template.language})` : 'Loading templates…'}</option>
                  {(templates ?? []).map((t) => (
                    <option key={`${t.name}:${t.language}`} value={`${t.name}:${t.language}`}>
                      {t.name} ({t.language}) — {bodyText(t).slice(0, 60)}
                    </option>
                  ))}
                </select>

                {s.template && (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-2">
                      {media && (
                        <label className="block">
                          <span className={cls.label}>Header {media} link (https) *</span>
                          <input className={cls.input} value={s.media} onChange={(e) => update(i, { media: e.target.value })} placeholder="https://…" />
                        </label>
                      )}
                      {vars.map((v) => {
                        const src = s.mapping[v.key] ?? { kind: 'text', text: '' };
                        return (
                          <div key={v.key}>
                            <span className={cls.label}>
                              {`{{${v.param}}}`} in {v.component}
                            </span>
                            <div className="flex gap-2">
                              <select
                                className={`${cls.input.replace('w-full ', '')} w-40 shrink-0`}
                                value={src.kind}
                                onChange={(e) => {
                                  const kind = e.target.value as VarSource['kind'];
                                  update(i, { mapping: { ...s.mapping, [v.key]: kind === 'text' ? { kind, text: v.example ?? '' } : { kind } } });
                                }}
                              >
                                {(Object.keys(SOURCE_LABEL) as Array<VarSource['kind']>).map((k) => (
                                  <option key={k} value={k}>
                                    {SOURCE_LABEL[k]}
                                  </option>
                                ))}
                              </select>
                              {src.kind === 'text' && (
                                <input
                                  className={`${cls.input} min-w-0`}
                                  value={src.text}
                                  onChange={(e) => update(i, { mapping: { ...s.mapping, [v.key]: { kind: 'text', text: e.target.value } } })}
                                />
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                    <TemplatePreview template={s.template} mapping={s.mapping} lead={sample} mediaUrl={s.media} />
                  </div>
                )}
              </li>
            );
          })}
        </ol>

        <button className={cls.secondary} onClick={() => setSteps((s) => [...s, { delay_days: 3, time: '10:00', template: null, mapping: {}, media: '' }])} disabled={steps.length >= 20}>
          <Plus className="w-4 h-4" /> Add another message
        </button>

        {leadsWithTag.length > 0 && (
          <label className="flex items-start gap-2 text-sm text-slate-700 p-3 rounded-lg bg-slate-50 border border-slate-200">
            <input type="checkbox" className="mt-0.5 accent-indigo-600" checked={startExisting} onChange={(e) => setStartExisting(e.target.checked)} />
            <span>
              Also start it now for the {leadsWithTag.length} lead{leadsWithTag.length === 1 ? '' : 's'} who already have this tag
              {notOpted > 0 && <span className="text-slate-500"> ({notOpted} not opted in will be skipped)</span>}. Day counting starts today.
            </span>
          </label>
        )}

        {steps.length > 0 && problems.length > 0 && (
          <ul className="text-sm text-rose-600 list-disc pl-5">
            {problems.slice(0, 5).map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-rose-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-2 border-t border-slate-100">
          <button className={cls.secondary} onClick={onClose}>
            Cancel
          </button>
          <button className={cls.primary} onClick={save} disabled={busy || (steps.length > 0 && problems.length > 0)}>
            <Workflow className="w-4 h-4" /> {busy ? 'Saving…' : 'Save automation'}
          </button>
        </div>
      </div>
    </Modal>
  );
}
