import { useEffect, useState } from 'react';
import { api } from '../api';

/**
 * The night's floor plan (spec §5.2 step 3): opened from [See floor plan] on the table cards.
 * Shows each placed table as free or taken. Public page: no guest data, only tables.
 */

interface FloorTable {
  code: string;
  zone: string;
  zoneTh: string;
  minPax: number;
  maxPax: number;
  x: number | null;
  y: number | null;
  shape: string | null;
  free: boolean;
}
interface FloorData {
  club: { name: string; accentColor: string };
  night: string;
  tables: FloorTable[];
}

export function FloorPlan() {
  const params = new URLSearchParams(window.location.search);
  const club = params.get('club') ?? '';
  const date = params.get('d') ?? '';
  const [data, setData] = useState<FloorData | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    api<FloorData>(`/api/liff/floor?club=${encodeURIComponent(club)}&d=${encodeURIComponent(date)}`)
      .then(setData)
      .catch(() => setError('This floor plan is not available. · ไม่พบผังร้าน'));
  }, [club, date]);

  if (error) return <div className="liff"><p className="muted">{error}</p></div>;
  if (!data) return <div className="liff"><p className="muted">Loading…</p></div>;
  const placed = data.tables.filter((t) => t.x !== null && t.y !== null);
  const unplaced = data.tables.filter((t) => t.x === null || t.y === null);
  const accent = data.club.accentColor;

  return (
    <div className="liff" style={{ padding: 16, maxWidth: 640, margin: '0 auto' }}>
      <h1 style={{ marginBottom: 4 }}>{data.club.name}</h1>
      <p className="faint" style={{ marginTop: 0 }}>{data.night} · floor plan · ผังร้าน</p>
      <div className="row faint" style={{ gap: 16, marginBottom: 8 }}>
        <span><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: accent }} /> Free · ว่าง</span>
        <span><span style={{ display: 'inline-block', width: 12, height: 12, borderRadius: 3, background: '#3a3840' }} /> Taken · ไม่ว่าง</span>
      </div>
      <div
        role="img"
        aria-label="Floor plan"
        style={{ position: 'relative', width: '100%', paddingTop: '75%', background: '#141316', borderRadius: 12, border: '1px solid #2a2826' }}
      >
        {placed.map((t) => (
          <div
            key={t.code}
            title={`${t.code} · ${t.zone} · ${t.minPax}–${t.maxPax}`}
            style={{
              position: 'absolute',
              left: `${(t.x ?? 0) * 100}%`,
              top: `${(t.y ?? 0) * 100}%`,
              transform: 'translate(-50%, -50%)',
              minWidth: 40,
              padding: '6px 8px',
              borderRadius: t.shape === 'round' ? 999 : 6,
              background: t.free ? accent : '#3a3840',
              color: t.free ? '#141008' : '#a8a39a',
              fontWeight: 600,
              fontSize: 13,
              textAlign: 'center',
            }}
          >
            {t.code}
          </div>
        ))}
      </div>
      {unplaced.length > 0 && (
        <p className="faint" style={{ marginTop: 12 }}>
          Also: {unplaced.map((t) => `${t.code} (${t.free ? 'free' : 'taken'})`).join(', ')}
        </p>
      )}
      <p className="faint" style={{ marginTop: 12 }}>Close this page and tap a table card in the chat to book. · ปิดหน้านี้แล้วเลือกโต๊ะในแชท</p>
    </div>
  );
}
