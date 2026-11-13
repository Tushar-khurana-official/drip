import React, { useEffect } from 'react';
import { X } from 'lucide-react';
import type { LeadStatus } from '../types';

export const cls = {
  card: 'bg-white rounded-2xl border border-slate-200 shadow-sm',
  input: 'w-full px-3 py-2 rounded-lg border border-slate-300 bg-white text-sm text-slate-900 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500',
  label: 'block text-xs font-semibold text-slate-600 mb-1',
  primary: 'inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-indigo-600 hover:bg-indigo-700 text-white font-semibold text-sm shadow-sm transition disabled:opacity-40 disabled:pointer-events-none',
  secondary: 'inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-slate-800 font-semibold text-sm transition disabled:opacity-40 disabled:pointer-events-none',
  danger: 'inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-rose-200 bg-white hover:bg-rose-50 text-rose-700 font-semibold text-sm transition disabled:opacity-40',
};

const TAG_COLORS = [
  'bg-indigo-50 text-indigo-700 ring-indigo-200',
  'bg-emerald-50 text-emerald-700 ring-emerald-200',
  'bg-amber-50 text-amber-800 ring-amber-200',
  'bg-rose-50 text-rose-700 ring-rose-200',
  'bg-sky-50 text-sky-700 ring-sky-200',
  'bg-violet-50 text-violet-700 ring-violet-200',
  'bg-teal-50 text-teal-700 ring-teal-200',
];
export function tagColor(tag: string) {
  let h = 0;
  for (const ch of tag) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return TAG_COLORS[h % TAG_COLORS.length];
}

export function Tag({ tag, onRemove, active, onClick, count }: { tag: string; onRemove?: () => void; active?: boolean; onClick?: () => void; count?: number }) {
  const Comp = onClick ? 'button' : 'span';
  return (
    <Comp
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-xs font-medium ring-1 ring-inset ${active ? 'bg-indigo-600 text-white ring-indigo-600' : tagColor(tag)}`}
    >
      {tag}
      {count !== undefined && <span className="opacity-60">{count}</span>}
      {onRemove && (
        <span
          role="button"
          tabIndex={0}
          aria-label={`Remove ${tag}`}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          className="opacity-60 hover:opacity-100 cursor-pointer"
        >
          <X className="w-3 h-3" />
        </span>
      )}
    </Comp>
  );
}

export const STATUS_STYLE: Record<LeadStatus, string> = {
  new: 'bg-sky-50 text-sky-700',
  contacted: 'bg-amber-50 text-amber-800',
  interested: 'bg-violet-50 text-violet-700',
  converted: 'bg-emerald-50 text-emerald-700',
  lost: 'bg-slate-100 text-slate-500',
};

export function Modal({ title, onClose, children, wide }: { title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="fixed inset-0 z-50 bg-slate-900/40 flex items-end sm:items-center justify-center sm:p-4" onMouseDown={onClose}>
      <div
        className={`bg-white w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'} max-h-[94vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-xl`}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={title}
      >
        <div className="sticky top-0 bg-white/95 backdrop-blur px-5 py-4 border-b border-slate-100 flex items-center justify-between z-10">
          <h2 className="text-base font-bold text-slate-900">{title}</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded-md hover:bg-slate-100">
            <X className="w-5 h-5 text-slate-500" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  );
}

export function formatWhen(iso: string) {
  return new Date(iso).toLocaleString('en-IN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

export function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Quick picks for the time field (local time), only those still in the future. */
export function quickTimes(now = new Date()): Array<{ label: string; at: Date }> {
  const at = (days: number, h: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(h, 0, 0, 0);
    return d;
  };
  const soon = new Date(now.getTime() + 15 * 60_000);
  soon.setSeconds(0, 0);
  const list = [
    { label: 'In 15 min', at: soon },
    { label: 'Today 6 pm', at: at(0, 18) },
    { label: 'Tomorrow 10 am', at: at(1, 10) },
    { label: 'Tomorrow 6 pm', at: at(1, 18) },
  ];
  const toMonday = ((8 - now.getDay()) % 7) || 7;
  list.push({ label: 'Monday 10 am', at: at(toMonday, 10) });
  return list.filter((q) => q.at.getTime() > now.getTime() + 60_000);
}

export function Toast({ text, onDone }: { text: string; onDone: () => void }) {
  useEffect(() => {
    const t = window.setTimeout(onDone, 4000);
    return () => window.clearTimeout(t);
  }, [text, onDone]);
  return (
    <div className="fixed bottom-5 left-1/2 -translate-x-1/2 z-[60] px-4 py-2.5 rounded-xl bg-slate-900 text-white text-sm font-medium shadow-lg max-w-[92vw]">
      {text}
    </div>
  );
}
