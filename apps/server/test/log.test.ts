import { afterEach, describe, expect, it, vi } from 'vitest';
import { jsonLog, logLine } from '../src/lib/log.js';

afterEach(() => vi.restoreAllMocks());

describe('structured logs (A7)', () => {
  it('writes one JSON object per line to stdout', () => {
    const lines: string[] = [];
    logLine('warn', 'quota high', { clubId: 'club_demo', pct: 81 }, (l) => lines.push(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', msg: 'quota high', clubId: 'club_demo', pct: 81 });
  });

  it('jsonLog logs info without an error and error with the error serialised', () => {
    const out: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out.push(String(chunk));
      return true;
    });
    jsonLog('hello');
    jsonLog('Bot error for club x', new Error('boom'));
    const [a, b] = out.map((l) => JSON.parse(l));
    expect(a).toMatchObject({ level: 'info', msg: 'hello' });
    expect(b).toMatchObject({ level: 'error', msg: 'Bot error for club x', err: { name: 'Error', message: 'boom' } });
    expect(typeof b.time).toBe('string');
  });
});
