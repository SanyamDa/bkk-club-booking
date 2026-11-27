import { useState, type FormEvent } from 'react';
import { staffPath } from '../../api';
import { useStaff } from './Layout';

interface ImportResult {
  imported: number;
  created: number;
  updated: number;
  matched: number;
  walkIns: number;
  errors: string[];
}

/**
 * POS report import (plan A11, spec §11.3 L0b). Owner or manager uploads the POS sales report
 * (CSV) after the night; bills are matched to bookings by table and night. Uploading the same
 * report again updates it, it never duplicates bills.
 */
export function PosImport() {
  const { club } = useStaff();
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const form = new FormData();
      form.append('file', file);
      const res = await fetch(staffPath(club, '/pos/import'), { method: 'POST', body: form, credentials: 'same-origin' });
      const data = await res.json().catch(() => ({}));
      if (res.status === 403) setError('Only an owner or manager can import the POS report.');
      else if (res.status === 413) setError('The file is too large (5 MB at most).');
      else if (!res.ok) setError(data.errors?.length ? `The report could not be read: ${data.errors.join('; ')}` : `Import failed (HTTP ${res.status}).`);
      else setResult(data as ImportResult);
    } catch {
      setError('Could not reach the server.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="stack" style={{ maxWidth: 560 }} onSubmit={submit}>
      <h1>Import POS report</h1>
      <p className="faint" style={{ margin: 0 }}>
        Export the sales report (CSV) from your POS back office after the night and upload it here. Each bill is matched to a
        booking on the same table and night; bills without one are counted as walk-ins. Uploading the same report again is safe.
      </p>
      <div className="field">
        <label htmlFor="report">Sales report (.csv)</label>
        <input id="report" className="input" type="file" accept=".csv,text/csv" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
      </div>
      <div>
        <button className="btn primary" type="submit" disabled={!file || busy}>{busy ? 'Importing…' : 'Import'}</button>
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {result && (
        <div className="card stack" role="status">
          <b>{result.imported} bills imported</b>
          <div className="faint">
            {result.created} new · {result.updated} updated · {result.matched} matched to a booking · {result.walkIns} walk-ins
          </div>
          {result.errors.length > 0 && (
            <div>
              <b>{result.errors.length} rows skipped</b>
              <ul className="faint" style={{ margin: '4px 0 0' }}>
                {result.errors.slice(0, 20).map((m) => <li key={m}>{m}</li>)}
              </ul>
            </div>
          )}
        </div>
      )}
    </form>
  );
}
