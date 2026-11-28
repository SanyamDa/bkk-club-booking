import liff from '@line/liff';
import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';

/**
 * Guest details form. Opens inside LINE (LIFF) from the "Enter my details" button,
 * or as a normal web page in development and the simulator.
 */

type Lang = 'en' | 'th';

interface BookingInfo {
  lang: Lang;
  club: { name: string; accentColor: string; rules: string[]; arrivalBy: string; liffId: string | null; requiredFields?: GuestField[] };
  booking: {
    ref: string;
    status: string;
    table: string;
    zone: string;
    night: string;
    pax: number;
    minPax: number;
    maxPax: number;
    minSpend: string;
    deposit: string | null;
    holdExpiresAt: string | null;
    holdUntil: string | null;
    detailsDone: boolean;
  };
  guest: { name: string; phone: string; nationality: string; birthDate?: string };
  detailsSentText: string;
}

/** Fields a club can require beyond name and phone (§5.2 step 4). */
type GuestField = 'nationality' | 'birthDate' | 'occasion';

const L = {
  en: {
    title: 'Your details',
    heldUntil: 'Table held until',
    table: 'Table', night: 'Night', minSpend: 'Minimum spend', deposit: 'Deposit', none: 'None',
    name: 'Name', phone: 'Phone number', nationality: 'Nationality', guests: 'Number of guests',
    request: 'Special request (optional)', requestHint: 'Birthday, cake, anything we should know',
    birthDate: 'Date of birth', occasion: 'Occasion', occasionHint: 'Birthday, anniversary…', optional: '(optional)',
    rulesTitle: 'House rules', accept: 'I have read and accept the house rules',
    submit: 'Continue', sending: 'Sending…',
    doneTitle: 'Done', doneBody: 'Go back to the LINE chat to confirm your booking and pay the deposit.',
    expired: 'This hold has expired. Go back to the chat and tap “Book a table” to start again.',
    notFound: 'This link is no longer valid. Go back to the chat to continue.',
    alreadyDone: 'Your details are already saved. Go back to the chat to continue.',
    other: 'Other',
    wrongUser: 'This booking was started from a different LINE account. Open it from your own chat with the club.',
    linkExpired: 'This link has expired. Go back to the chat to get a new one.',
    notConfigured: 'This form is not available right now. Go back to the chat and ask to talk to a person.',
  },
  th: {
    title: 'ข้อมูลผู้จอง',
    heldUntil: 'จองโต๊ะไว้ถึง',
    table: 'โต๊ะ', night: 'คืน', minSpend: 'ยอดขั้นต่ำ', deposit: 'มัดจำ', none: 'ไม่มี',
    name: 'ชื่อ', phone: 'เบอร์โทรศัพท์', nationality: 'สัญชาติ', guests: 'จำนวนคน',
    request: 'คำขอพิเศษ (ไม่บังคับ)', requestHint: 'วันเกิด เค้ก หรืออื่นๆ ที่ควรทราบ',
    birthDate: 'วันเกิด', occasion: 'โอกาสพิเศษ', occasionHint: 'วันเกิด วันครบรอบ…', optional: '(ไม่บังคับ)',
    rulesTitle: 'กฎของร้าน', accept: 'ฉันได้อ่านและยอมรับกฎของร้านแล้ว',
    submit: 'ดำเนินการต่อ', sending: 'กำลังส่ง…',
    doneTitle: 'เรียบร้อย', doneBody: 'กลับไปที่แชท LINE เพื่อยืนยันการจองและชำระมัดจำค่ะ',
    expired: 'การจองนี้หมดเวลาแล้ว กลับไปที่แชทแล้วกด “จองโต๊ะ” เพื่อเริ่มใหม่ค่ะ',
    notFound: 'ลิงก์นี้ใช้ไม่ได้แล้ว กรุณากลับไปที่แชทค่ะ',
    alreadyDone: 'บันทึกข้อมูลแล้ว กรุณากลับไปที่แชทค่ะ',
    other: 'อื่นๆ',
    wrongUser: 'การจองนี้เริ่มจากบัญชี LINE อื่น กรุณาเปิดจากแชทของคุณกับร้านค่ะ',
    linkExpired: 'ลิงก์นี้หมดอายุแล้ว กรุณากลับไปที่แชทเพื่อรับลิงก์ใหม่ค่ะ',
    notConfigured: 'แบบฟอร์มนี้ยังใช้ไม่ได้ในตอนนี้ กรุณากลับไปที่แชทและขอคุยกับพนักงานค่ะ',
  },
} as const;

const NATIONALITIES = ['Thai', 'Chinese', 'Japanese', 'Korean', 'Indian', 'Singaporean', 'Malaysian', 'Australian', 'British', 'American', 'European', 'Russian', 'Middle Eastern'];

/** Query params arrive directly (web link) or wrapped in liff.state (LIFF URL). */
function readParams(): URLSearchParams {
  const here = new URLSearchParams(window.location.search);
  if (here.get('ref')) return here;
  const state = here.get('liff.state');
  if (state) {
    const q = state.includes('?') ? state.slice(state.indexOf('?') + 1) : state;
    return new URLSearchParams(q);
  }
  return here;
}

/** What `GET /api/liff/club` returns before the page has an ID token (plan B5). */
interface ClubInfo {
  name: string;
  accentColor: string;
  liffId: string | null;
}

/** The booking read, with the LIFF ID token in the X-Line-Id-Token header when we have one. */
async function readBooking(ref: string, token: string, idToken: string | undefined): Promise<BookingInfo> {
  const res = await fetch(`/api/liff/booking?ref=${encodeURIComponent(ref)}&t=${encodeURIComponent(token)}`, {
    headers: idToken ? { 'X-Line-Id-Token': idToken } : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(res.status, data);
  return data as BookingInfo;
}

export function Details() {
  const params = useMemo(readParams, []);
  const ref = params.get('ref') ?? '';
  const token = params.get('t') ?? '';
  const clubSlug = params.get('club') ?? '';
  const [info, setInfo] = useState<BookingInfo | null>(null);
  const [inLine, setInLine] = useState(false);
  const [liffReady, setLiffReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [form, setForm] = useState({ name: '', phone: '', nationality: '', otherNationality: '', pax: 2, specialRequest: '', birthDate: '', occasion: '', acceptRules: false });
  const [state, setState] = useState<'loading' | 'form' | 'sending' | 'done' | 'gone'>('loading');

  useEffect(() => {
    (async () => {
      try {
        // B5: the booking read needs the guest's ID token, so start LIFF first from the
        // unauthenticated club lookup (only name, accent colour and LIFF id).
        let idToken: string | undefined;
        const club = clubSlug ? await api<ClubInfo>(`/api/liff/club?club=${encodeURIComponent(clubSlug)}`).catch(() => null) : null;
        if (club) document.documentElement.style.setProperty('--accent', club.accentColor);
        if (club?.liffId) {
          try {
            await liff.init({ liffId: club.liffId });
            if (!liff.isLoggedIn()) {
              // Opened outside the LINE app: log in so we can prove who is reading and submitting.
              liff.login({ redirectUri: window.location.href });
              return;
            }
            idToken = liff.getIDToken() ?? undefined;
            setLiffReady(true);
            setInLine(liff.isInClient());
          } catch {
            setInLine(false);
          }
        }
        const data = await readBooking(ref, token, idToken);
        setInfo(data);
        document.documentElement.lang = data.lang;
        document.documentElement.style.setProperty('--accent', data.club.accentColor);
        const nat = data.guest.nationality;
        setForm((f) => ({
          ...f,
          name: data.guest.name,
          phone: data.guest.phone,
          nationality: !nat ? '' : NATIONALITIES.includes(nat) ? nat : 'Other',
          otherNationality: nat && !NATIONALITIES.includes(nat) ? nat : '',
          birthDate: data.guest.birthDate ?? '',
          pax: Math.min(Math.max(data.booking.pax, data.booking.minPax), data.booking.maxPax),
        }));
        setState(data.booking.status !== 'held' || data.booking.detailsDone ? 'gone' : 'form');
      } catch (err) {
        setState('gone');
        const code = err instanceof ApiError ? err.body.error : undefined;
        setError(
          code === 'link_expired' ? 'linkExpired'
            : code === 'wrong_user' || code === 'login_required' ? 'wrongUser'
              : code === 'login_not_configured' ? 'notConfigured'
                : 'notFound',
        );
      }
    })();
  }, [ref, token, clubSlug]);

  if (!info && state === 'loading') return <div className="guest muted">…</div>;
  const lang: Lang = info?.lang ?? 'en';
  const s = L[lang];

  if (!info || state === 'gone') {
    const msg =
      error === 'linkExpired' ? s.linkExpired
        : error === 'wrongUser' ? s.wrongUser
          : error === 'notConfigured' ? s.notConfigured
            : error === 'notFound' || !info ? s.notFound
              : info.booking.detailsDone ? s.alreadyDone : s.expired;
    return (
      <div className="guest stack">
        <h1>{info?.club.name ?? ''}</h1>
        <p className="muted">{msg}</p>
        {inLine && <button className="btn block" onClick={() => liff.closeWindow()}>OK</button>}
      </div>
    );
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!info) return;
    setFieldErrors({});
    setError(null);
    setState('sending');
    const viaChat = inLine && liff.isApiAvailable('sendMessages');
    const nationality = form.nationality === 'Other' ? form.otherNationality : form.nationality;
    try {
      const idToken = liffReady ? liff.getIDToken() ?? undefined : undefined;
      await api('/api/liff/booking/details', {
        body: { ref, t: token, name: form.name, phone: form.phone, nationality, pax: form.pax, specialRequest: form.specialRequest, birthDate: form.birthDate, occasion: form.occasion, acceptRules: form.acceptRules, viaChat, idToken },
      });
      if (viaChat) {
        try {
          // Sent from the guest's own chat, so the bot can answer with a free reply.
          await liff.sendMessages([{ type: 'text', text: info.detailsSentText }]);
        } catch {
          await api('/api/liff/booking/review', { body: { ref, t: token, idToken } });
        }
        liff.closeWindow();
      }
      setState('done');
    } catch (err) {
      setState('form');
      if (err instanceof ApiError && err.body.issues) {
        setFieldErrors(Object.fromEntries(err.body.issues.map((i) => [i.field ?? '', i.message])));
      } else if (err instanceof ApiError && (err.body.error === 'hold_expired' || err.body.error === 'invalid_state' || err.body.error === 'link_expired')) {
        setState('gone');
      } else if (err instanceof ApiError && (err.body.error === 'wrong_user' || err.body.error === 'login_required')) {
        setError(s.wrongUser);
      } else {
        setError(err instanceof Error ? err.message : 'Something went wrong');
      }
    }
  }

  const b = info.booking;
  if (state === 'done') {
    return (
      <div className="guest stack">
        <h1>{s.doneTitle}</h1>
        <p className="muted">{s.doneBody}</p>
        {inLine && <button className="btn block primary" onClick={() => liff.closeWindow()}>OK</button>}
      </div>
    );
  }

  const paxOptions = Array.from({ length: b.maxPax - b.minPax + 1 }, (_, i) => b.minPax + i);
  const required = new Set<GuestField>(info.club.requiredFields ?? ['nationality']);
  const nationalityValue = form.nationality === 'Other' ? form.otherNationality : form.nationality;
  const missingRequired = (required.has('nationality') && !nationalityValue) || (required.has('birthDate') && !form.birthDate) || (required.has('occasion') && !form.occasion.trim());
  const opt = (f: GuestField) => (required.has(f) ? '' : ` ${s.optional}`);

  return (
    <form className="guest stack" onSubmit={submit} noValidate>
      <div className="stack" style={{ gap: 4 }}>
        <div className="faint">{info.club.name}</div>
        <h1>{s.title}</h1>
        {b.holdUntil && <div className="faint">{s.heldUntil} {b.holdUntil}</div>}
      </div>

      <div className="card">
        <dl className="summary" style={{ margin: 0 }}>
          <dt>{s.table}</dt><dd>{b.table} · {b.zone}</dd>
          <dt>{s.night}</dt><dd>{b.night}</dd>
          <dt>{s.minSpend}</dt><dd>{b.minSpend}</dd>
          <dt>{s.deposit}</dt><dd>{b.deposit ?? s.none}</dd>
        </dl>
      </div>

      <div className="field">
        <label htmlFor="name">{s.name}</label>
        <input id="name" className="input" autoComplete="name" required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
        {fieldErrors.name && <span className="error">{fieldErrors.name}</span>}
      </div>
      <div className="field">
        <label htmlFor="phone">{s.phone}</label>
        <input id="phone" className="input" type="tel" inputMode="tel" autoComplete="tel" required placeholder="08x xxx xxxx" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} />
        {fieldErrors.phone && <span className="error">{fieldErrors.phone}</span>}
      </div>
      <div className="field">
        <label htmlFor="nat">{s.nationality}{opt('nationality')}</label>
        <select id="nat" className="input" required={required.has('nationality')} value={form.nationality} onChange={(e) => setForm({ ...form, nationality: e.target.value })}>
          <option value="" disabled={required.has('nationality')}>—</option>
          {NATIONALITIES.map((n) => <option key={n} value={n}>{n}</option>)}
          <option value="Other">{s.other}</option>
        </select>
        {form.nationality === 'Other' && (
          <input className="input" aria-label={s.nationality} value={form.otherNationality} onChange={(e) => setForm({ ...form, otherNationality: e.target.value })} />
        )}
        {fieldErrors.nationality && <span className="error">{fieldErrors.nationality}</span>}
      </div>
      <div className="field">
        <label htmlFor="pax">{s.guests}</label>
        <select id="pax" className="input" value={form.pax} onChange={(e) => setForm({ ...form, pax: Number(e.target.value) })}>
          {paxOptions.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
        {fieldErrors.pax && <span className="error">{fieldErrors.pax}</span>}
      </div>
      <div className="field">
        <label htmlFor="dob">{s.birthDate}{opt('birthDate')}</label>
        <input id="dob" className="input" type="date" autoComplete="bday" required={required.has('birthDate')} value={form.birthDate} onChange={(e) => setForm({ ...form, birthDate: e.target.value })} />
        {fieldErrors.birthDate && <span className="error">{fieldErrors.birthDate}</span>}
      </div>
      <div className="field">
        <label htmlFor="occ">{s.occasion}{opt('occasion')}</label>
        <input id="occ" className="input" maxLength={60} placeholder={s.occasionHint} required={required.has('occasion')} value={form.occasion} onChange={(e) => setForm({ ...form, occasion: e.target.value })} />
        {fieldErrors.occasion && <span className="error">{fieldErrors.occasion}</span>}
      </div>
      <div className="field">
        <label htmlFor="req">{s.request}</label>
        <textarea id="req" className="input" rows={2} maxLength={200} placeholder={s.requestHint} value={form.specialRequest} onChange={(e) => setForm({ ...form, specialRequest: e.target.value })} />
      </div>

      <div className="card stack" style={{ gap: 10 }}>
        <h2>{s.rulesTitle}</h2>
        <ul className="rules">{info.club.rules.map((r) => <li key={r}>{r}</li>)}</ul>
        <label className="check">
          <input type="checkbox" checked={form.acceptRules} onChange={(e) => setForm({ ...form, acceptRules: e.target.checked })} />
          <span>{s.accept}</span>
        </label>
        {fieldErrors.acceptRules && <span className="error">{fieldErrors.acceptRules}</span>}
      </div>

      {error && <div className="error">{error}</div>}
      <button className="btn block primary" type="submit" disabled={state === 'sending' || !form.acceptRules || !form.name || !form.phone || missingRequired}>
        {state === 'sending' ? s.sending : s.submit}
      </button>
    </form>
  );
}
