import { useEffect, useState } from 'react';
import { api, ApiError, staffPath } from '../../../api';
import { useStaff } from '../Layout';

type NoteType = 'faq' | 'policy' | 'layout' | 'event' | 'learned';
interface Note {
  id: string;
  title: string;
  type: NoteType;
  status: 'draft' | 'live' | 'retired';
  bodyMd: string;
  source: string;
  validUntil: string | null;
  reviewBy: string | null;
  updatedAt: string;
}
interface QueueItem extends Note { question: string | null; hostReply: string | null; takeovers: number; replaces: string | null }
interface Gap { key: string; topic: string | null; count: number; lastAskedAt: string; question: string | null }
interface NotesRes { notes: Note[]; snapshot: { version: number; tokenCount: number } | null; tokenWarn: number; tokenCap: number }
interface LintIssue { code: string; message?: string }

const TYPE_LABEL: Record<NoteType, string> = { faq: 'FAQ', policy: 'Policy', layout: 'Layout', event: 'Event', learned: 'Learned' };
const TYPE_ORDER: NoteType[] = ['policy', 'faq', 'layout', 'event', 'learned'];
const SOURCE_LABEL: Record<string, string> = { onboarding: 'Onboarding', manual: 'Written by staff', takeover: 'Learned from a chat', import: 'Imported' };

/** A short Thai and English message for a refused save. */
function errorText(err: unknown): string {
  if (err instanceof ApiError) {
    const body = err.body as unknown as { error?: string; issues?: LintIssue[]; tokenCount?: number } | undefined;
    if (body?.error === 'lint') {
      const codes = new Set((body.issues ?? []).map((i) => i.code));
      if (codes.has('price')) return 'Prices belong in the pricing screen, not in a note. · ราคาให้ใส่ในหน้าราคา ไม่ใช่ในโน้ต';
      if (codes.has('availability')) return 'Notes cannot promise free tables; the booking system answers that. · โน้ตห้ามบอกว่าโต๊ะว่าง';
      if (codes.has('event_needs_end_date')) return 'An event note needs an end date. · โน้ตอีเวนต์ต้องมีวันสิ้นสุด';
      return 'This note was rejected. · โน้ตนี้ไม่ผ่าน';
    }
    if (body?.error === 'over_cap') return `The brain is full (${body.tokenCount} tokens). Retire old notes first. · สมองเต็ม ลบโน้ตเก่าก่อน`;
  }
  return 'Could not save. · บันทึกไม่ได้';
}

function NoteEditor({ initial, onSave, onCancel, saveLabel }: { initial: Partial<Note>; onSave: (n: { title: string; bodyMd: string; type: NoteType; validUntil: string | null }) => Promise<void>; onCancel: () => void; saveLabel: string }) {
  const [title, setTitle] = useState(initial.title ?? '');
  const [bodyMd, setBody] = useState(initial.bodyMd ?? '');
  const [type, setType] = useState<NoteType>(initial.type ?? 'faq');
  const [validUntil, setValidUntil] = useState(initial.validUntil ?? '');
  const [busy, setBusy] = useState(false);
  const isNew = !initial.id;
  return (
    <div className="stack" style={{ gap: 8 }}>
      <input className="input" value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title · หัวข้อ" aria-label="Title" />
      {isNew && (
        <select className="input" value={type} onChange={(e) => setType(e.target.value as NoteType)} aria-label="Type">
          {(['faq', 'policy', 'event'] as const).map((t) => <option key={t} value={t}>{TYPE_LABEL[t]}</option>)}
        </select>
      )}
      <textarea className="input" rows={5} value={bodyMd} onChange={(e) => setBody(e.target.value)} placeholder="Answer · คำตอบ" aria-label="Answer" />
      {(type === 'event' || initial.type === 'event') && (
        <div className="field">
          <label>Ends on · วันสิ้นสุด</label>
          <input className="input" type="date" value={validUntil} onChange={(e) => setValidUntil(e.target.value)} />
        </div>
      )}
      <div className="row">
        <button
          className="btn primary"
          disabled={busy || !title.trim() || !bodyMd.trim()}
          onClick={async () => {
            setBusy(true);
            try {
              await onSave({ title, bodyMd, type, validUntil: validUntil || null });
            } finally {
              setBusy(false);
            }
          }}
        >
          {saveLabel}
        </button>
        <button className="btn" onClick={onCancel}>Cancel · ยกเลิก</button>
      </div>
    </div>
  );
}

/** Brain manager (spec §6.6, plan B19): approval queue, gaps and all notes by type. */
export function Brain() {
  const { club } = useStaff();
  const [notes, setNotes] = useState<NotesRes | null>(null);
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [gaps, setGaps] = useState<Gap[]>([]);
  const [editing, setEditing] = useState<string | null>(null); // note id, `gap:<key>` or `new`
  const [error, setError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  async function load() {
    try {
      const [n, q, g] = await Promise.all([
        api<NotesRes>(staffPath(club, '/brain/notes')),
        api<{ queue: QueueItem[] }>(staffPath(club, '/brain/queue')),
        api<{ gaps: Gap[] }>(staffPath(club, '/brain/gaps')),
      ]);
      setNotes(n);
      setQueue(q.queue);
      setGaps(g.gaps);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof ApiError && err.status === 403 ? 'Only owners and managers can manage the brain. · เฉพาะเจ้าของและผู้จัดการ' : 'Could not load the brain. · โหลดไม่ได้');
    }
  }
  useEffect(() => {
    void load();
  }, [club]); // eslint-disable-line react-hooks/exhaustive-deps

  async function run(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      setEditing(null);
      await load();
    } catch (err) {
      setError(errorText(err));
    }
  }
  const approve = (id: string) => run(() => api(staffPath(club, `/brain/notes/${id}/approve`), { body: {} }));
  const reject = (id: string) => run(() => api(staffPath(club, `/brain/notes/${id}/reject`), { body: {} }));
  // validUntil is always sent: null clears a cleared 'Ends on' date. The editor starts from the note's own
  // value, so a note whose date field is hidden sends its date back unchanged.
  const patch = (id: string, n: { title: string; bodyMd: string; validUntil: string | null }) =>
    api(staffPath(club, `/brain/notes/${id}`), { method: 'PATCH', body: { title: n.title, bodyMd: n.bodyMd, validUntil: n.validUntil } });
  const create = (n: { title: string; bodyMd: string; type: NoteType; validUntil: string | null }, gapTopic?: string) =>
    api(staffPath(club, '/brain/notes'), { body: { title: n.title, bodyMd: n.bodyMd, type: n.type, validUntil: n.validUntil, gapTopic } });

  if (loadError) return <p className="muted">{loadError}</p>;
  if (!notes) return <div className="muted">Loading…</div>;
  const live = notes.notes.filter((n) => n.status === 'live');
  const tokens = notes.snapshot?.tokenCount ?? 0;

  return (
    <div className="stack" style={{ gap: 16 }}>
      <div>
        <h1>Brain · สมองบอท</h1>
        <p className="faint" style={{ margin: '4px 0 0' }}>
          Everything the bot can answer. {live.length} live notes · {tokens.toLocaleString('en-US')} of {notes.tokenCap.toLocaleString('en-US')} tokens
          {tokens >= notes.tokenWarn && <b> · nearly full</b>}
        </p>
      </div>
      {error && <div className="error">{error}</div>}

      <section className="card stack">
        <h2 style={{ margin: 0 }}>To approve · รออนุมัติ {queue.length > 0 && <span className="badge">{queue.length}</span>}</h2>
        {queue.length === 0 && <div className="muted">Nothing waiting. · ไม่มีรายการรอ</div>}
        {queue.map((q) => (
          <div key={q.id} className="stack" style={{ gap: 6, borderTop: '1px solid var(--line, #ddd)', paddingTop: 8 }}>
            {q.question && <div><span className="faint">Guest asked · ลูกค้าถาม:</span> {q.question}</div>}
            {q.hostReply && <div><span className="faint">Host replied · พนักงานตอบ:</span> {q.hostReply}</div>}
            {editing === q.id ? (
              <NoteEditor
                initial={q}
                saveLabel="Save and approve · บันทึกและอนุมัติ"
                onCancel={() => setEditing(null)}
                onSave={(n) => run(async () => { await patch(q.id, n); await api(staffPath(club, `/brain/notes/${q.id}/approve`), { body: {} }); })}
              />
            ) : (
              <>
                <b>{q.title} <span className="faint">({TYPE_LABEL[q.type]}{q.takeovers > 0 ? ` · ${q.takeovers} takeovers` : ''}{q.replaces ? ` · replaces "${q.replaces}"` : ''})</span></b>
                <div style={{ whiteSpace: 'pre-wrap' }}>{q.bodyMd}</div>
                <div className="row">
                  <button className="btn primary" onClick={() => void approve(q.id)}>Approve · อนุมัติ</button>
                  <button className="btn" onClick={() => setEditing(q.id)}>Edit · แก้ไข</button>
                  <button className="btn" onClick={() => void reject(q.id)}>Reject · ไม่ใช้</button>
                </div>
              </>
            )}
          </div>
        ))}
      </section>

      <section className="card stack">
        <h2 style={{ margin: 0 }}>Gaps · คำถามที่บอทตอบไม่ได้</h2>
        {gaps.length === 0 && <div className="muted">No unanswered questions in the last 30 days. · ไม่มีคำถามค้าง</div>}
        {gaps.map((g) => (
          <div key={g.key} className="stack" style={{ gap: 6, borderTop: '1px solid var(--line, #ddd)', paddingTop: 8 }}>
            <div className="spread wrap">
              <span><b>{g.question ?? g.topic}</b> <span className="faint">· asked {g.count}× · last {new Date(g.lastAskedAt).toLocaleDateString('en-GB')}</span></span>
              {editing !== `gap:${g.key}` && <button className="btn small" onClick={() => setEditing(`gap:${g.key}`)}>Write an answer · เขียนคำตอบ</button>}
            </div>
            {editing === `gap:${g.key}` && (
              <NoteEditor initial={{ title: g.question ?? g.topic ?? '' }} saveLabel="Save · บันทึก" onCancel={() => setEditing(null)} onSave={(n) => run(() => create(n, g.key))} />
            )}
          </div>
        ))}
      </section>

      <section className="card stack">
        <div className="spread wrap">
          <h2 style={{ margin: 0 }}>Notes · โน้ต</h2>
          {editing !== 'new' && <button className="btn small" onClick={() => setEditing('new')}>New note · โน้ตใหม่</button>}
        </div>
        {editing === 'new' && <NoteEditor initial={{}} saveLabel="Save · บันทึก" onCancel={() => setEditing(null)} onSave={(n) => run(() => create(n))} />}
        {TYPE_ORDER.map((type) => {
          const group = live.filter((n) => n.type === type);
          if (group.length === 0) return null;
          return (
            <div key={type} className="stack" style={{ gap: 8 }}>
              <h3 style={{ margin: '8px 0 0' }}>{TYPE_LABEL[type]}</h3>
              {group.map((n) => (
                <div key={n.id} className="stack" style={{ gap: 4 }}>
                  {editing === n.id ? (
                    <NoteEditor initial={n} saveLabel="Save · บันทึก" onCancel={() => setEditing(null)} onSave={(v) => run(() => patch(n.id, v))} />
                  ) : (
                    <>
                      <div className="spread wrap">
                        <b>{n.title}</b>
                        {n.type !== 'layout' && <button className="btn small" onClick={() => setEditing(n.id)}>Edit · แก้ไข</button>}
                      </div>
                      <div style={{ whiteSpace: 'pre-wrap' }}>{n.bodyMd}</div>
                      <div className="faint">
                        {SOURCE_LABEL[n.source] ?? n.source} · edited {new Date(n.updatedAt).toLocaleDateString('en-GB')}
                        {n.reviewBy && ` · review by ${n.reviewBy}`}
                        {n.validUntil && ` · ends ${n.validUntil}`}
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>
          );
        })}
      </section>

      <BrainImportExport club={club} run={run} />
    </div>
  );
}

/** Spec §8.2 seeding: export the brain as an Obsidian folder, import one back, or paste text. Imports are drafts. */
function BrainImportExport({ club, run }: { club: string; run: (fn: () => Promise<unknown>) => Promise<void> }) {
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');

  async function exportFolder() {
    const { files } = await api<{ files: { path: string; content: string }[] }>(staffPath(club, '/brain/export'));
    const blob = new Blob([JSON.stringify({ files }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${club}-brain.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  async function importFiles(list: FileList | null) {
    if (!list?.length) return;
    let files: { path: string; content: string }[] = [];
    for (const f of Array.from(list)) {
      const content = await f.text();
      if (f.name.endsWith('.json')) files = files.concat((JSON.parse(content) as { files: { path: string; content: string }[] }).files);
      else if (f.name.endsWith('.md')) files.push({ path: (f as File & { webkitRelativePath?: string }).webkitRelativePath || f.name, content });
    }
    await run(async () => {
      const r = await api<{ created: number; superseding: number; rejected: unknown[] }>(staffPath(club, '/brain/import'), { body: { files } });
      setMsg(`Imported ${r.created} draft(s), ${r.superseding} replacing a note, ${r.rejected.length} rejected.`);
    });
  }
  async function importText() {
    await run(async () => {
      const r = await api<{ created: unknown[]; rejected: unknown[] }>(staffPath(club, '/brain/import-text'), { body: { text } });
      setMsg(`Imported ${r.created.length} draft(s), ${r.rejected.length} rejected.`);
      setText('');
    });
  }

  return (
    <section className="card stack">
      <h2 style={{ margin: 0 }}>Import and export · นำเข้าและส่งออก</h2>
      <p className="faint" style={{ margin: 0 }}>Everything imported is a draft in the approval queue. · ทุกอย่างที่นำเข้าจะรออนุมัติ</p>
      <div className="row wrap">
        <button className="btn small" onClick={() => void exportFolder()}>Export brain · ส่งออก</button>
        <label className="btn small">
          Import folder · นำเข้าโฟลเดอร์
          <input type="file" multiple style={{ display: 'none' }} onChange={(e) => void importFiles(e.target.files)} {...{ webkitdirectory: '' }} />
        </label>
        <label className="btn small">
          Import export file · นำเข้าไฟล์
          <input type="file" accept=".json,.md" multiple style={{ display: 'none' }} onChange={(e) => void importFiles(e.target.files)} />
        </label>
      </div>
      <textarea className="input" rows={5} placeholder="Paste a pinned message or a rules page · วางข้อความ" value={text} onChange={(e) => setText(e.target.value)} />
      <button className="btn small" style={{ alignSelf: 'flex-start' }} disabled={!text.trim()} onClick={() => void importText()}>Import text · นำเข้าข้อความ</button>
      {msg && <div className="faint">{msg}</div>}
    </section>
  );
}
