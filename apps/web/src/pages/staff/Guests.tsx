import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, staffPath, Status } from '../../api';
import { useStaff } from './Layout';

interface GuestSummary { id: string; name: string | null; displayName: string | null; phone: string | null; tags: string[]; bookings: number; visits: number; lastNight: string | null }
interface Profile {
  guest: { id: string; name: string | null; displayName: string | null; phone: string | null; lang: string };
  tags: string[];
  notes: { id: string; text: string; author: string | null; createdAt: string }[];
  stats: { bookings: number; visits: number; noShows: number; spendSatang: number; lastVisit: string | null };
  bookings: { id: string; ref: string; nightDate: string; status: string; pax: number; tableCode: string | null; spendSatang: number | null }[];
}

const baht = (satang: number) => `฿${(satang / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const label = (g: { name: string | null; displayName: string | null }) => g.name || g.displayName || 'Guest';

function GuestPanel({ club, id, onChange }: { club: string; id: string; onChange: () => void }) {
  const [p, setP] = useState<Profile | null>(null);
  const [tag, setTag] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const load = () => api<{ profile: Profile }>(staffPath(club, `/guests/${id}`)).then((d) => setP(d.profile)).catch(() => setError('Could not load the guest.'));
  useEffect(() => {
    setP(null);
    void load();
  }, [club, id]);

  async function addTag(t: string, e?: FormEvent) {
    e?.preventDefault();
    setError(null);
    try {
      await api(staffPath(club, `/guests/${id}/tags`), { body: { tag: t } });
      setTag('');
      await load();
      onChange();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 400 ? 'Tags are up to 32 characters, no commas.' : 'Could not add the tag.');
    }
  }
  async function removeTag(t: string) {
    await api(staffPath(club, `/guests/${id}/tags/${encodeURIComponent(t)}`), { method: 'DELETE' });
    await load();
    onChange();
  }
  async function addNote(e: FormEvent) {
    e.preventDefault();
    if (!note.trim()) return;
    await api(staffPath(club, `/guests/${id}/notes`), { body: { text: note } });
    setNote('');
    await load();
  }

  if (!p) return <div className="card muted">{error || 'Loading…'}</div>;
  const s = p.stats;
  return (
    <div className="card stack">
      <div className="spread wrap">
        <h2 style={{ margin: 0 }}>{label(p.guest)}</h2>
        <span className="faint">{p.guest.phone ?? ''}</span>
      </div>
      <div className="faint">
        {s.bookings} bookings · {s.visits} visits · {s.noShows} no-show · spend {baht(s.spendSatang)}{s.lastVisit ? ` · last visit ${s.lastVisit}` : ''}
      </div>
      {error && <div className="error">{error}</div>}
      <div className="row wrap">
        {p.tags.map((t) => (
          <button key={t} className="btn small" title="Remove tag" onClick={() => void removeTag(t)}>{t.toUpperCase() === 'VIP' ? 'VIP' : t} ×</button>
        ))}
        {!p.tags.includes('vip') && <button className="btn small primary" onClick={() => void addTag('vip')}>Mark VIP</button>}
      </div>
      <form className="row" onSubmit={(e) => void addTag(tag, e)}>
        <input className="input" placeholder="Add a tag" value={tag} onChange={(e) => setTag(e.target.value)} aria-label="New tag" />
        <button className="btn small" disabled={!tag.trim()}>Add</button>
      </form>
      <form className="stack" onSubmit={(e) => void addNote(e)}>
        <textarea className="input" rows={2} placeholder="Add a note for the team" value={note} onChange={(e) => setNote(e.target.value)} aria-label="New note" />
        <div className="row"><button className="btn small" disabled={!note.trim()}>Save note</button></div>
      </form>
      {p.notes.map((n) => (
        <div key={n.id}>
          <div>{n.text}</div>
          <div className="faint">{n.author ?? 'Staff'} · {new Date(n.createdAt).toLocaleString()}</div>
        </div>
      ))}
      <h3 style={{ margin: '8px 0 0' }}>Bookings</h3>
      {p.bookings.map((b) => (
        <div key={b.id} className="spread">
          <span>{b.nightDate} · {b.tableCode ?? '–'} · {b.pax} pax{b.spendSatang !== null ? ` · ${baht(b.spendSatang)}` : ''}</span>
          <Status status={b.status} />
        </div>
      ))}
    </div>
  );
}

/** Guest CRM (plan A20c): search guests, see their history, add VIP and other tags and notes. */
export function Guests() {
  const { club } = useStaff();
  const [q, setQ] = useState('');
  const [vipOnly, setVipOnly] = useState(false);
  const [list, setList] = useState<GuestSummary[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  function search() {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (vipOnly) params.set('tag', 'vip');
    const qs = params.toString();
    api<{ guests: GuestSummary[] }>(staffPath(club, `/guests${qs ? `?${qs}` : ''}`))
      .then((d) => {
        setError(null);
        setList(d.guests);
      })
      .catch((err) => setError(err instanceof ApiError && err.status === 403 ? 'Door accounts cannot see the guest list.' : 'Could not load guests.'));
  }
  useEffect(() => {
    const t = setTimeout(search, 250);
    return () => clearTimeout(t);
  }, [club, q, vipOnly]);

  return (
    <div className="stack" style={{ gap: 16 }}>
      <h1>Guests</h1>
      <div className="row wrap">
        <input className="input" style={{ flex: '1 1 220px' }} placeholder="Name, LINE name or phone" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Search guests" />
        <label className="row"><input type="checkbox" checked={vipOnly} onChange={(e) => setVipOnly(e.target.checked)} /> VIP only</label>
      </div>
      {error && <div className="error">{error}</div>}
      {selected && <GuestPanel club={club} id={selected} onChange={search} />}
      <div className="card stack">
        {list === null && !error && <div className="muted">Loading…</div>}
        {list?.length === 0 && <div className="muted">No guests found.</div>}
        {list?.map((g) => (
          <button key={g.id} className="spread" style={{ background: 'none', border: 0, padding: '6px 0', textAlign: 'left', cursor: 'pointer', color: 'inherit' }} onClick={() => setSelected(g.id)}>
            <span>
              <b>{label(g)}</b> {g.tags.map((t) => <span key={t} className="badge">{t}</span>)}
            </span>
            <span className="faint">{g.visits} visits · {g.lastNight ?? '–'}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
