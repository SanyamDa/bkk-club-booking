import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { api, Status } from '../../api';
import { MessageThread, type ThreadMessage } from './MessageThread';

interface Detail {
  booking: {
    id: string; ref: string; status: string; nightDate: string; pax: number; table: string; zone: string;
    minSpend: string; deposit: string; source: string; specialRequest: string | null; notes: string | null;
    statusReason: string | null; rulesAcceptedAt: string | null; createdAt: string;
  };
  guest: { name: string | null; displayName: string | null; phone: string | null; nationality: string | null; viaLine: boolean };
  deposits: { id: string; amount: string; method: string; status: string; hasSlip: boolean; slipReceivedAt: string | null; verifiedBy: string | null; note: string | null }[];
  messages: ThreadMessage[];
}

export function BookingDetail() {
  const { id = '' } = useParams();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<Detail>(`/api/staff/bookings/${id}`).then(setD).catch((e) => setError(String(e.message))), [id]);
  useEffect(() => { void load(); }, [load]);

  async function act(action: string, opts: { confirm?: string; askReason?: string } = {}) {
    let reason: string | undefined;
    if (opts.askReason) {
      const r = window.prompt(opts.askReason);
      if (r === null) return;
      reason = r;
    } else if (opts.confirm && !window.confirm(opts.confirm)) return;
    setBusy(true);
    setError('');
    try {
      await api(`/api/staff/bookings/${id}/${action}`, { body: { reason } });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Action failed');
    } finally {
      setBusy(false);
    }
  }

  if (!d) return <div className="muted">{error || 'Loading…'}</div>;
  const b = d.booking;
  const slip = d.deposits.find((x) => x.hasSlip);
  const canCancel = ['held', 'awaiting_payment', 'payment_review', 'confirmed'].includes(b.status);

  return (
    <div className="stack" style={{ gap: 20 }}>
      <Link to="/staff" className="faint">← Tonight</Link>
      <div className="spread wrap">
        <div>
          <h1>{b.table} · {d.guest.name ?? d.guest.displayName ?? 'Guest'}</h1>
          <div className="faint mono">{b.ref}</div>
        </div>
        <Status status={b.status} />
      </div>
      {error && <div className="error">{error}</div>}

      <div className="split">
        <div className="main stack">
          <div className="card">
            <dl className="summary" style={{ margin: 0 }}>
              <dt>Night</dt><dd>{b.nightDate}</dd>
              <dt>Table</dt><dd>{b.table} · {b.zone}</dd>
              <dt>Guests</dt><dd>{b.pax}</dd>
              <dt>Minimum spend</dt><dd>{b.minSpend}</dd>
              <dt>Deposit</dt><dd>{b.deposit}</dd>
              <dt>Phone</dt><dd>{d.guest.phone ?? '—'}</dd>
              <dt>Nationality</dt><dd>{d.guest.nationality ?? '—'}</dd>
              <dt>Source</dt><dd>{b.source === 'manual' ? 'Manual (staff)' : 'LINE'}</dd>
              <dt>Rules accepted</dt><dd>{b.rulesAcceptedAt ? new Date(b.rulesAcceptedAt).toLocaleString() : '—'}</dd>
              {b.specialRequest && (<><dt>Request</dt><dd>{b.specialRequest}</dd></>)}
              {b.notes && (<><dt>Notes</dt><dd>{b.notes}</dd></>)}
              {b.statusReason && (<><dt>Reason</dt><dd>{b.statusReason}</dd></>)}
            </dl>
          </div>

          {slip && (
            <div className="card stack">
              <div className="spread"><h2>Payment slip</h2><Status status={slip.status === 'review' ? 'payment_review' : slip.status === 'verified' ? 'confirmed' : 'rejected'} /></div>
              <p className="faint" style={{ margin: 0 }}>
                Check the amount is <b>{slip.amount}</b>, it went to the club’s account, and the time is after the booking was made.
              </p>
              <a href={`/api/staff/deposits/${slip.id}/slip`} target="_blank" rel="noreferrer">
                <img src={`/api/staff/deposits/${slip.id}/slip`} alt="Payment slip sent by the guest" style={{ maxWidth: '100%', maxHeight: 520, borderRadius: 10, border: '1px solid var(--line)', background: '#fff' }} />
              </a>
              {b.status === 'payment_review' || (b.status === 'expired' && slip.status === 'review') ? (
                <div className="row wrap">
                  <button className="btn primary" disabled={busy} onClick={() => act('approve', { confirm: `Approve ${slip.amount} and confirm ${b.table}? The guest gets their confirmation on LINE.` })}>Approve & confirm</button>
                  <button className="btn danger" disabled={busy} onClick={() => act('reject', { askReason: 'Why is the slip rejected? (sent to the guest)' })}>Reject</button>
                </div>
              ) : null}
            </div>
          )}

          <div className="row wrap">
            {b.status === 'confirmed' && <button className="btn primary" disabled={busy} onClick={() => act('arrived')}>Mark arrived</button>}
            {b.status === 'confirmed' && <button className="btn" disabled={busy} onClick={() => act('no-show', { confirm: 'Mark as no-show? The deposit is kept per the club policy.' })}>No-show</button>}
            {canCancel && <button className="btn danger" disabled={busy} onClick={() => act('cancel', { askReason: 'Reason for cancelling (sent to the guest):' })}>Cancel booking</button>}
          </div>
        </div>

        <div className="side card">
          <h2 style={{ marginBottom: 10 }}>LINE chat</h2>
          {d.guest.viaLine ? <MessageThread messages={d.messages} /> : <p className="faint">Booked by staff, not through LINE.</p>}
        </div>
      </div>
    </div>
  );
}
