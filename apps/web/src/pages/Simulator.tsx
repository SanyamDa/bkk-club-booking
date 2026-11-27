import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { adminApi, api, ApiError, type AdminClub } from '../api';
import { FlexRender, type LineAction } from '../components/FlexRender';
import { describe } from './staff/MessageThread';

/**
 * Chat simulator (B8, spec §12.3): talk to the real bot as if you were a guest in LINE, at any club.
 * Platform admins only: the page calls `/api/admin/sim`, which needs an admin session, so it sends
 * anyone signed out to the login page and shows a refusal to everyone else. Events go through
 * exactly the same code path as LINE webhooks; nothing is sent to LINE, and every simulator guest
 * is test data.
 */

interface Msg { id: string; direction: 'in' | 'out'; kind: string; payload: any; at: string }

const GUESTS = [
  { id: 'guest-a', name: 'Ari' },
  { id: 'guest-b', name: 'Mint' },
  { id: 'guest-c', name: 'James' },
];

const SIM = (club: string) => `/api/admin/sim/${encodeURIComponent(club)}`;

export function Simulator() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const club = params.get('club') || 'demo';
  const [auth, setAuth] = useState<'loading' | 'ok' | 'forbidden'>('loading');
  const [clubs, setClubs] = useState<AdminClub[]>([]);
  const [guest, setGuest] = useState(GUESTS[0]!);
  const [lang, setLang] = useState<'en' | 'th'>('en');
  const [messages, setMessages] = useState<Msg[]>([]);
  const [alerts, setAlerts] = useState<Msg[]>([]);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [datePicker, setDatePicker] = useState<LineAction | null>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    adminApi
      .me()
      .then((d) => {
        if (d.user.platformRole !== 'admin') return setAuth('forbidden');
        setAuth('ok');
        adminApi.clubs().then((r) => setClubs(r.clubs)).catch(() => setClubs([]));
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) navigate(`/staff/login?next=${encodeURIComponent('/dev/simulator')}`, { replace: true });
        else setAuth('forbidden');
      });
  }, [navigate]);

  const load = useCallback(async () => {
    const d = await api<{ messages: Msg[]; staffAlerts: Msg[] }>(`${SIM(club)}/transcript?userId=${guest.id}`);
    setMessages(d.messages);
    setAlerts(d.staffAlerts);
  }, [club, guest.id]);

  useEffect(() => {
    if (auth !== 'ok') return;
    void load();
    const id = setInterval(load, 1500);
    return () => clearInterval(id);
  }, [load, auth]);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length]);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    try {
      await api(`${SIM(club)}/event`, { body: { userId: guest.id, displayName: guest.name, lang, ...body } });
      await load();
    } finally {
      setBusy(false);
    }
  }

  function onAction(a: LineAction) {
    if (a.type === 'postback') void send({ type: 'postback', data: a.data });
    else if (a.type === 'uri' && a.uri) window.open(a.uri, '_blank', 'noopener');
    else if (a.type === 'datetimepicker') setDatePicker(a);
  }

  async function sendImage(file: File) {
    const buf = new Uint8Array(await file.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    await send({ type: 'image', imageBase64: btoa(bin) });
  }

  const lastOut = [...messages].reverse().find((m) => m.direction === 'out');
  const quick: LineAction[] = lastOut?.payload?.quickReply?.items?.map((i: any) => i.action) ?? [];

  const clubName = clubs.find((c) => c.slug === club)?.name ?? (club === 'demo' ? 'Velora (Demo)' : club);

  if (auth === 'loading') return <div className="staff"><p className="faint" style={{ padding: 16 }}>Loading… / กำลังโหลด…</p></div>;
  if (auth === 'forbidden') {
    return (
      <div className="staff">
        <div className="card" style={{ margin: 16 }}>
          <h2>Platform admins only</h2>
          <p>The chat simulator needs a platform-admin login. / เครื่องจำลองแชทใช้ได้เฉพาะผู้ดูแลแพลตฟอร์ม</p>
        </div>
      </div>
    );
  }

  return (
    <div className="staff">
      <header className="topbar">
        <div>
          <div className="brand">Chat simulator <span>·</span> {clubName}</div>
          <div className="faint">Runs the real bot. Nothing is sent to LINE; every simulator guest is test data.</div>
        </div>
        <div className="row wrap">
          <select className="input" style={{ width: 'auto', minHeight: 34 }} value={club} onChange={(e) => setParams({ club: e.target.value })} aria-label="Club">
            {!clubs.some((c) => c.slug === club) && <option value={club}>Club: {clubName}</option>}
            {clubs.map((c) => <option key={c.slug} value={c.slug}>Club: {c.name} ({c.status})</option>)}
          </select>
          <select className="input" style={{ width: 'auto', minHeight: 34 }} value={guest.id} onChange={(e) => setGuest(GUESTS.find((g) => g.id === e.target.value)!)} aria-label="Simulated guest">
            {GUESTS.map((g) => <option key={g.id} value={g.id}>Guest: {g.name}</option>)}
          </select>
          <select className="input" style={{ width: 'auto', minHeight: 34 }} value={lang} onChange={(e) => setLang(e.target.value as 'en' | 'th')} aria-label="LINE language">
            <option value="en">LINE in English</option>
            <option value="th">LINE in Thai</option>
          </select>
          <a className="btn small" href="/staff" target="_blank" rel="noreferrer">Open staff dashboard ↗</a>
        </div>
      </header>

      <div className="split">
        <div className="main" style={{ maxWidth: 460 }}>
          <div style={{ border: '1px solid var(--line)', borderRadius: 28, overflow: 'hidden', background: '#8aa1c1' }}>
            <div style={{ background: '#1f2a37', color: '#fff', padding: '14px 16px', fontWeight: 600 }}>{clubName}</div>
            <div style={{ height: 560, overflowY: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, background: '#7c93b3' }}>
              {messages.length === 0 && (
                <div style={{ textAlign: 'center', color: '#fff', marginTop: 40 }}>
                  <p>Start like a real guest would.</p>
                  <button className="btn primary" onClick={() => send({ type: 'follow' })}>Add friend</button>
                </div>
              )}
              {messages.map((m) => {
                const mine = m.direction === 'in';
                const p = m.payload;
                return (
                  <div key={m.id} style={{ display: 'flex', justifyContent: mine ? 'flex-end' : 'flex-start', maxWidth: '100%' }}>
                    {!mine && p.type === 'flex' ? (
                      <FlexRender contents={p.contents} onAction={onAction} />
                    ) : !mine && p.type === 'image' ? (
                      <img src={p.originalContentUrl} alt="PromptPay QR" style={{ width: 200, borderRadius: 12, background: '#fff' }} />
                    ) : (
                      <div style={{ maxWidth: '78%', padding: '8px 12px', borderRadius: 16, whiteSpace: 'pre-wrap', fontSize: 14, background: mine ? '#06c755' : '#fff', color: '#111', fontStyle: mine && m.kind !== 'text' ? 'italic' : undefined, opacity: mine && m.kind !== 'text' ? 0.85 : 1 }}>
                        {describe(m)}
                      </div>
                    )}
                  </div>
                );
              })}
              <div ref={endRef} />
            </div>
            {quick.length > 0 && (
              <div style={{ display: 'flex', gap: 6, overflowX: 'auto', padding: '8px 10px', background: '#eef1f5' }}>
                {quick.map((a, i) => (
                  <button key={i} className="btn small" style={{ background: '#fff', color: '#111', borderColor: '#cfd6df', borderRadius: 16, flex: 'none' }} onClick={() => onAction(a)}>
                    {a.label}
                  </button>
                ))}
              </div>
            )}
            {datePicker && (
              <div className="row" style={{ padding: 10, background: '#eef1f5' }}>
                <input type="date" className="input" style={{ color: '#111', background: '#fff' }} defaultValue={datePicker.initial} min={datePicker.min} max={datePicker.max} id="sim-date" aria-label="Pick a date" />
                <button className="btn small primary" onClick={() => { const v = (document.getElementById('sim-date') as HTMLInputElement).value; setDatePicker(null); void send({ type: 'postback', data: datePicker.data, date: v }); }}>OK</button>
              </div>
            )}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 1, background: '#d5dbe3' }}>
              {[['Book a table', 'a=book'], ['My booking', 'a=my'], ['Talk to a host', 'a=host']].map(([label, data]) => (
                <button key={data} onClick={() => send({ type: 'postback', data })} style={{ minHeight: 48, border: 0, background: '#fff', color: '#111', fontWeight: 500, cursor: 'pointer' }}>{label}</button>
              ))}
            </div>
            <form className="row" style={{ padding: 10, background: '#fff' }} onSubmit={(e) => { e.preventDefault(); if (text.trim()) { void send({ type: 'text', text }); setText(''); } }}>
              <button type="button" className="btn small" style={{ background: '#eef1f5', color: '#111' }} onClick={() => fileRef.current?.click()} aria-label="Send an image (slip)">📷</button>
              <input ref={fileRef} type="file" accept="image/jpeg,image/png" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void sendImage(f); e.target.value = ''; }} />
              <input className="input" style={{ background: '#eef1f5', color: '#111', borderColor: '#d5dbe3' }} placeholder="Type like a guest… e.g. โต๊ะ 6 คน ศุกร์นี้" value={text} onChange={(e) => setText(e.target.value)} aria-label="Message" />
              <button className="btn small primary" disabled={busy || !text.trim()}>Send</button>
            </form>
          </div>
        </div>

        <div className="side stack">
          <div className="card stack">
            <h2>Staff LINE group</h2>
            <p className="faint" style={{ margin: 0 }}>Alerts the club’s staff group would receive.</p>
            {alerts.length === 0 ? <p className="faint">None yet.</p> : alerts.map((a) => (
              <div key={a.id} className="bubble out" style={{ maxWidth: '100%' }}>{a.payload?.text}</div>
            ))}
          </div>
          <div className="card stack">
            <h2>Try this</h2>
            <ol className="rules" style={{ fontSize: 14 }}>
              <li>Tap <b>Add friend</b>, then <b>Book a table</b>.</li>
              <li>Pick a night, party size and a table.</li>
              <li><b>Enter my details</b> opens the guest form in a new tab. Submit it and come back.</li>
              <li>Tap <b>Confirm & pay deposit</b>, then send any JPG/PNG with 📷 as the slip.</li>
              <li>Approve it in the staff dashboard. The confirmation appears here.</li>
              <li>Switch to guest Mint and try to take the same table.</li>
              <li>Type “talk to a person” and see the handoff in Chats.</li>
            </ol>
          </div>
        </div>
      </div>
    </div>
  );
}
