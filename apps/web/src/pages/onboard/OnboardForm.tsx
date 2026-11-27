import { useEffect, useState, type FormEvent } from 'react';
import { useParams } from 'react-router-dom';
import { api, ApiError } from '../../api';

/**
 * Pre-call club form (plan A17, spec §12.2 "Before the call"). Public page at /onboard/:token;
 * the token in the link is the only credential. Answers are stored for the founder, who checks
 * and loads them into the club before the call.
 */

type Zone = { name: string; nameTh: string; minSpend: string; deposit: string; satMinSpend: string; satDeposit: string };
type Table = { code: string; zone: string; minPax: string; maxPax: string; minSpend: string; deposit: string };
type Faq = { question: string; answerEn: string; answerTh: string };

/** Template pack of standard nightclub questions (spec §8.2); the club fills the blanks. */
const FAQ_TEMPLATE = [
  'What is the dress code?',
  'What is the minimum age? Which ID is accepted?',
  'Is there parking? Valet?',
  'What are the opening hours?',
  'Is there an entry fee?',
  'Can we bring a cake or decorations?',
  'What happens to lost property?',
  'Do you keep bottles (bottle keep)? For how long?',
  'What is the cancellation policy?',
  'Can we bring our own drinks? Corkage?',
  'Is there a guest list?',
  'Do you take card payments?',
  'Is there a smoking area?',
  'Who is playing tonight / this week?',
  'Can we book for a birthday? Any package?',
  'Is there food?',
  'How late can we arrive with a booking?',
  'Can we change our table on the night?',
  'Is there a VIP room?',
  'Do you allow tourists with a passport copy?',
  'Is there a coat check?',
  'How do we get there (BTS / MRT)?',
  'Can we bring a photographer?',
  'Are shisha or vapes allowed?',
  'What is the deposit and how is it refunded?',
];

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const baht = (s: string) => Math.round((Number(s.replace(/[^\d.]/g, '')) || 0) * 100);
const fromSatang = (n: number | undefined) => (n == null ? '' : String(n / 100));
const lines = (s: string) => s.split('\n').map((l) => l.trim()).filter(Boolean);

const emptyZone = (): Zone => ({ name: '', nameTh: '', minSpend: '', deposit: '', satMinSpend: '', satDeposit: '' });
const emptyTable = (zone = ''): Table => ({ code: '', zone, minPax: '2', maxPax: '6', minSpend: '', deposit: '' });

export function OnboardForm() {
  const { token = '' } = useParams();
  const [clubName, setClubName] = useState('');
  const [loadError, setLoadError] = useState('');
  const [zones, setZones] = useState<Zone[]>([emptyZone()]);
  const [tables, setTables] = useState<Table[]>([emptyTable()]);
  const [openWeekdays, setOpenWeekdays] = useState<number[]>([3, 4, 5, 6]);
  const [arrivalBy, setArrivalBy] = useState('23:30');
  const [rulesEn, setRulesEn] = useState('');
  const [rulesTh, setRulesTh] = useState('');
  const [cancellation, setCancellation] = useState('');
  const [profile, setProfile] = useState({ capacityStanding: '', capacitySeated: '', district: '', venueType: '', genres: '', priceBand: '', usualPeakHour: '', licenceType: '', posVendor: '' });
  const [faqs, setFaqs] = useState<Faq[]>(FAQ_TEMPLATE.map((q) => ({ question: q, answerEn: '', answerTh: '' })));
  const [promptpayNote, setPromptpayNote] = useState('');
  const [contact, setContact] = useState({ name: '', lineAdmin: false, desktop: false, noOtherBot: false });
  const [error, setError] = useState('');
  const [savedAt, setSavedAt] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api<{ club: { name: string }; submission: { submittedAt: string; data: any } | null }>(`/api/onboard/${encodeURIComponent(token)}`)
      .then((r) => {
        setClubName(r.club.name);
        const d = r.submission?.data;
        if (!d) return;
        setSavedAt(r.submission!.submittedAt);
        setZones(d.zones.map((z: any) => {
          const sat = (z.weekdayPrices ?? []).find((w: any) => w.weekday === 6);
          return { name: z.name, nameTh: z.nameTh, minSpend: fromSatang(z.minSpendSatang), deposit: fromSatang(z.depositSatang), satMinSpend: fromSatang(sat?.minSpendSatang), satDeposit: fromSatang(sat?.depositSatang) };
        }));
        setTables(d.tables.map((t: any) => ({ code: t.code, zone: t.zone, minPax: String(t.minPax), maxPax: String(t.maxPax), minSpend: fromSatang(t.minSpendSatang), deposit: fromSatang(t.depositSatang) })));
        if (d.policies?.openWeekdays) setOpenWeekdays(d.policies.openWeekdays);
        if (d.policies?.arrivalBy) setArrivalBy(d.policies.arrivalBy);
        setRulesEn((d.policies?.rules?.en ?? []).join('\n'));
        setRulesTh((d.policies?.rules?.th ?? []).join('\n'));
        setCancellation(d.policies?.cancellationPolicy ?? '');
        const p = d.profile ?? {};
        setProfile({
          capacityStanding: p.capacityStanding?.toString() ?? '', capacitySeated: p.capacitySeated?.toString() ?? '', district: p.district ?? '', venueType: p.venueType ?? '',
          genres: (p.genres ?? []).join(', '), priceBand: p.priceBand ?? '', usualPeakHour: p.usualPeakHour?.toString() ?? '', licenceType: p.licenceType ?? '', posVendor: p.posVendor ?? '',
        });
        if (d.faqs?.length) setFaqs(d.faqs.map((f: any) => ({ question: f.question, answerEn: f.answerEn ?? '', answerTh: f.answerTh ?? '' })));
        setPromptpayNote(d.promptpayNote ?? '');
        if (d.contact) setContact({ name: d.contact.name ?? '', lineAdmin: Boolean(d.contact.lineAdmin), desktop: Boolean(d.contact.desktop), noOtherBot: Boolean(d.contact.noOtherBot) });
      })
      .catch((e) => setLoadError(e instanceof ApiError && e.status === 410 ? 'This club is already set up. The form is closed.' : 'This link is not valid or has expired. Ask us for a new one.'));
  }, [token]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    const int = (s: string) => (s.trim() === '' ? null : Number(s));
    const body = {
      zones: zones.filter((z) => z.name.trim()).map((z) => ({
        name: z.name.trim(), nameTh: z.nameTh.trim() || z.name.trim(), minSpendSatang: baht(z.minSpend), depositSatang: baht(z.deposit),
        ...(z.satMinSpend.trim() ? { weekdayPrices: [{ weekday: 6, minSpendSatang: baht(z.satMinSpend), depositSatang: baht(z.satDeposit) }] } : {}),
      })),
      tables: tables.filter((t) => t.code.trim()).map((t) => ({
        code: t.code.trim(), zone: t.zone, minPax: Number(t.minPax) || 1, maxPax: Number(t.maxPax) || 1,
        ...(t.minSpend.trim() ? { minSpendSatang: baht(t.minSpend), depositSatang: baht(t.deposit) } : {}),
      })),
      policies: { openWeekdays, arrivalBy, rules: { en: lines(rulesEn), th: lines(rulesTh) }, ...(cancellation.trim() ? { cancellationPolicy: cancellation.trim() } : {}) },
      profile: {
        capacityStanding: int(profile.capacityStanding), capacitySeated: int(profile.capacitySeated), district: profile.district.trim() || null, venueType: profile.venueType.trim() || null,
        genres: profile.genres.split(',').map((g) => g.trim()).filter(Boolean), priceBand: profile.priceBand.trim() || null, usualPeakHour: int(profile.usualPeakHour),
        licenceType: profile.licenceType.trim() || null, posVendor: profile.posVendor.trim() || null,
      },
      faqs: faqs.filter((f) => f.question.trim()).map((f) => ({ question: f.question.trim(), answerEn: f.answerEn.trim(), answerTh: f.answerTh.trim() })),
      ...(promptpayNote.trim() ? { promptpayNote: promptpayNote.trim() } : {}),
      contact,
    };
    try {
      const r = await api<{ submittedAt: string }>(`/api/onboard/${encodeURIComponent(token)}`, { method: 'PUT', body });
      setSavedAt(r.submittedAt);
    } catch (err) {
      setError(err instanceof ApiError && err.body.issues?.length ? `Please check: ${err.body.issues.map((i) => i.field).join(', ')}` : err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (loadError) return <div className="card" style={{ margin: 16 }}>{loadError}</div>;
  const zoneNames = zones.map((z) => z.name.trim()).filter(Boolean);
  const set = <T,>(arr: T[], i: number, patch: Partial<T>) => arr.map((x, j) => (j === i ? { ...x, ...patch } : x));

  return (
    <form className="stack" style={{ gap: 16, maxWidth: 860, margin: '0 auto', padding: 16 }} onSubmit={submit} autoComplete="off">
      <h1>{clubName || 'Club'} · before our call</h1>
      <p className="faint" style={{ margin: 0 }}>Fill in what you can. You can come back to this link and change your answers until we set you up. Prices in baht.</p>

      <div className="card stack">
        <h2>Zones and prices</h2>
        {zones.map((z, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(130px, 1fr))', gap: 8 }}>
            <input className="input" placeholder="Zone (EN)" value={z.name} onChange={(e) => setZones(set(zones, i, { name: e.target.value }))} />
            <input className="input" placeholder="โซน (TH)" value={z.nameTh} onChange={(e) => setZones(set(zones, i, { nameTh: e.target.value }))} />
            <input className="input" inputMode="decimal" placeholder="Min spend" value={z.minSpend} onChange={(e) => setZones(set(zones, i, { minSpend: e.target.value }))} />
            <input className="input" inputMode="decimal" placeholder="Deposit" value={z.deposit} onChange={(e) => setZones(set(zones, i, { deposit: e.target.value }))} />
            <input className="input" inputMode="decimal" placeholder="Sat min spend" value={z.satMinSpend} onChange={(e) => setZones(set(zones, i, { satMinSpend: e.target.value }))} />
            <input className="input" inputMode="decimal" placeholder="Sat deposit" value={z.satDeposit} onChange={(e) => setZones(set(zones, i, { satDeposit: e.target.value }))} />
          </div>
        ))}
        <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setZones([...zones, emptyZone()])}>Add zone</button>
      </div>

      <div className="card stack">
        <h2>Tables</h2>
        {tables.map((t, i) => (
          <div key={i} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 8 }}>
            <input className="input mono" placeholder="Code" value={t.code} onChange={(e) => setTables(set(tables, i, { code: e.target.value }))} />
            <select className="input" value={t.zone} onChange={(e) => setTables(set(tables, i, { zone: e.target.value }))}>
              <option value="">Zone…</option>
              {zoneNames.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
            <input className="input" inputMode="numeric" placeholder="Min guests" value={t.minPax} onChange={(e) => setTables(set(tables, i, { minPax: e.target.value }))} />
            <input className="input" inputMode="numeric" placeholder="Max guests" value={t.maxPax} onChange={(e) => setTables(set(tables, i, { maxPax: e.target.value }))} />
            <input className="input" inputMode="decimal" placeholder="Own min spend" value={t.minSpend} onChange={(e) => setTables(set(tables, i, { minSpend: e.target.value }))} />
            <input className="input" inputMode="decimal" placeholder="Own deposit" value={t.deposit} onChange={(e) => setTables(set(tables, i, { deposit: e.target.value }))} />
          </div>
        ))}
        <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setTables([...tables, emptyTable(zoneNames[0] ?? '')])}>Add table</button>
        <p className="faint" style={{ margin: 0 }}>Easier to send a floor plan? Send the image on LINE and we enter the tables.</p>
      </div>

      <div className="card stack">
        <h2>Opening and house rules</h2>
        <div className="row wrap">
          {WEEKDAYS.map((d, i) => (
            <label key={d} className="check">
              <input type="checkbox" checked={openWeekdays.includes(i)} onChange={(e) => setOpenWeekdays(e.target.checked ? [...openWeekdays, i].sort() : openWeekdays.filter((x) => x !== i))} />
              <span>{d}</span>
            </label>
          ))}
        </div>
        <div className="field">
          <label htmlFor="ob-arrival">Arrive with a booking by</label>
          <input id="ob-arrival" className="input" type="time" value={arrivalBy} onChange={(e) => setArrivalBy(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ob-ren">House rules in English (one per line)</label>
          <textarea id="ob-ren" className="input" rows={4} value={rulesEn} onChange={(e) => setRulesEn(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ob-rth">กฎของร้าน ภาษาไทย (บรรทัดละข้อ)</label>
          <textarea id="ob-rth" className="input" rows={4} value={rulesTh} onChange={(e) => setRulesTh(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ob-cancel">Cancellation and deposit policy</label>
          <textarea id="ob-cancel" className="input" rows={3} value={cancellation} onChange={(e) => setCancellation(e.target.value)} />
        </div>
      </div>

      <div className="card stack">
        <h2>About the club</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: 8 }}>
          {([
            ['capacityStanding', 'Capacity standing'],
            ['capacitySeated', 'Capacity seated'],
            ['district', 'District'],
            ['venueType', 'Venue type'],
            ['genres', 'Music (comma separated)'],
            ['priceBand', 'Price band'],
            ['usualPeakHour', 'Usual peak hour (0–23)'],
            ['licenceType', 'Licence type'],
            ['posVendor', 'POS system and plan'],
          ] as [keyof typeof profile, string][]).map(([k, label]) => (
            <div className="field" key={k}>
              <label htmlFor={`ob-${k}`}>{label}</label>
              <input id={`ob-${k}`} className="input" value={profile[k]} onChange={(e) => setProfile({ ...profile, [k]: e.target.value })} />
            </div>
          ))}
        </div>
      </div>

      <div className="card stack">
        <h2>Common questions</h2>
        <p className="faint" style={{ margin: 0 }}>Answer what applies; leave the rest empty. Add your own at the end.</p>
        {faqs.map((f, i) => (
          <div key={i} className="stack" style={{ gap: 4 }}>
            <input className="input" value={f.question} onChange={(e) => setFaqs(set(faqs, i, { question: e.target.value }))} />
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(240px, 1fr))', gap: 8 }}>
              <textarea className="input" rows={2} placeholder="Answer (EN)" value={f.answerEn} onChange={(e) => setFaqs(set(faqs, i, { answerEn: e.target.value }))} />
              <textarea className="input" rows={2} placeholder="คำตอบ (TH)" value={f.answerTh} onChange={(e) => setFaqs(set(faqs, i, { answerTh: e.target.value }))} />
            </div>
          </div>
        ))}
        <button type="button" className="btn small" style={{ alignSelf: 'flex-start' }} onClick={() => setFaqs([...faqs, { question: '', answerEn: '', answerTh: '' }])}>Add question</button>
      </div>

      <div className="card stack">
        <h2>Deposits and the call</h2>
        <div className="field">
          <label htmlFor="ob-pp">PromptPay account name (we enter the ID with you on the call)</label>
          <input id="ob-pp" className="input" value={promptpayNote} onChange={(e) => setPromptpayNote(e.target.value)} />
        </div>
        <div className="field">
          <label htmlFor="ob-who">Who will be on the call</label>
          <input id="ob-who" className="input" value={contact.name} onChange={(e) => setContact({ ...contact, name: e.target.value })} />
        </div>
        <label className="check"><input type="checkbox" checked={contact.lineAdmin} onChange={(e) => setContact({ ...contact, lineAdmin: e.target.checked })} /><span>They can log in to the LINE Official Account as admin</span></label>
        <label className="check"><input type="checkbox" checked={contact.desktop} onChange={(e) => setContact({ ...contact, desktop: e.target.checked })} /><span>They will be at a desktop browser</span></label>
        <label className="check"><input type="checkbox" checked={contact.noOtherBot} onChange={(e) => setContact({ ...contact, noOtherBot: e.target.checked })} /><span>No other bot tool is connected to the account</span></label>
      </div>

      {error && <div className="error">{error}</div>}
      {savedAt && <div className="faint">Saved {new Date(savedAt).toLocaleString()}. Thank you.</div>}
      <button className="btn primary" style={{ alignSelf: 'flex-start' }} disabled={busy}>{busy ? 'Saving…' : 'Save answers'}</button>
    </form>
  );
}
