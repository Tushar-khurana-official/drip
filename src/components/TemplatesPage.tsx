import React, { useEffect, useState } from 'react';
import { RefreshCw, Search } from 'lucide-react';
import type { WaTemplate } from '../types';
import { defaultMapping, mediaHeader, templateVariables } from '../lib/templates';
import { api, ApiError } from '../services/api';
import { cls } from './ui';
import { TemplatePreview } from './TemplatePreview';

const STATUS: Record<string, string> = {
  APPROVED: 'bg-emerald-50 text-emerald-700',
  PENDING: 'bg-amber-50 text-amber-800',
  REJECTED: 'bg-rose-50 text-rose-700',
};

export function TemplatesPage({ enabled }: { enabled: boolean }) {
  const [templates, setTemplates] = useState<WaTemplate[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [loading, setLoading] = useState(false);

  const load = async (refresh = false) => {
    setLoading(true);
    setError(null);
    try {
      setTemplates((await api.templates(refresh)).templates);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Could not load templates');
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    if (enabled) load();
  }, [enabled]);

  if (!enabled) {
    return (
      <div className={`${cls.card} p-6 text-sm text-slate-700 space-y-2`}>
        <p className="font-semibold text-slate-900">Templates are not connected yet</p>
        <p>
          Set <code>WHATSAPP_WABA_ID</code> (the WhatsApp Business Account ID) and <code>WHATSAPP_TOKEN</code> on the server. Templates are then loaded from
          the WhatsApp API.
        </p>
      </div>
    );
  }

  const list = (templates ?? []).filter((t) => !query || t.name.toLowerCase().includes(query.toLowerCase()));
  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        <div className="relative flex-1">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input className={`${cls.input} pl-9`} placeholder="Search templates" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <button className={cls.secondary} onClick={() => load(true)} disabled={loading}>
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {templates === null && !error && <p className="text-sm text-slate-500">Loading…</p>}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        {list.map((t) => {
          const vars = templateVariables(t);
          const media = mediaHeader(t);
          return (
            <div key={`${t.name}:${t.language}`} className={`${cls.card} p-4 space-y-2`}>
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="font-semibold text-slate-900 truncate">{t.name}</p>
                  <p className="text-xs text-slate-500">
                    {t.language} · {t.category?.toLowerCase() ?? 'template'} · {vars.length} variable{vars.length === 1 ? '' : 's'}
                    {media ? ` · ${media} header` : ''}
                  </p>
                </div>
                <span className={`text-xs font-semibold px-1.5 py-0.5 rounded-md shrink-0 ${STATUS[t.status] ?? 'bg-slate-100 text-slate-600'}`}>{t.status.toLowerCase()}</span>
              </div>
              <TemplatePreview template={t} mapping={defaultMapping(t)} lead={{ name: 'Priya Sharma', phone: '919876543210' }} />
            </div>
          );
        })}
      </div>
      {templates && list.length === 0 && <p className="text-sm text-slate-500">No templates.</p>}
    </div>
  );
}
