import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { importPosReport } from '../integrations/pos/csv-import.js';
import { requireClubRole, type AuthEnv } from './auth.js';
import type { AppContext } from './context.js';

/** Largest report accepted (a night's bills are a few hundred rows). */
const MAX_REPORT_BYTES = 5 * 1024 * 1024;

/**
 * POS report import (plan A11, spec §11.3 L0b), mounted inside `staffRoutes`. Owner or manager
 * uploads the POS sales report as a multipart `file` field or a raw `text/csv` body.
 */
export function staffPosRoutes(app: AppContext) {
  const r = new Hono<AuthEnv>();
  const managers = requireClubRole(app, 'owner', 'manager');

  // Counts the bytes actually read, so a chunked upload with no Content-Length is capped too.
  const limit = bodyLimit({ maxSize: MAX_REPORT_BYTES, onError: (c) => c.json({ error: 'too_large' }, 413) });

  r.post('/clubs/:slug/pos/import', managers, limit, async (c) => {
    const club = c.var.club;
    const type = c.req.header('content-type') ?? '';
    let text: string;
    if (type.startsWith('multipart/form-data')) {
      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) return c.json({ error: 'bad_report', errors: ['attach the report as "file"'] }, 400);
      text = await file.text();
    } else {
      text = await c.req.text();
    }
    const result = await importPosReport(app.deps.db, club, text, { now: app.deps.now() });
    if (result.imported === 0) return c.json({ error: 'bad_report', ...result }, 400);
    return c.json(result);
  });

  return r;
}
