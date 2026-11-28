import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api, staffPath, Status, STATUS_LABEL } from '../../api';
import { useStaff } from './Layout';

interface Row {
  id: string; ref: string; status: string; source: string; nightDate: string; pax: number;
  table: string; zone: string; zoneId: string; promoterId: string | null; guestName: string; minSpend: string; deposit: string;
}

const SOURCES: [string, string][] = [['', 'Any source'], ['line', 'LINE'], ['instagram', 'Instagram'], ['manual_phone', 'Phone'], ['manual_walkin', 'Walk-in'], ['manual', 'Manual'], ['promoter', 'Promoter']];

/** §6.2 Bookings: search and filter by night, status, zone, promoter and source. */
export function Bookings() {
  const { club } = useStaff();
  const [f, setF] = useState({ night: '', status: '', zone: '', promoter: '', source: '', q: '' });
  const [rows, setRows] = useState<Row[]>([]);
  const [zones, setZones] = useState<{ id: string; name: string }[]>([]);
  const [error, setError] = useState('');

  useEffect(() => {
    api<{ zones: { id: string; name: string }[] }>(staffPath(club, '/tables')).then((d) => setZones(d.zones)).catch(() => setZones([]));
  }, [club]);
  useEffect(() => {
    const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString();
    api<{ bookings: Row[] }>(staffPath(club, `/bookings${qs ? `?${qs}` : ''}`))
      .then((d) => { setRows(d.bookings); setError(''); })
      .catch((e) => setError(String(e.message)));
  }, [club, f]);

  return (
    <div className="stack">
      <h1>Bookings</h1>
      <div className="row wrap">
        <input className="input" type="date" aria-label="Night" value={f.night} onChange={(e) => setF({ ...f, night: e.target.value })} />
        <select className="input" aria-label="Status" value={f.status} onChange={(e) => setF({ ...f, status: e.target.value })}>
          <option value="">Any status</option>
          {Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <select className="input" aria-label="Zone" value={f.zone} onChange={(e) => setF({ ...f, zone: e.target.value })}>
          <option value="">Any zone</option>
          {zones.map((z) => <option key={z.id} value={z.id}>{z.name}</option>)}
        </select>
        <select className="input" aria-label="Source" value={f.source} onChange={(e) => setF({ ...f, source: e.target.value })}>
          {SOURCES.map(([k, v]) => <option key={k} value={k}>{v}</option>)}
        </select>
        <input className="input" placeholder="Name, phone or ref" aria-label="Search" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} />
      </div>
      {error && <div className="error">{error}</div>}
      <div className="card stack">
        {rows.length === 0 && <div className="faint">No bookings match.</div>}
        {rows.map((b) => (
          <Link key={b.id} to={`/staff/bookings/${b.id}`} className="spread">
            <span>{b.nightDate} · {b.table} · {b.guestName} · {b.pax} pax <span className="faint mono">{b.ref}</span></span>
            <Status status={b.status} />
          </Link>
        ))}
      </div>
    </div>
  );
}
