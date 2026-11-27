/**
 * Save-time lint for brain notes (spec §8.2, §8.4, plan B15). Prices and availability are never
 * stored in the brain: they come from the booking system in the same turn (§8.5). Event and
 * promotion notes need an end date.
 */

export const NOTE_TYPES = ['faq', 'policy', 'layout', 'event', 'learned'] as const;
export type NoteType = (typeof NOTE_TYPES)[number];

export type LintCode = 'price' | 'availability' | 'event_needs_end_date';
export interface LintIssue {
  code: LintCode;
  /** The text that failed, for the editor to highlight. */
  match: string;
}

/** Thrown by a save that fails lint. Nothing is written. `fix: 'prices'` points to the pricing screen. */
export class BrainLintError extends Error {
  readonly fix = 'prices' as const;
  constructor(readonly issues: LintIssue[]) {
    super(`brain note rejected: ${issues.map((i) => i.code).join(', ')}`);
    this.name = 'BrainLintError';
  }
}

const NUMBER = /\d[\d,.]*(\s*[kK](?![a-zA-Z]))?/g;
const CURRENCY_AFTER = /^\s*(฿|บาท|บ\.|baht\b|thb\b)/i;
const CURRENCY_BEFORE = /(฿|\bthb|\bbaht)\s*$/i;
const PRICE_WORDS = /(minimum spend|min\.? spend|deposit|ขั้นต่ำ|มัดจำ)/i;
/** A number followed by one of these is a duration or count of time, not an amount. */
const TIME_UNIT_AFTER = /^\s*(hours?|hrs?|h\b|days?|minutes?|mins?|weeks?|ชั่วโมง|ชม|วัน|นาที|สัปดาห์|am\b|pm\b|น\.)/i;
const NEAR = 30;

const AVAILABILITY = [
  /\b(tables?|seats?|spots?|booths?)\b[^.\n]{0,30}\bavailable\b/i,
  /\bavailable\b[^.\n]{0,20}\b(tonight|tables?)\b/i,
  /\bavailability\b/i,
  /\bsold[ -]out\b/i,
  /\bfully booked\b/i,
  /โต๊ะว่าง/,
  /ยังว่าง/,
  /เต็มแล้ว/,
];

function priceIssues(text: string): LintIssue[] {
  const out: LintIssue[] = [];
  for (const m of text.matchAll(NUMBER)) {
    const start = m.index!;
    const raw = m[0].trim();
    const end = start + m[0].length;
    const digitsEnd = start + /^\d[\d,.]*/.exec(m[0])![0].length;
    const before = text.slice(Math.max(0, start - NEAR), start);
    const after = text.slice(end, end + NEAR);
    // Either half of 20:00 is a time.
    if (text[start - 1] === ':' || /^:\d/.test(text.slice(digitsEnd, digitsEnd + 2))) continue;
    if (CURRENCY_AFTER.test(text.slice(end)) || CURRENCY_BEFORE.test(text.slice(0, start))) {
      out.push({ code: 'price', match: text.slice(Math.max(0, start - 3), end + 5).trim() });
      continue;
    }
    if (TIME_UNIT_AFTER.test(text.slice(end))) continue;
    // Multiply, not append zeros: '2.5k' is 2500, not '2.5000'.
    const n = Number(raw.replace(/[,\s]/g, '').replace(/[kK]$/, ''));
    const value = /[kK]$/.test(raw) ? n * 1000 : n;
    if (!Number.isFinite(value) || value < 100) continue;
    if (PRICE_WORDS.test(before) || PRICE_WORDS.test(after)) out.push({ code: 'price', match: raw });
  }
  return out;
}

/** Every issue in a note; an empty list means it may be saved. */
export function lintNote(n: { type: NoteType | string; title: string; bodyMd: string; validUntil?: string | null }): LintIssue[] {
  const text = `${n.title}\n${n.bodyMd}`;
  const issues = priceIssues(text);
  for (const re of AVAILABILITY) {
    const m = re.exec(text);
    if (m) issues.push({ code: 'availability', match: m[0] });
  }
  if (n.type === 'event' && !n.validUntil) issues.push({ code: 'event_needs_end_date', match: n.title });
  return issues;
}

export function assertLint(n: Parameters<typeof lintNote>[0]): void {
  const issues = lintNote(n);
  if (issues.length) throw new BrainLintError(issues);
}
