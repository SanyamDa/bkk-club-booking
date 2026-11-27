import { useEffect, useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router-dom';
import { adminApi, api, ApiError } from '../../api';

/** Short local date-time, or a dash. */
export function fmtTime(v: unknown): string {
  if (!v) return '—';
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/** Human error text for a failed admin call. */
export function errText(e: unknown): string {
  if (e instanceof ApiError) {
    const code = e.body.error;
    if (code === 'totp_required') return 'Enter a fresh 6-digit authenticator code.';
    if (code === 'invalid_totp') return 'That authenticator code is not right. Try the current one.';
    if (code === 'not_ready') return 'Not available yet: this part of the platform has not shipped.';
    if (code === 'profile_missing') return 'Fill the club profile before going live.';
    if (code === 'login_not_configured') return 'No LINE Login channel resolves for this club (set the platform channel in Controls, or a club login channel).';
    return e.message;
  }
  return e instanceof Error ? e.message : 'Something went wrong';
}

export function Ok({ ok, yes = 'OK', no = 'Fix' }: { ok: boolean | undefined; yes?: string; no?: string }) {
  return <span className={`chip ${ok ? 's-confirmed' : ok === false ? 's-rejected' : 's-payment_review'}`}>{ok ? yes : ok === false ? no : '…'}</span>;
}

export function Json({ value }: { value: unknown }) {
  return <pre className="faint" style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 260, overflow: 'auto' }}>{JSON.stringify(value, null, 2)}</pre>;
}

/** Fresh TOTP input used by the three sensitive changes. */
export function TotpField({ value, onChange, id = 'totp' }: { value: string; onChange: (v: string) => void; id?: string }) {
  return (
    <div className="field">
      <label htmlFor={id}>Fresh authenticator code</label>
      <input id={id} className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={value} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} />
    </div>
  );
}

/** Founder console shell: platform admins only (A1 login with TOTP, then /admin). */
export function AdminLayout() {
  const navigate = useNavigate();
  const [state, setState] = useState<'loading' | 'ok' | 'forbidden'>('loading');
  const [email, setEmail] = useState('');

  useEffect(() => {
    adminApi
      .me()
      .then((d) => {
        setEmail(d.user.email);
        setState(d.user.platformRole === 'admin' ? 'ok' : 'forbidden');
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) navigate('/staff/login?next=/admin', { replace: true });
        else setState('forbidden');
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function logout() {
    await api('/api/auth/logout', { body: {} });
    navigate('/staff/login?next=/admin');
  }

  if (state === 'loading') return <div className="staff muted">Loading…</div>;
  if (state === 'forbidden')
    return (
      <div className="staff stack">
        <h1>Founder console</h1>
        <p className="error">This account is not a platform admin.</p>
        <a href="/staff">Back to the dashboard</a>
      </div>
    );

  return (
    <div className="staff">
      <header className="topbar">
        <div className="row">
          <div className="brand">Club<span>·</span>Booking</div>
          <span className="muted">Founder console</span>
          <span className="faint">{email}</span>
        </div>
        <nav className="nav" aria-label="Founder console">
          <NavLink to="/admin" end>Clubs</NavLink>
          <NavLink to="/admin/data">Data health</NavLink>
          <NavLink to="/admin/events">Event stream</NavLink>
          <NavLink to="/admin/controls">Controls</NavLink>
          <button className="btn small" onClick={logout}>Log out</button>
        </nav>
      </header>
      <Outlet />
    </div>
  );
}
