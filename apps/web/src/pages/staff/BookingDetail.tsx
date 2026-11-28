import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useStaff } from './Layout';
import { api, staffPath, Status } from '../../api';
import { MessageThread, type ThreadMessage } from './MessageThread';

interface Detail {
  booking: {
    id: string; ref: string; status: string; nightDate: string; pax: number; table: string; zone: string;
    minSpend: string; deposit: string; source: string; specialRequest: string | null; notes: string | null;
    statusReason: string | null; rulesAcceptedAt: string | null; createdAt: string;
    tableId?: string; occasion?: string | null; rulesVersion?: string | null;
  };
  history?: { from: string | null; to: string; at: string; actorType: string; actorId: string | null; reasonCode: string | null }[];
  audit?: { action: string; at: string; actorType: string; actorId: string | null; reason: string | null }[];
  chatSummary?: { mode: string | null; handoffReason: string | null; handoffs: { startedAt: string; trigger: string; topic: string | null; summary: string | null }[] };
  guest: { name: string | null; displayName: string | null; phone: string | null; nationality: string | null; viaLine: boolean; unfollowedAt?: string | null };
  deposits: { id: string; amount: string; method: string; status: string; hasSlip: boolean; slipReceivedAt: string | null; verifiedBy: string | null; note: string | null }[];
  messages: ThreadMessage[];
}

export function BookingDetail() {
  const { id = '' } = useParams();
  const { club } = useStaff();
  const [d, setD] = useState<Detail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => api<Detail>(staffPath(club, `/bookings/${id}`)).then(setD).catch((e) => setError(String(e.message))), [club, id]);
  useEffect(() => { void load(); }, [load]);

  async function change(body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      await api(staffPath(club, `/bookings/${id}/change`), { body });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Change failed');
    } finally {
      setBusy(false);
    }
  }
  function changePax() {
    const v = window.prompt('New party size:', String(d?.booking.pax ?? ''));
    if (v) void change({ pax: Number(v) });
  }
  function moveBooking() {
    const night = window.prompt('Night (YYYY-MM-DD):', d?.booking.nightDate ?? '');
    if (night === null) return;
    const tableId = window.prompt('Table id (leave as is to keep the table):', d?.booking.tableId ?? '');
    if (tableId === null) return;
    void change({ nightDate: night, ...(tableId ? { tableId } : {}) });
  }
  function editNotes() {
    const v = window.prompt('Notes for staff:', d?.booking.notes ?? '');
    if (v !== null) void change({ notes: v || null });
  }
  async function cancelWithDeposit() {
    const reason = window.prompt('Reason for cancelling (sent to the guest):');
    if (reason === null) return;
    const paid = d?.deposits.some((x) => x.status === 'verified');
    const deposit = paid ? (window.confirm('Keep (forfeit) the deposit? OK = keep it, Cancel = it will be refunded by hand.') ? 'forfeit' : 'refund') : undefined;
    setBusy(true);
    setError('');
    try {
      await api(staffPath(club, `/bookings/${id}/cancel`), { body: { reason, deposit } });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Cancel failed');
    } finally {
      setBusy(false);
    }
  }

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
      await api(staffPath(club, `/bookings/${id}/${action}`), { body: { reason } });
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
              <dt>Source</dt><dd>{b.source === 'manual_walkin' ? 'Walk-in (staff)' : b.source.startsWith('manual') ? 'Phone (staff)' : b.source === 'line' ? 'LINE' : b.source}</dd>
              <dt>Rules accepted</dt><dd>{b.rulesAcceptedAt ? `${new Date(b.rulesAcceptedAt).toLocaleString()}${b.rulesVersion ? ` (rules ${b.rulesVersion})` : ''}` : '—'}</dd>
              {b.occasion && (<><dt>Occasion</dt><dd>{b.occasion}</dd></>)}
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
              <a href={staffPath(club, `/deposits/${slip.id}/slip`)} target="_blank" rel="noreferrer">
                <img src={staffPath(club, `/deposits/${slip.id}/slip`)} alt="Payment slip sent by the guest" style={{ maxWidth: '100%', maxHeight: 520, borderRadius: 10, border: '1px solid var(--line)', background: '#fff' }} />
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
            {canCancel && <button className="btn" disabled={busy} onClick={changePax}>Change party size</button>}
            {canCancel && <button className="btn" disabled={busy} onClick={moveBooking}>Change table or night</button>}
            <button className="btn" disabled={busy} onClick={editNotes}>Notes</button>
            {canCancel && <button className="btn danger" disabled={busy} onClick={() => void cancelWithDeposit()}>Cancel booking</button>}
          </div>

          {d.chatSummary && (d.chatSummary.handoffs.length > 0 || d.chatSummary.handoffReason) && (
            <div className="card stack">
              <h2>Chat summary</h2>
              {d.chatSummary.handoffs.map((h) => (
                <div key={h.startedAt} className="faint">{new Date(h.startedAt).toLocaleString()} · {h.topic ?? h.trigger}{h.summary ? ` · ${h.summary}` : ''}</div>
              ))}
            </div>
          )}

          {d.history && d.history.length > 0 && (
            <div className="card stack">
              <h2>History</h2>
              {d.history.map((h) => (
                <div key={`${h.at}-${h.to}`} className="faint">{new Date(h.at).toLocaleString()} · {h.from ?? 'new'} → {h.to} · {h.actorType}{h.reasonCode ? ` · ${h.reasonCode}` : ''}</div>
              ))}
            </div>
          )}

          {d.audit && d.audit.length > 0 && (
            <div className="card stack">
              <h2>Audit trail</h2>
              {d.audit.map((a, i) => (
                <div key={`${a.at}-${i}`} className="faint mono">{new Date(a.at).toLocaleString()} · {a.action} · {a.actorType}{a.actorId ? ` ${a.actorId}` : ''}{a.reason ? ` · ${a.reason}` : ''}</div>
              ))}
            </div>
          )}
        </div>

        <div className="side card">
          <h2 style={{ marginBottom: 10 }}>LINE chat</h2>
          {d.guest.unfollowedAt && <div className="error">The guest blocked the club's LINE account, so they can't be messaged.</div>}
          {d.guest.viaLine ? <MessageThread messages={d.messages} /> : <p className="faint">Booked by staff, not through LINE.</p>}
        </div>
      </div>
    </div>
  );
}
