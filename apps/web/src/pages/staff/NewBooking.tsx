import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, staffPath } from '../../api';
import { useStaff } from './Layout';

interface TableRow { id: string; code: string; zone: string; minPax: number; maxPax: number; minSpend: string; deposit: string; booking: unknown }

/** Phone, walk-in, promoter and VIP bookings. Blocks the table exactly like a LINE booking. */
export function NewBooking() {
  const { club } = useStaff();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [date, setDate] = useState(params.get('date') ?? '');
  const [tables, setTables] = useState<TableRow[]>([]);
  const [form, setForm] = useState({ tableId: params.get('table') ?? '', pax: 4, name: '', phone: '', notes: '', depositPaid: false });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ date: string; tables: TableRow[] }>(staffPath(club, `/night${date ? `?date=${date}` : ''}`)).then((d) => {
      if (!date) setDate(d.date);
      setTables(d.tables);
    });
  }, [club, date]);

  const free = tables.filter((t) => !t.booking);
  const selected = tables.find((t) => t.id === form.tableId);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const res = await api<{ id: string }>(staffPath(club, '/bookings'), { body: { ...form, nightDate: date } });
      navigate(`/staff/bookings/${res.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not create the booking');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" style={{ maxWidth: 520 }} onSubmit={submit}>
      <h1>Manual booking</h1>
      <p className="faint" style={{ margin: 0 }}>For phone calls, walk-ins, promoters and VIPs. It is confirmed immediately.</p>
      <div className="field">
        <label htmlFor="date">Night</label>
        <input id="date" className="input" type="date" value={date} onChange={(e) => { setDate(e.target.value); setForm({ ...form, tableId: '' }); }} />
      </div>
      <div className="field">
        <label htmlFor="table">Table ({free.length} free)</label>
        <select id="table" className="input" required value={form.tableId} onChange={(e) => setForm({ ...form, tableId: e.target.value })}>
          <option value="" disabled>Choose a free table</option>
          {free.map((t) => <option key={t.id} value={t.id}>{t.code} · {t.zone} · {t.minPax}–{t.maxPax} pax · min {t.minSpend}</option>)}
        </select>
      </div>
      <div className="field">
        <label htmlFor="pax">Guests</label>
        <input id="pax" className="input" type="number" min={1} max={50} value={form.pax} onChange={(e) => setForm({ ...form, pax: Number(e.target.value) })} />
      </div>
      <div className="field">
        <label htmlFor="name">Guest name</label>
        <input id="name" className="input" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="phone">Phone (optional)</label>
        <input id="phone" className="input" type="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
      </div>
      <div className="field">
        <label htmlFor="notes">Notes (promoter, VIP, special requests)</label>
        <textarea id="notes" className="input" rows={2} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} />
      </div>
      <label className="check">
        <input type="checkbox" checked={form.depositPaid} onChange={(e) => setForm({ ...form, depositPaid: e.target.checked })} />
        <span>Deposit already paid{selected ? ` (${selected.deposit})` : ''}</span>
      </label>
      {error && <div className="error">{error}</div>}
      <button className="btn primary block" disabled={busy || !form.tableId || !form.name || !date}>Create booking</button>
    </form>
  );
}
