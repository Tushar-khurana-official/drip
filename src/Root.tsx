import React, { useCallback, useEffect, useState } from 'react';
import { LogIn } from 'lucide-react';
import App from './App';
import { api, ApiError, apiMissing, type AppState } from './services/api';
import { cls } from './components/ui';

type View = { kind: 'loading' } | { kind: 'login'; error: string | null; configured: boolean } | { kind: 'app'; state: AppState; email?: string };

export default function Root() {
  const [view, setView] = useState<View>({ kind: 'loading' });

  const open = useCallback(async () => {
    try {
      const me = await api.me();
      if (!me.loggedIn) return setView({ kind: 'login', error: null, configured: me.loginConfigured });
      setView({ kind: 'app', state: await api.state(), email: me.email });
    } catch (e) {
      setView({ kind: 'login', error: e instanceof ApiError ? e.message : 'Something went wrong', configured: true });
    }
  }, []);
  useEffect(() => {
    if (!apiMissing) open();
  }, [open]);

  if (apiMissing) return <SetupNeeded />;
  if (view.kind === 'loading') return <div className="min-h-screen flex items-center justify-center text-sm text-slate-500">Loading…</div>;
  if (view.kind === 'login') return <Login {...view} onLoggedIn={open} />;
  return (
    <App
      initial={view.state}
      email={view.email}
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
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(error);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await api.login(email, password, remember);
      onLoggedIn();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Login failed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <form onSubmit={submit} className={`${cls.card} w-full max-w-sm p-6 space-y-4`}>
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-black">D</div>
          <div>
            <h1 className="text-lg font-bold text-slate-900">Drip</h1>
            <p className="text-xs text-slate-500">Leads and scheduled WhatsApp templates</p>
          </div>
        </div>
        {!configured && <p className="text-sm p-3 rounded-lg bg-amber-50 text-amber-900">Set APP_EMAIL and APP_PASSWORD on the server to enable login.</p>}
        <label className="block">
          <span className={cls.label}>Email</span>
          <input type="email" autoComplete="username" required className={cls.input} value={email} onChange={(e) => setEmail(e.target.value)} />
        </label>
        <label className="block">
          <span className={cls.label}>Password</span>
          <input type="password" autoComplete="current-password" required className={cls.input} value={password} onChange={(e) => setPassword(e.target.value)} />
        </label>
        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" className="accent-indigo-600" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
          Keep me signed in on this device (30 days)
        </label>
        {msg && <p className="text-sm text-rose-600">{msg}</p>}
        <button className={`${cls.primary} w-full py-2.5`} disabled={busy}>
          <LogIn className="w-4 h-4" /> {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

/** Shown on GitHub Pages when the site was built without VITE_API_URL: the page alone cannot run Drip. */
function SetupNeeded() {
  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <div className={`${cls.card} w-full max-w-lg p-6 space-y-3 text-sm text-slate-700`}>
        <div className="flex items-center gap-2.5">
          <div className="w-9 h-9 rounded-lg bg-indigo-600 flex items-center justify-center text-white font-black">D</div>
          <h1 className="text-lg font-bold text-slate-900">Drip needs its server</h1>
        </div>
        <p>
          This page is only the front end. Leads, the WhatsApp token and scheduled sending live on the Drip server, which GitHub Pages
          cannot run.
        </p>
        <ol className="list-decimal pl-5 space-y-1">
          <li>Deploy the repository on Vercel (or any Node host) and set its environment variables (see README).</li>
          <li>
            In GitHub → Settings → Secrets and variables → Actions → <b>Variables</b>, add <code>DRIP_API_URL</code> = the server address, e.g.{' '}
            <code>https://drip.vercel.app</code>.
          </li>
          <li>Re-run the "Deploy to GitHub Pages" workflow.</li>
        </ol>
      </div>
    </div>
  );
}
