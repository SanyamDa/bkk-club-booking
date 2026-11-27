import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { adminApi } from '../../api';
import { errText, fmtTime, Json } from './AdminLayout';

/** Conversation timeline (messages, events, booking changes) or booking timeline (status history), ordered by time. */
export function Timeline({ kind }: { kind: 'conversations' | 'bookings' }) {
  const { slug = '', id = '' } = useParams();
  const [items, setItems] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    setItems(null);
    adminApi.timeline(slug, kind, id).then((d) => setItems(d.items ?? (d.history ?? []).map((h) => ({ kind: 'status_change', ...h })))).catch((e) => { setError(errText(e)); setItems([]); });
  }, [slug, kind, id]);

  return (
    <div className="stack" style={{ maxWidth: 900 }}>
      <div className="spread wrap">
        <h1>{kind === 'conversations' ? 'Conversation' : 'Booking'} timeline · <span className="mono">{id}</span></h1>
        <div className="row">
          {kind === 'conversations' && <Link className="btn small" to={`/admin/events?club=${slug}&conversation=${encodeURIComponent(id)}`}>Events</Link>}
          {kind === 'bookings' && <Link className="btn small" to={`/admin/events?club=${slug}&booking=${encodeURIComponent(id)}`}>Events</Link>}
          <Link className="btn small" to={`/admin/clubs/${slug}`}>Back to club</Link>
        </div>
      </div>
      {error && <div className="error">{error}</div>}
      {!items ? (
        <div className="muted">Loading…</div>
      ) : items.length === 0 ? (
        <div className="muted">Nothing recorded.</div>
      ) : (
        <div className="stack" style={{ gap: 6 }}>
          {items.map((it, i) => {
            const label = it.kind ?? it.type ?? 'item';
            const text = it.payload?.text ?? it.text ?? (it.to ? `${it.from ?? '—'} → ${it.to}` : it.type ?? '');
            const who = [it.direction, it.authorType ?? it.actorType, it.sentVia].filter(Boolean).join(' · ');
            return (
              <div key={i} className="card" style={{ padding: 10 }}>
                <div className="spread wrap">
                  <div className="row wrap">
                    <span className="faint mono">{fmtTime(it.at ?? it.createdAt ?? it.occurredAt)}</span>
                    <span className="chip">{label}</span>
                    {who && <span className="faint">{who}</span>}
                    {it.deliveryStatus && <span className={`chip ${it.deliveryStatus === 'failed' ? 's-rejected' : 's-confirmed'}`}>{it.deliveryStatus}</span>}
                    {it.reasonCode && <span className="faint">why: {String(it.reasonCode)}</span>}
                    {it.result && <span className="chip">{String(it.result)}</span>}
                  </div>
                  <button className="btn small" onClick={() => setOpen(open === i ? null : i)}>{open === i ? 'Hide' : 'Detail'}</button>
                </div>
                {text && <div style={{ whiteSpace: 'pre-wrap', marginTop: 4 }}>{text}</div>}
                {it.error && <div className="error">{typeof it.error === 'string' ? it.error : JSON.stringify(it.error)}</div>}
                {open === i && <Json value={it} />}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
