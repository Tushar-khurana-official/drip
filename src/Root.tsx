/** Shows the login screen, or loads the data from the server and opens the app. */
import React, { useCallback, useEffect, useState } from 'react';
import { Droplets, LogIn } from 'lucide-react';
import App from './App';
import { api, ApiError, type DripData } from './services/api';

type View =
  | { kind: 'loading' }
  | { kind: 'login'; error: string | null; configured: boolean }
  | { kind: 'app'; data: DripData; persistent: boolean };

export default function Root() {
  const [view, setView] = useState<View>({ kind: 'loading' });

  const open = useCallback(async () => {
    try {
      const me = await api.me();
      if (!me.loggedIn) return setView({ kind: 'login', error: null, configured: me.loginConfigured });
      const r = await api.loadData();
      setView({ kind: 'app', data: r.data, persistent: r.storage_persistent });
    } catch (err) {
      setView({ kind: 'login', error: err instanceof ApiError ? err.message : 'Kuch gadbad ho gayi', configured: true });
    }
  }, []);

  useEffect(() => {
    open();
  }, [open]);

  if (view.kind === 'loading') {
    return <div className="min-h-screen flex items-center justify-center text-sm font-bold text-[#1F7A5C]">Drip khul raha hai...</div>;
  }
  if (view.kind === 'login') return <Login error={view.error} configured={view.configured} onLoggedIn={open} />;
  return (
    <App
      initial={view.data}
      storagePersistent={view.persistent}
      onLogout={async () => {
        await api.logout().catch(() => undefined);
        window.location.reload();
      }}
    />
  );
}

function Login({ error, configured, onLoggedIn }: { error: string | null; configured: boolean; onLoggedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(error);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.login(email, password);
      onLoggedIn();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Login nahi hua');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className="w-full max-w-sm bg-white rounded-3xl border border-emerald-100 shadow-sm p-6 space-y-4">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 rounded-2xl bg-[#0B3D2E] flex items-center justify-center">
            <Droplets className="w-5 h-5 text-[#25D366]" />
          </div>
          <div>
            <h1 className="text-lg font-black text-[#123D31]">Drip</h1>
            <p className="text-[11px] text-[#5F7A6E]">Leads, tags aur scheduled WhatsApp messages</p>
          </div>
        </div>
        {!configured && (
          <p className="text-xs p-3 rounded-xl bg-amber-50 text-amber-900 border border-amber-200">
            Login abhi set nahi hai. Server par <code>APP_EMAIL</code> aur <code>APP_PASSWORD</code> environment variables set karein.
          </p>
        )}
        <label className="block">
          <span className="text-[11px] font-bold text-[#5F7A6E]">Email</span>
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} className="w-full px-3 py-2.5 rounded-xl border border-emerald-100 bg-[#F8FCFA] text-sm" />
        </label>
        <label className="block">
          <span className="text-[11px] font-bold text-[#5F7A6E]">Password</span>
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} className="w-full px-3 py-2.5 rounded-xl border border-emerald-100 bg-[#F8FCFA] text-sm" />
        </label>
        {msg && <p className="text-xs font-bold text-rose-600">{msg}</p>}
        <button disabled={busy} className="w-full inline-flex items-center justify-center gap-2 py-3 rounded-xl bg-[#25D366] text-[#0B3D2E] font-extrabold text-sm disabled:opacity-50">
          <LogIn className="w-4 h-4" /> {busy ? 'Login ho raha hai...' : 'Login'}
        </button>
      </form>
    </div>
  );
}
