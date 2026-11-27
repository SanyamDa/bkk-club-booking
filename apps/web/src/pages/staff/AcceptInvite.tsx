import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../api';

interface Preview { club: { name: string }; email: string; role: string }

/** `/invite#<token>` (plan A8): the token is in the fragment, so it never reaches a server log. */
export function AcceptInvite() {
  const navigate = useNavigate();
  const [token] = useState(() => window.location.hash.slice(1));
  const [preview, setPreview] = useState<Preview | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) return setInvalid(true);
    api<Preview>('/api/auth/invites/preview', { body: { token } }).then(setPreview, () => setInvalid(true));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const d = await api<{ club: { slug: string }; loginRequired?: boolean }>('/api/auth/invites/accept', { body: { token, name, password } });
      try {
        localStorage.setItem('club', d.club.slug);
      } catch {
        /* storage blocked: the dashboard picks the first club */
      }
      navigate(d.loginRequired ? '/staff/login' : '/staff', { replace: true });
    } catch (err) {
      const kind = err instanceof ApiError ? err.body.error : undefined;
      if (kind === 'weak_password') setError('Use at least 10 characters.');
      else if (kind === 'invalid_login') setError('That password is not right. If you already have an account, use its password.');
      else setInvalid(true);
    } finally {
      setBusy(false);
    }
  }

  if (invalid) {
    return (
      <div className="guest stack" style={{ marginTop: '12vh' }}>
        <h1>Invite not valid</h1>
        <p className="muted">This link was used already, cancelled or expired. Ask your manager for a new one.</p>
      </div>
    );
  }
  if (!preview) return <div className="guest muted">Loading…</div>;

  return (
    <form className="guest stack" style={{ marginTop: '12vh' }} onSubmit={submit}>
      <div className="brand" style={{ fontSize: 18 }}>Club<span style={{ color: 'var(--accent)' }}>·</span>Booking</div>
      <h1>Join {preview.club.name}</h1>
      <p className="muted">You are invited as <b>{preview.role}</b> with {preview.email}.</p>
      <div className="field">
        <label htmlFor="name">Your name (new accounts)</label>
        <input id="name" className="input" autoComplete="name" autoFocus value={name} onChange={(e) => setName(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pw">Password</label>
        <input id="pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <div className="faint">Already have an account? Use its password. New here? Choose one of 10 or more characters.</div>
      </div>
      {error && <div className="error">{error}</div>}
      <button className="btn primary block" disabled={busy || !password}>Join</button>
    </form>
  );
}
