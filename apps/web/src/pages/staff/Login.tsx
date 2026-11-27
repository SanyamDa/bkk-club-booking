import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../api';

export function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [needsCode, setNeedsCode] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/auth/login', { body: { email, password, ...(needsCode ? { totp: code } : {}) } });
      navigate('/staff', { replace: true });
    } catch (err) {
      const kind = err instanceof ApiError ? err.body.error : undefined;
      if (kind === 'totp_required') {
        setNeedsCode(true);
        setError('Enter the 6-digit code from your authenticator app.');
      } else if (kind === 'invalid_totp') {
        setError('That code is not right. Try the current one.');
      } else {
        setError('Wrong email or password, or too many attempts. Wait a few minutes and try again.');
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="guest stack" style={{ marginTop: '12vh' }} onSubmit={submit}>
      <div className="brand" style={{ fontSize: 18 }}>Club<span style={{ color: 'var(--accent)' }}>·</span>Booking</div>
      <h1>Staff sign in</h1>
      <div className="field">
        <label htmlFor="email">Email</label>
        <input id="email" className="input" type="email" autoComplete="username" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} />
      </div>
      <div className="field">
        <label htmlFor="pw">Password</label>
        <input id="pw" className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {needsCode && (
        <div className="field">
          <label htmlFor="totp">Authenticator code</label>
          <input id="totp" className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
        </div>
      )}
      {error && <div className="error">{error}</div>}
      <button className="btn primary block" disabled={busy || !email || !password || (needsCode && code.length !== 6)}>Sign in</button>
    </form>
  );
}
