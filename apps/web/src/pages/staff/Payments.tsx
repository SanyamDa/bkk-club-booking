import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, staffPath, Status } from '../../api';
import { useStaff } from './Layout';

interface Payment {
  depositId: string; bookingId: string; ref: string; nightDate: string; table: string; guestName: string; bookingStatus: string;
  expected: string; amountRead: string | null; amountMatches: boolean | null; receiver: string | null; slipTime: string | null; hasSlip: boolean; problem: string | null;
}

/** §6.2 Payments: slips waiting for review (amount read against expected) and the deposit report CSV. */
export function Payments() {
  const { club } = useStaff();
  const [rows, setRows] = useState<Payment[]>([]);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<{ payments: Payment[] }>(staffPath(club, '/payments')).then((d) => setRows(d.payments)).catch((e) => setError(String(e.message))), [club]);
  useEffect(() => { void load(); }, [load]);

  async function act(p: Payment, action: 'approve' | 'reject') {
    let reason: string | undefined;
    if (action === 'reject') {
      const r = window.prompt('Why is the slip rejected? (sent to the guest)');
      if (r === null) return;
      reason = r;
    } else if (!window.confirm(`Approve ${p.expected} and confirm ${p.table}?`)) return;
    setBusy(true);
    try {
      await api(staffPath(club, `/bookings/${p.bookingId}/${action}`), { body: { reason } });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  const csv = staffPath(club, `/payments/deposits.csv?${new URLSearchParams(Object.entries({ from, to }).filter(([, v]) => v)).toString()}`);
  return (
    <div className="stack">
      <h1>Payments</h1>
      {error && <div className="error">{error}</div>}
      <div className="card stack">
        <h2>Slips waiting for review</h2>
        {rows.length === 0 && <div className="faint">Nothing to review.</div>}
        {rows.map((p) => (
          <div key={p.depositId} className="stack" style={{ gap: 6, borderTop: '1px solid var(--line)', paddingTop: 10 }}>
            <div className="spread">
              <Link to={`/staff/bookings/${p.bookingId}`}>{p.nightDate} · {p.table} · {p.guestName} <span className="faint mono">{p.ref}</span></Link>
              <Status status={p.bookingStatus} />
            </div>
            <div className="faint">
              Expected <b>{p.expected}</b> · read from slip <b>{p.amountRead ?? 'unreadable'}</b>
              {p.amountMatches === false ? ' · amount does not match' : ''}{p.problem ? ` · ${p.problem}` : ''}
            </div>
            {p.hasSlip && (
              <a href={staffPath(club, `/deposits/${p.depositId}/slip`)} target="_blank" rel="noreferrer">
                <img src={staffPath(club, `/deposits/${p.depositId}/slip`)} alt="Payment slip" style={{ maxWidth: 240, borderRadius: 8, border: '1px solid var(--line)' }} />
              </a>
            )}
            <div className="row wrap">
              <button className="btn primary small" disabled={busy} onClick={() => void act(p, 'approve')}>Approve</button>
              <button className="btn danger small" disabled={busy} onClick={() => void act(p, 'reject')}>Reject with reason</button>
            </div>
          </div>
        ))}
      </div>
      <div className="card stack">
        <h2>Deposit report</h2>
        <div className="row wrap">
          <input className="input" type="date" aria-label="From night" value={from} onChange={(e) => setFrom(e.target.value)} />
          <input className="input" type="date" aria-label="To night" value={to} onChange={(e) => setTo(e.target.value)} />
          <a className="btn" href={csv}>Export CSV</a>
        </div>
      </div>
    </div>
  );
}
