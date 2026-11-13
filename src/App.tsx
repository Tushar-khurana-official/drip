import React, { useState } from 'react';
import { AlertTriangle, Check, CloudOff, Droplets, LogOut, Settings, X } from 'lucide-react';
import { CrmScreen } from './components/CrmScreen';
import { useCrm } from './hooks/useCrm';
import type { DripData } from './services/api';

interface AppProps {
  initial: DripData;
  storagePersistent: boolean;
  onLogout: () => void;
}

export default function App({ initial, storagePersistent, onLogout }: AppProps) {
  const crm = useCrm(initial);
  const [settingsOpen, setSettingsOpen] = useState(!initial.profile.owner && !initial.leads.length);

  const status = {
    saved: { icon: Check, text: 'Saved', cls: 'text-emerald-200' },
    pending: { icon: Check, text: 'Saving...', cls: 'text-emerald-200' },
    saving: { icon: Check, text: 'Saving...', cls: 'text-emerald-200' },
    error: { icon: CloudOff, text: 'Save nahi hua, dobara try ho raha hai', cls: 'text-amber-300' },
  }[crm.saveStatus];
  const StatusIcon = status.icon;

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 bg-[#0B3D2E] text-white">
        <div className="max-w-5xl mx-auto px-4 h-16 flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-white/10 flex items-center justify-center shrink-0">
            <Droplets className="w-5 h-5 text-[#25D366]" />
          </div>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-extrabold truncate">{crm.profile.name}</p>
            <p className={`text-[11px] flex items-center gap-1 ${status.cls}`}>
              <StatusIcon className="w-3 h-3" /> {status.text}
            </p>
          </div>
          <button onClick={() => setSettingsOpen(true)} className="p-2 rounded-xl hover:bg-white/10" aria-label="Settings">
            <Settings className="w-5 h-5" />
          </button>
          <button
            onClick={() => {
              if (crm.saveStatus === 'saved' || confirm('Kuch badlav abhi save nahi hue. Phir bhi logout karein?')) onLogout();
            }}
            className="p-2 rounded-xl hover:bg-white/10"
            aria-label="Logout"
          >
            <LogOut className="w-5 h-5" />
          </button>
        </div>
      </header>

      {!storagePersistent && (
        <div className="max-w-5xl w-full mx-auto px-4 pt-4">
          <p className="text-xs p-3 rounded-2xl bg-amber-50 border border-amber-200 text-amber-900 flex items-start gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            Data temporary storage mein hai aur mit sakta hai. Server par DATABASE_URL (Postgres) set karein.
          </p>
        </div>
      )}

      <main className="flex-1 w-full px-3 sm:px-6 py-4 lg:py-6">
        <CrmScreen profile={crm.profile} crm={crm} />
      </main>

      {settingsOpen && <SettingsModal crm={crm} onClose={() => setSettingsOpen(false)} />}
    </div>
  );
}

function SettingsModal({ crm, onClose }: { crm: ReturnType<typeof useCrm>; onClose: () => void }) {
  const [form, setForm] = useState(crm.profile);
  const input = 'w-full px-3 py-2.5 rounded-xl border border-emerald-100 bg-[#F8FCFA] text-sm';
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-end sm:items-center justify-center" onClick={onClose}>
      <div className="bg-white w-full sm:max-w-md rounded-t-3xl sm:rounded-3xl p-5 space-y-3" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between">
          <h3 className="text-base font-extrabold text-[#123D31]">Business details</h3>
          <button onClick={onClose} aria-label="Close">
            <X className="w-5 h-5 text-[#5F7A6E]" />
          </button>
        </div>
        <p className="text-[11px] text-[#5F7A6E]">Templates mein {'{shop}'}, {'{owner}'} aur {'{upi}'} ki jagah yeh bhara jayega.</p>
        <label className="block">
          <span className="text-[11px] font-bold text-[#5F7A6E]">Business ka naam {'{shop}'}</span>
          <input className={input} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-[11px] font-bold text-[#5F7A6E]">Aapka naam {'{owner}'}</span>
          <input className={input} value={form.owner} onChange={(e) => setForm({ ...form, owner: e.target.value })} />
        </label>
        <label className="block">
          <span className="text-[11px] font-bold text-[#5F7A6E]">UPI ID {'{upi}'}</span>
          <input className={input} value={form.upi_id} onChange={(e) => setForm({ ...form, upi_id: e.target.value })} placeholder="naam@okaxis" />
        </label>
        <div className="flex justify-between items-center pt-2">
          <button onClick={crm.restoreDefaultTemplates} className="text-xs font-bold text-[#1F7A5C]">
            Starter templates wapas laayein
          </button>
          <button
            disabled={!form.name.trim()}
            onClick={() => {
              crm.setProfile({ name: form.name.trim(), owner: form.owner.trim(), upi_id: form.upi_id.trim() });
              onClose();
            }}
            className="px-4 py-2.5 rounded-xl bg-[#25D366] text-[#0B3D2E] font-extrabold text-xs disabled:opacity-40"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
}
