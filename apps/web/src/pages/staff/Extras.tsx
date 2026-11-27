import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, staffPath } from '../../api';
import { useStaff } from './Layout';

interface MenuItem { id: string; name: string; nameTh: string; priceSatang: number; active: boolean; sort: number }
interface Line { menuItemId: string; name: string; qty: number; lineTotalSatang: number }
interface NightPreorder { bookingId: string; refCode: string; status: string; tableCode: string; guestName: string | null; preorder: { lines: Line[]; totalSatang: number } }
interface Entry { id: string; guestName: string | null; paxRange: string; status: string; joinedAt: string; offerExpiresAt: string | null }

const baht = (satang: number) => `฿${(satang / 100).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const today = () => new Date(Date.now() + 7 * 3_600_000 - 6 * 3_600_000).toISOString().slice(0, 10); // Bangkok night (ends 06:00)

/** B22: the bottle menu, the night's bottle pre-orders and its waitlist. */
export function Extras() {
  const { club } = useStaff();
  const [date, setDate] = useState(today());
  const [menu, setMenu] = useState<MenuItem[] | null>(null);
  const [preorders, setPreorders] = useState<NightPreorder[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState('');
  const [nameTh, setNameTh] = useState('');
  const [price, setPrice] = useState('');

  async function load() {
    setError(null);
    try {
      const [m, p, w] = await Promise.all([
        api<{ items: MenuItem[] }>(staffPath(club, '/menu')),
        api<{ preorders: NightPreorder[] }>(staffPath(club, `/preorders?date=${date}`)),
        api<{ entries: Entry[] }>(staffPath(club, `/waitlist?date=${date}`)),
      ]);
      setMenu(m.items);
      setPreorders(p.preorders);
      setEntries(w.entries);
    } catch {
      setError('Could not load the menu, pre-orders or waitlist.');
    }
  }
  useEffect(() => {
    void load();
  }, [club, date]);

  async function addItem(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      await api(staffPath(club, '/menu'), { body: { name, nameTh, priceSatang: Math.round(Number(price) * 100) } });
      setName('');
      setNameTh('');
      setPrice('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 403 ? 'Only owners and managers can change the menu.' : 'Check the name and price.');
    }
  }

  async function toggle(i: MenuItem) {
    try {
      await api(staffPath(club, `/menu/${i.id}`), { method: 'PATCH', body: { active: !i.active } });
      await load();
    } catch {
      setError('Only owners and managers can change the menu.');
    }
  }

  async function remove(entry: Entry) {
    await api(staffPath(club, `/waitlist/${entry.id}`), { method: 'DELETE' });
    await load();
  }

  if (!menu) return <div className="muted">{error ?? 'Loading…'}</div>;
  return (
    <div className="stack" style={{ gap: 16 }}>
      <div className="spread wrap">
        <h1>Bottles and waitlist</h1>
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Night" style={{ maxWidth: 180 }} />
      </div>
      {error && <div className="error">{error}</div>}

      <div className="card stack">
        <h2>Pre-orders</h2>
        <p className="faint" style={{ margin: 0 }}>Not charged: the guest pays at the club. Prices are the menu prices when ordered.</p>
        {preorders.length === 0 && <div className="muted">No pre-orders for this night.</div>}
        {preorders.map((p) => (
          <div key={p.bookingId} className="stack" style={{ gap: 2 }}>
            <div className="spread wrap">
              <b>{p.tableCode} · {p.guestName ?? 'Guest'}</b>
              <span className="faint">{p.refCode} · {p.status} · {baht(p.preorder.totalSatang)}</span>
            </div>
            <div className="faint">{p.preorder.lines.map((l) => `${l.qty}× ${l.name}`).join(', ')}</div>
          </div>
        ))}
      </div>

      <div className="card stack">
        <h2>Waitlist</h2>
        {entries.length === 0 && <div className="muted">Nobody is waiting for this night.</div>}
        {entries.map((e) => (
          <div key={e.id} className="spread wrap">
            <span>{e.guestName ?? 'Guest'} · {e.paxRange} guests · {e.status}{e.offerExpiresAt && e.status === 'offered' ? ` until ${new Date(e.offerExpiresAt).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Bangkok' })}` : ''}</span>
            {(e.status === 'waiting' || e.status === 'offered') && <button className="btn small" onClick={() => void remove(e)}>Remove</button>}
          </div>
        ))}
      </div>

      <form className="card stack" onSubmit={addItem}>
        <h2>Bottle menu</h2>
        {menu.length === 0 && <div className="muted">No bottles yet. Guests see [Pre-order bottles] once the menu has one.</div>}
        {menu.map((i) => (
          <div key={i.id} className="spread wrap">
            <span>{i.name} <span className="faint">({i.nameTh})</span> · {baht(i.priceSatang)}{!i.active && <span className="faint"> · off the menu</span>}</span>
            <button type="button" className="btn small" onClick={() => void toggle(i)}>{i.active ? 'Take off' : 'Put back'}</button>
          </div>
        ))}
        <div className="row wrap">
          <div className="field" style={{ flex: '2 1 160px' }}>
            <label htmlFor="m-name">Name (English)</label>
            <input id="m-name" className="input" value={name} onChange={(e) => setName(e.target.value)} required />
          </div>
          <div className="field" style={{ flex: '2 1 160px' }}>
            <label htmlFor="m-name-th">Name (Thai)</label>
            <input id="m-name-th" className="input" value={nameTh} onChange={(e) => setNameTh(e.target.value)} required />
          </div>
          <div className="field" style={{ flex: '1 1 100px' }}>
            <label htmlFor="m-price">Price ฿</label>
            <input id="m-price" className="input" type="number" min="0" step="1" value={price} onChange={(e) => setPrice(e.target.value)} required />
          </div>
        </div>
        <div className="row"><button className="btn primary" disabled={!name || !nameTh || !price}>Add bottle</button></div>
      </form>
    </div>
  );
}
