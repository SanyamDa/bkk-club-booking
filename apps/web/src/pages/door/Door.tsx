import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, ApiError, staffPath } from '../../api';

/**
 * Door mode (plan B11, spec §6.2 Door, §14.3): QR scan or name search, one tap to check in with the
 * actual party size, and the door clicker by guest type. Full screen, dark, large targets.
 * The camera scan uses the browser's BarcodeDetector where the phone has one; otherwise the search box.
 */

type Kind = 'table_guest' | 'guestlist' | 'walk_in' | 'ticket';
const KINDS: Kind[] = ['table_guest', 'guestlist', 'walk_in', 'ticket'];
interface Counts { byKind: Record<Kind, number>; total: number }
interface Arrival {
  id: string;
  ref: string;
  status: 'confirmed' | 'arrived' | 'no_show';
  guestName: string;
  table: string;
  zone: string;
  pax: number;
  arrivedPax: number | null;
  notes: string | null;
}

type Lang = 'en' | 'th';
const T = {
  door: { en: 'Door', th: 'หน้าประตู' },
  inside: { en: 'Inside', th: 'ในร้าน' },
  scan: { en: 'Scan QR', th: 'สแกน QR' },
  stopScan: { en: 'Stop camera', th: 'ปิดกล้อง' },
  noCamera: { en: 'This phone cannot scan here. Type the booking ref or name.', th: 'เครื่องนี้สแกนไม่ได้ พิมพ์รหัสการจองหรือชื่อแทน' },
  search: { en: 'Booking ref, name or phone', th: 'รหัสการจอง ชื่อ หรือเบอร์โทร' },
  noMatch: { en: 'No booking tonight matches', th: 'ไม่พบการจองคืนนี้' },
  checkIn: { en: 'Check in', th: 'เช็คอิน' },
  arrived: { en: 'Checked in', th: 'เช็คอินแล้ว' },
  noShow: { en: 'No-show', th: 'ไม่มา' },
  partySize: { en: 'Party at the door', th: 'จำนวนคนที่มา' },
  booked: { en: 'booked', th: 'จองไว้' },
  tonight: { en: 'Tonight', th: 'คืนนี้' },
  clicker: { en: 'Clicker', th: 'นับคน' },
  table_guest: { en: 'Table guest', th: 'แขกโต๊ะ' },
  guestlist: { en: 'Guestlist', th: 'เกสต์ลิสต์' },
  walk_in: { en: 'Walk-in', th: 'วอล์กอิน' },
  ticket: { en: 'Ticket', th: 'บัตร' },
  wrong_night: { en: 'This booking is for another night', th: 'การจองนี้เป็นของคืนอื่น' },
  below_zero: { en: 'Already 0', th: 'เป็น 0 แล้ว' },
  invalid_state: { en: 'Cannot check in this booking', th: 'เช็คอินการจองนี้ไม่ได้' },
  staffView: { en: 'Dashboard', th: 'แดชบอร์ด' },
} satisfies Record<string, Record<Lang, string>>;

interface Detector { detect(src: CanvasImageSource): Promise<{ rawValue: string }[]> }
type DetectorCtor = new (opts: { formats: string[] }) => Detector;
const BarcodeDetectorCtor = (globalThis as { BarcodeDetector?: DetectorCtor }).BarcodeDetector;

const clickId = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`);

export function Door() {
  const navigate = useNavigate();
  const [lang, setLang] = useState<Lang>(() => (localStorage.getItem('doorLang') === 'th' ? 'th' : 'en'));
  const t = (k: keyof typeof T) => T[k][lang];
  const [club, setClub] = useState<string>('');
  const [isDoorOnly, setIsDoorOnly] = useState(true);
  const [nightDate, setNightDate] = useState('');
  const [arrivals, setArrivals] = useState<Arrival[]>([]);
  const [counts, setCounts] = useState<Counts | null>(null);
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Arrival[] | null>(null);
  const [picked, setPicked] = useState<Arrival | null>(null);
  const [pax, setPax] = useState(0);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [scanning, setScanning] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => localStorage.setItem('doorLang', lang), [lang]);

  useEffect(() => {
    api<{ clubs: { slug: string; role: string }[] }>('/api/auth/me')
      .then((d) => {
        const stored = localStorage.getItem('club');
        const c = d.clubs.find((x) => x.slug === stored) ?? d.clubs[0];
        if (!c) return navigate('/staff/login', { replace: true });
        setClub(c.slug);
        setIsDoorOnly(c.role === 'door');
      })
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) navigate('/staff/login', { replace: true });
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const load = useCallback(() => {
    if (!club) return;
    api<{ nightDate: string; arrivals: Arrival[]; counts: Counts }>(staffPath(club, '/door'))
      .then((d) => {
        setNightDate(d.nightDate);
        setArrivals(d.arrivals);
        setCounts(d.counts);
      })
      .catch(() => {});
  }, [club]);

  useEffect(() => {
    load();
    const id = setInterval(load, 15_000);
    return () => clearInterval(id);
  }, [load]);

  const flash = (text: string, ok: boolean) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3000);
  };
  const errText = (err: unknown) => {
    const code = err instanceof ApiError ? err.body.error : undefined;
    return code && code in T ? t(code as keyof typeof T) : err instanceof Error ? err.message : String(err);
  };

  const find = useCallback(
    async (query: string) => {
      if (!club || !query.trim()) return setResults(null);
      const d = await api<{ results: Arrival[] }>(staffPath(club, `/door/find?q=${encodeURIComponent(query.trim())}`));
      setResults(d.results);
      if (d.results.length === 1) pick(d.results[0]!);
    },
    [club],
  );

  function pick(a: Arrival) {
    setPicked(a);
    setPax(a.arrivedPax ?? a.pax);
  }

  async function checkIn() {
    if (!picked) return;
    try {
      await api(staffPath(club, `/door/bookings/${picked.id}/check-in`), { body: { arrivedPax: pax } });
      flash(`${t('arrived')}: ${picked.guestName} · ${picked.table} · ${pax}`, true);
      setPicked(null);
      setResults(null);
      setQ('');
      load();
    } catch (err) {
      flash(errText(err), false);
    }
  }

  async function count(kind: Kind, delta: 1 | -1) {
    try {
      const d = await api<{ counts: Counts }>(staffPath(club, '/door/count'), { body: { kind, delta, clickId: clickId() } });
      setCounts(d.counts);
    } catch (err) {
      flash(errText(err), false);
    }
  }

  // Camera QR scan: the pass QR holds the booking ref.
  useEffect(() => {
    if (!scanning || !BarcodeDetectorCtor) return;
    let stream: MediaStream | null = null;
    let timer: ReturnType<typeof setInterval> | undefined;
    let stopped = false;
    const detector = new BarcodeDetectorCtor({ formats: ['qr_code'] });
    navigator.mediaDevices
      .getUserMedia({ video: { facingMode: 'environment' } })
      .then((s) => {
        if (stopped) return s.getTracks().forEach((tr) => tr.stop());
        stream = s;
        const v = videoRef.current!;
        v.srcObject = s;
        void v.play();
        timer = setInterval(async () => {
          if (v.readyState < 2) return;
          const codes = await detector.detect(v).catch(() => []);
          const ref = codes[0]?.rawValue?.trim();
          if (ref) {
            setScanning(false);
            setQ(ref);
            void find(ref);
          }
        }, 300);
      })
      .catch(() => {
        setScanning(false);
        flash(t('noCamera'), false);
      });
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      stream?.getTracks().forEach((tr) => tr.stop());
    };
  }, [scanning]); // eslint-disable-line react-hooks/exhaustive-deps

  const inside = arrivals.filter((a) => a.status === 'arrived');
  const expected = arrivals.filter((a) => a.status === 'confirmed');

  return (
    <div className="door">
      <header className="door-top">
        <div>
          <div className="door-title">{t('door')}</div>
          <div className="muted">{t('tonight')} {nightDate}</div>
        </div>
        <div className="door-inside" aria-live="polite">
          <span className="faint">{t('inside')}</span>
          <strong>{counts?.total ?? 0}</strong>
        </div>
        <div className="row">
          <button className="btn" onClick={() => setLang(lang === 'en' ? 'th' : 'en')} aria-label="Language">{lang === 'en' ? 'ไทย' : 'EN'}</button>
          {!isDoorOnly && <button className="btn" onClick={() => navigate('/staff')}>{t('staffView')}</button>}
        </div>
      </header>

      {msg && <div className={`door-msg ${msg.ok ? 'ok' : 'bad'}`} role="status">{msg.text}</div>}

      <section className="door-card stack">
        {BarcodeDetectorCtor ? (
          <button className="door-btn primary" onClick={() => setScanning(!scanning)}>{scanning ? t('stopScan') : t('scan')}</button>
        ) : (
          <div className="faint">{t('noCamera')}</div>
        )}
        {scanning && <video ref={videoRef} className="door-video" muted playsInline />}
        <form
          className="row"
          onSubmit={(e) => {
            e.preventDefault();
            void find(q);
          }}
        >
          <input className="input door-input" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search')} aria-label={t('search')} autoComplete="off" />
          <button className="door-btn" type="submit" aria-label={t('search')}>⌕</button>
        </form>
        {results && results.length === 0 && <div className="muted">{t('noMatch')}</div>}
        {results && results.length > 1 && (
          <div className="stack">
            {results.map((a) => (
              <button key={a.id} className="door-btn left" onClick={() => pick(a)}>
                <strong>{a.guestName}</strong> · {a.table} · {a.pax} · <span className="mono">{a.ref}</span>
              </button>
            ))}
          </div>
        )}
      </section>

      {picked && (
        <section className="door-card stack" aria-label={picked.guestName}>
          <div className="door-guest">{picked.guestName}</div>
          <div className="door-table">{picked.table} <span className="muted">{picked.zone}</span></div>
          <div className="muted">{picked.pax} {t('booked')} · <span className="mono">{picked.ref}</span></div>
          {picked.notes && <div className="door-notes">{picked.notes}</div>}
          {picked.status === 'confirmed' ? (
            <>
              <div className="faint">{t('partySize')}</div>
              <div className="door-stepper">
                <button className="door-btn" onClick={() => setPax(Math.max(0, pax - 1))} aria-label="−1">−</button>
                <strong>{pax}</strong>
                <button className="door-btn" onClick={() => setPax(Math.min(200, pax + 1))} aria-label="+1">+</button>
              </div>
              <button className="door-btn primary" onClick={checkIn}>{t('checkIn')}</button>
            </>
          ) : (
            <div className="door-msg bad">{picked.status === 'arrived' ? `${t('arrived')} (${picked.arrivedPax ?? picked.pax})` : t('noShow')}</div>
          )}
        </section>
      )}

      <section className="door-card stack">
        <div className="door-section">{t('clicker')}</div>
        {KINDS.map((k) => (
          <div key={k} className="door-kind">
            <button className="door-btn" onClick={() => count(k, -1)} aria-label={`${t(k)} −1`}>−</button>
            <div className="door-kind-label">
              <span>{t(k)}</span>
              <strong>{counts?.byKind[k] ?? 0}</strong>
            </div>
            <button className="door-btn primary" onClick={() => count(k, 1)} aria-label={`${t(k)} +1`}>+</button>
          </div>
        ))}
      </section>

      <section className="door-card stack">
        <div className="door-section">{t('tonight')} · {inside.length}/{inside.length + expected.length}</div>
        {[...expected, ...inside].map((a) => (
          <button key={a.id} className="door-btn left" onClick={() => pick(a)}>
            <strong>{a.table}</strong> · {a.guestName} · {a.arrivedPax ?? a.pax}
            {a.status === 'arrived' && <span className="chip s-arrived" style={{ marginLeft: 8 }}>{t('arrived')}</span>}
          </button>
        ))}
      </section>
    </div>
  );
}
