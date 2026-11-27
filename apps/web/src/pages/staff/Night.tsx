import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, Status } from '../../api';
import { useStaff } from './Layout';

interface TableRow {
  id: string;
  code: string;
  zone: string;
  minPax: number;
  maxPax: number;
  minSpend: string;
  booking: null | { id: string; status: string; guestName: string; pax: number; holdExpiresAt: string | null };
}
interface BookingRow {
  id: string;
  ref: string;
  status: string;
  table: string;
  zone: string;
  guestName: string;
  phone: string | null;
  nationality: string | null;
  pax: number;
  deposit: string;
  minSpend: string;
  source: string;
  live: boolean;
  specialRequest: string | null;
}
interface NightData {
  date: string;
  nightLabel: string;
  tables: TableRow[];
  bookings: BookingRow[];
  handoffCount: number;
}

function shiftDate(date: string, days: number) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function Night() {
  const { club } = useStaff();
  const navigate = useNavigate();
  const [date, setDate] = useState<string>('');
  const [data, setData] = useState<NightData | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const d = await api<NightData>(`/api/staff/clubs/${club}/night${date ? `?date=${date}` : ''}`);
      setData(d);
      if (!date) setDate(d.date);
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) navigate('/staff/login');
    }
  }, [club, date, navigate]);

  useEffect(() => {
    void load();
    const id = setInterval(load, 10_000); // live enough for a busy Friday
    return () => clearInterval(id);
  }, [load]);

  async function act(id: string, action: string, confirmText?: string) {
    if (confirmText && !window.confirm(confirmText)) return;
    setBusy(id + action);
    setError('');
    try {
      await api(`/api/staff/bookings/${id}/${action}`, { body: {} });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Action failed');
    } finally {
      setBusy(null);
    }
  }

  if (!data) return <div className="muted">Loading…</div>;
  const live = data.bookings.filter((b) => b.live);
  const review = live.filter((b) => b.status === 'payment_review');
  const guestsExpected = live.filter((b) => ['confirmed', 'arrived', 'payment_review'].includes(b.status)).reduce((n, b) => n + b.pax, 0);
  const booked = data.tables.filter((t) => t.booking && ['confirmed', 'arrived', 'payment_review'].includes(t.booking.status)).length;

  return (
    <div>
      <div className="spread wrap">
        <div className="row">
          <button className="btn small" onClick={() => setDate(shiftDate(data.date, -1))} aria-label="Previous night">←</button>
          <h1>{data.nightLabel}</h1>
          <button className="btn small" onClick={() => setDate(shiftDate(data.date, 1))} aria-label="Next night">→</button>
          <input className="input" type="date" style={{ width: 'auto', minHeight: 34 }} value={data.date} onChange={(e) => setDate(e.target.value)} aria-label="Pick a night" />
        </div>
        <Link className="btn primary" to={`/staff/new?date=${data.date}`}>+ Manual booking</Link>
      </div>

      {data.handoffCount > 0 && (
        <div className="card" style={{ marginTop: 16, borderColor: '#5a2a25' }}>
          <div className="spread">
            <span><b>{data.handoffCount}</b> guest{data.handoffCount > 1 ? 's are' : ' is'} waiting for a host.</span>
            <Link className="btn small" to="/staff/handoffs">Open chats</Link>
          </div>
        </div>
      )}

      <div className="stats">
        <div className="stat"><b>{booked}/{data.tables.length}</b><span>Tables booked</span></div>
        <div className="stat"><b>{guestsExpected}</b><span>Guests expected</span></div>
        <div className="stat"><b style={{ color: review.length ? 'var(--warn)' : undefined }}>{review.length}</b><span>Slips to check</span></div>
        <div className="stat"><b>{live.filter((b) => b.status === 'arrived').length}</b><span>Arrived</span></div>
      </div>

      {error && <div className="error" style={{ marginBottom: 12 }}>{error}</div>}

      <h2 style={{ marginBottom: 10 }}>Table map</h2>
      <div className="tablemap">
        {data.tables.map((t) => (
          <button
            key={t.id}
            className={`tile ${t.booking ? `st-${t.booking.status}` : 'free'}`}
            onClick={() => (t.booking ? navigate(`/staff/bookings/${t.booking.id}`) : navigate(`/staff/new?date=${data.date}&table=${t.id}`))}
          >
            <span className="spread"><span className="code">{t.code}</span>{t.booking && <Status status={t.booking.status} />}</span>
            <span className="faint">{t.zone} · {t.minPax}–{t.maxPax}</span>
            <span className="who">{t.booking ? `${t.booking.guestName} · ${t.booking.pax}p` : `Free · ${t.minSpend}`}</span>
          </button>
        ))}
      </div>

      <h2 style={{ margin: '28px 0 10px' }}>Bookings</h2>
      {data.bookings.length === 0 ? (
        <p className="muted">No bookings for this night yet.</p>
      ) : (
        <div className="scroll-x">
          <table className="list">
            <thead>
              <tr><th>Table</th><th>Guest</th><th>Pax</th><th>Deposit</th><th>Status</th><th>Ref</th><th></th></tr>
            </thead>
            <tbody>
              {data.bookings.map((b) => (
                <tr key={b.id} style={{ opacity: b.live ? 1 : 0.55 }}>
                  <td><b>{b.table}</b> <span className="faint">{b.zone}</span></td>
                  <td>
                    <Link to={`/staff/bookings/${b.id}`} style={{ color: 'var(--text)' }}>{b.guestName}</Link>
                    <div className="faint">{[b.nationality, b.phone, b.source === 'manual' ? 'manual' : null].filter(Boolean).join(' · ')}</div>
                    {b.specialRequest && <div className="faint">“{b.specialRequest}”</div>}
                  </td>
                  <td>{b.pax}</td>
                  <td>{b.deposit}</td>
                  <td><Status status={b.status} /></td>
                  <td className="mono faint">{b.ref}</td>
                  <td>
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      {b.status === 'payment_review' && (
                        <Link className="btn small primary" to={`/staff/bookings/${b.id}`}>Check slip</Link>
                      )}
                      {b.status === 'confirmed' && (
                        <button className="btn small" disabled={busy === b.id + 'arrived'} onClick={() => act(b.id, 'arrived')}>Arrived</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
