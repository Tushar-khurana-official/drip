import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, CalendarClock, FileText, LogOut, Pencil, Users } from 'lucide-react';
import { api, type AppState } from './services/api';
import { LeadsPage } from './components/LeadsPage';
import { CampaignsPage } from './components/CampaignsPage';
import { TemplatesPage } from './components/TemplatesPage';
import { CampaignComposer } from './components/CampaignComposer';
import { Toast } from './components/ui';

type Tab = 'leads' | 'campaigns' | 'templates';

export default function App({ initial, onLogout }: { initial: AppState; onLogout: () => void }) {
  const [state, setState] = useState(initial);
  const [tab, setTab] = useState<Tab>('leads');
  const [composeFor, setComposeFor] = useState<string[] | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const refresh = useCallback(async () => setState(await api.state()), []);

  // Pick up messages the server has sent in the meantime.
  useEffect(() => {
    const id = window.setInterval(() => refresh().catch(() => undefined), 15_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const scheduled = state.messages.filter((m) => m.status === 'scheduled').length;
  const tabs: Array<{ id: Tab; label: string; icon: React.ElementType; badge?: number }> = [
    { id: 'leads', label: 'Leads', icon: Users, badge: state.leads.length },
    { id: 'campaigns', label: 'Campaigns', icon: CalendarClock, badge: scheduled || undefined },
    { id: 'templates', label: 'Templates', icon: FileText },
  ];

  const renameBusiness = async () => {
    const name = prompt('Business name', state.settings.name)?.trim();
    if (!name) return;
    await api.saveSettings(name);
    await refresh();
  };

  return (
    <div className="min-h-screen flex flex-col">
      <header className="sticky top-0 z-30 bg-white/90 backdrop-blur border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-4 h-14 flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-black text-sm">D</div>
          <button className="min-w-0 flex items-center gap-1.5 group" onClick={renameBusiness} title="Rename">
            <span className="font-bold text-slate-900 truncate">{state.settings.name}</span>
            <Pencil className="w-3.5 h-3.5 text-slate-400 opacity-0 group-hover:opacity-100" />
          </button>
          <nav className="ml-auto hidden sm:flex gap-1">
            {tabs.map((t) => (
              <TabButton key={t.id} {...t} active={tab === t.id} onClick={() => setTab(t.id)} />
            ))}
          </nav>
          <button onClick={onLogout} className="ml-auto sm:ml-2 p-2 rounded-lg hover:bg-slate-100" aria-label="Log out">
            <LogOut className="w-5 h-5 text-slate-600" />
          </button>
        </div>
        <nav className="sm:hidden flex border-t border-slate-100">
          {tabs.map((t) => (
            <TabButton key={t.id} {...t} active={tab === t.id} onClick={() => setTab(t.id)} mobile />
          ))}
        </nav>
      </header>

      <main className="flex-1 w-full max-w-6xl mx-auto px-4 py-5 space-y-4">
        {(!state.whatsapp.sending || !state.whatsapp.templates || !state.storage_persistent) && (
          <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900 flex gap-2">
            <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
            <div className="space-y-0.5">
              {!state.whatsapp.sending && <p>Sending is off: set WHATSAPP_TOKEN and WHATSAPP_PHONE_NUMBER_ID on the server.</p>}
              {!state.whatsapp.templates && <p>Templates are off: set WHATSAPP_WABA_ID (WhatsApp Business Account ID) on the server.</p>}
              {!state.storage_persistent && <p>Data is in temporary storage and can be lost. Set DATABASE_URL (Postgres).</p>}
            </div>
          </div>
        )}

        {tab === 'leads' && (
          <LeadsPage
            leads={state.leads}
            messages={state.messages}
            campaigns={state.campaigns}
            chats={state.chats ?? []}
            sendingEnabled={state.whatsapp.sending}
            onChanged={refresh}
            onToast={setToast}
            onSendTemplate={(ids) => setComposeFor(ids)}
          />
        )}
        {tab === 'campaigns' && (
          <CampaignsPage
            campaigns={state.campaigns}
            messages={state.messages}
            leads={state.leads}
            sendingEnabled={state.whatsapp.sending}
            onChanged={refresh}
            onToast={setToast}
            onNew={() => setComposeFor([])}
          />
        )}
        {tab === 'templates' && <TemplatesPage enabled={state.whatsapp.templates} />}
      </main>

      {composeFor && (
        <CampaignComposer
          leads={state.leads}
          initialLeadIds={composeFor}
          templatesEnabled={state.whatsapp.templates}
          onClose={() => setComposeFor(null)}
          onDone={async (msg) => {
            setComposeFor(null);
            setToast(msg);
            await refresh();
            if (!msg.startsWith('Test')) setTab('campaigns');
          }}
        />
      )}
      {toast && <Toast text={toast} onDone={() => setToast(null)} />}
    </div>
  );
}

function TabButton({ label, icon: Icon, badge, active, onClick, mobile }: { label: string; icon: React.ElementType; badge?: number; active: boolean; onClick: () => void; mobile?: boolean }) {
  return (
    <button
      onClick={onClick}
      className={`${mobile ? 'flex-1 justify-center py-2.5' : 'px-3 py-1.5 rounded-lg'} flex items-center gap-1.5 text-sm font-semibold transition ${
        active ? (mobile ? 'text-indigo-700 border-b-2 border-indigo-600' : 'bg-indigo-50 text-indigo-700') : 'text-slate-600 hover:text-slate-900'
      }`}
    >
      <Icon className="w-4 h-4" />
      {label}
      {badge !== undefined && <span className="text-xs px-1.5 rounded-full bg-slate-100 text-slate-600">{badge}</span>}
    </button>
  );
}
