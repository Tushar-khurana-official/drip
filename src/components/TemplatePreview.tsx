import React from 'react';
import { ExternalLink, FileText, Image as ImageIcon, Video } from 'lucide-react';
import type { Lead, VarSource, WaTemplate } from '../types';
import { mediaHeader, renderPreview } from '../lib/templates';

/** WhatsApp-style bubble showing what the lead will receive. */
export function TemplatePreview({
  template,
  mapping,
  lead,
  mediaUrl,
}: {
  template: WaTemplate;
  mapping: Record<string, VarSource>;
  lead: Pick<Lead, 'name' | 'phone'>;
  mediaUrl?: string | null;
}) {
  const p = renderPreview(template, mapping, lead);
  const media = mediaHeader(template);
  const MediaIcon = media === 'video' ? Video : media === 'document' ? FileText : ImageIcon;
  return (
    <div className="rounded-xl bg-[#efeae2] p-3">
      <div className="max-w-sm bg-white rounded-lg rounded-tl-none shadow-sm overflow-hidden">
        {media && (
          <div className="h-28 bg-slate-100 flex items-center justify-center text-slate-400 overflow-hidden">
            {media === 'image' && mediaUrl ? <img src={mediaUrl} alt="" className="w-full h-full object-cover" /> : <MediaIcon className="w-8 h-8" />}
          </div>
        )}
        <div className="px-3 py-2 space-y-1">
          {p.header && !media && <p className="text-sm font-bold text-slate-900">{p.header}</p>}
          <p className="text-sm text-slate-800 whitespace-pre-wrap break-words">{p.body}</p>
          {p.footer && <p className="text-xs text-slate-400">{p.footer}</p>}
        </div>
        {p.buttons.length > 0 && (
          <div className="border-t border-slate-100 divide-y divide-slate-100">
            {p.buttons.map((b, i) => (
              <div key={i} className="py-2 text-center text-sm font-medium text-sky-600 flex items-center justify-center gap-1">
                {b}
                {template.components.find((c) => c.type === 'BUTTONS')?.buttons?.[i]?.type === 'URL' && <ExternalLink className="w-3.5 h-3.5" />}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
