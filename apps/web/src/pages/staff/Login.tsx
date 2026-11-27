import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError } from '../../api';

export function Login() {
  const navigate = useNavigate();
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/staff/login', { body: { password } });
      navigate('/staff', { replace: true });
    } catch (err) {
      setError(err instanceof ApiError && err.status === 429 ? 'Too many attempts. Wait a minute.' : 'Wrong password.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="guest stack" style={{ marginTop: '12vh' }} onSubmit={submit}>
      <div className="brand" style={{ fontSize: 18 }}>Club<span style={{ color: 'var(--accent)' }}>·</span>Booking</div>
      <h1>Staff sign in</h1>
      <div className="field">
        <label htmlFor="pw">Password</label>
        <input id="pw" className="input" type="password" autoComplete="current-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
      </div>
      {error && <div className="error">{error}</div>}
      <button className="btn primary block" disabled={busy || !password}>Sign in</button>
    </form>
  );
}
