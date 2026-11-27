import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router-dom';
import { adminApi } from '../../api';
import { errText, fmtTime, Json } from './AdminLayout';

const FILTERS = ['club', 'conversation', 'booking', 'guest'] as const;
type Filter = (typeof FILTERS)[number];

/** §14.6 Event stream: live, filterable by club, conversation, booking or guest. Polls. */
export function EventStream() {
  const [params, setParams] = useSearchParams();
  const active = Object.fromEntries(FILTERS.map((f) => [f, params.get(f) ?? ''])) as Record<Filter, string>;
  const [draft, setDraft] = useState(active);
  const [events, setEvents] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [live, setLive] = useState(true);
  const key = params.toString();

  useEffect(() => {
    setDraft(active);
    setEvents(null);
    const load = () =>
      adminApi
        .events({ ...active, limit: 100 })
        .then((d) => { setEvents(d.events); setError(''); })
        .catch((e) => setError(errText(e)));
    void load();
    if (!live) return;
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [key, live]); // eslint-disable-line react-hooks/exhaustive-deps

  function apply(e: FormEvent) {
    e.preventDefault();
    const next = new URLSearchParams();
    for (const f of FILTERS) if (draft[f].trim()) next.set(f, draft[f].trim());
    setParams(next);
  }

  return (
    <div className="stack">
      <div className="spread wrap">
        <h1>Event stream</h1>
        <label className="check"><input type="checkbox" checked={live} onChange={(e) => setLive(e.target.checked)} /><span>Live (every 5 s)</span></label>
      </div>
      <form className="row wrap" onSubmit={apply}>
        {FILTERS.map((f) => (
          <input key={f} className="input mono" style={{ width: 180, minHeight: 34 }} placeholder={f} aria-label={f} value={draft[f]} onChange={(e) => setDraft({ ...draft, [f]: e.target.value })} />
        ))}
        <button className="btn small primary">Filter</button>
        <button type="button" className="btn small" onClick={() => setParams(new URLSearchParams())}>Clear</button>
      </form>
      {error && <div className="error">{error}</div>}
      {!events ? (
        <div className="muted">Loading…</div>
      ) : (
        <div className="scroll-x">
          <table className="list">
            <thead>
              <tr><th>Time</th><th>Type</th><th>Club</th><th>Conversation</th><th>Booking</th><th>Guest</th><th /></tr>
            </thead>
            <tbody>
              {events.map((ev) => {
                const id = String(ev.id);
                const link = (f: Filter, v: unknown) =>
                  v ? <button type="button" className="btn small mono" onClick={() => setParams(new URLSearchParams({ ...(active.club ? { club: active.club } : {}), [f]: String(v) }))}>{String(v).slice(-8)}</button> : '';
                return (
                  <Fragment key={id}>
                    <tr>
                      <td>{fmtTime(ev.occurredAt ?? ev.createdAt)}</td>
                      <td><span className="chip">{ev.type}</span>{ev.isTest ? <span className="faint"> test</span> : ''}</td>
                      <td>{ev.clubSlug ?? ev.clubId ?? ''}</td>
                      <td>{link('conversation', ev.conversationId)}</td>
                      <td>{link('booking', ev.bookingId)}</td>
                      <td>{link('guest', ev.guestId)}</td>
                      <td><button className="btn small" onClick={() => setOpen(open === id ? null : id)}>{open === id ? 'Hide' : 'Data'}</button></td>
                    </tr>
                    {open === id && (
                      <tr><td colSpan={7}><Json value={ev} /></td></tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
          {events.length === 0 && <div className="muted">No events match.</div>}
        </div>
      )}
    </div>
  );
}
