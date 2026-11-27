import { PAX_RANGES } from '../bookings/service.js';
import { addDays, weekdayOf } from '../lib/time.js';

/**
 * Booking details from free text (spec §8.1 "Extract booking details", plan B16). A deterministic
 * first pass in Thai and English runs before any model call, so "โต๊ะ 6 คน เสาร์นี้" and
 * "17A sat 6ppl" jump to the right step without spending tokens. The model's own extraction
 * (`start_booking` / `check_availability` tool input) goes through `normalizeDetails`, so a value
 * the model invents (a table code the club does not have, a date in the past) is dropped.
 */
export interface BookingDetails {
  /** YYYY-MM-DD night date (club local). */
  date?: string;
  pax?: number;
  /** A code of one of the club's active tables, as the club spells it. */
  tableCode?: string;
  /** Id of one of the club's zones. */
  zonePref?: string;
}

export interface ExtractContext {
  /** Club night date of "now" (`clubToday`). */
  today: string;
  tableCodes: readonly string[];
  zones: readonly { id: string; name: string; nameTh: string }[];
}

/** Largest party the bot will take as a number from text; above it the value is ignored. */
const MAX_PAX = 99;

/** Weekday names: index is `Date.getUTCDay()` (0 Sunday). Thai full and short forms. */
const WEEKDAYS: { day: number; re: RegExp }[] = [
  { day: 0, re: /\b(sun|sunday)\b|อาทิตย์(?!หน้า)|อา\./i },
  { day: 1, re: /\b(mon|monday)\b|จันทร์/i },
  { day: 2, re: /\b(tue|tues|tuesday)\b|อังคาร/i },
  { day: 3, re: /\b(wed|weds|wednesday)\b|พุธ/i },
  { day: 4, re: /\b(thu|thur|thurs|thursday)\b|พฤหัส(?:บดี)?/i },
  { day: 5, re: /\b(fri|friday)\b|ศุกร์/i },
  { day: 6, re: /\b(sat|saturday)\b|เสาร์/i },
];

const TONIGHT = /\b(tonight|today)\b|คืนนี้|วันนี้/i;
const TOMORROW = /\b(tomorrow|tmr|tmrw)\b|พรุ่งนี้/i;
const NEXT_WEEK = /\bnext\s+(sun|mon|tue|wed|thu|fri|sat)|(?:อาทิตย์|สัปดาห์)หน้า/i;
/** 28/11, 28/11/2026, 28-11. Day first (Thai and UK habit). */
const DAY_MONTH = /\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/;
/** "6 คน", "6ppl", "6 people", "6 pax", "for 6", "6 guests". */
const PAX = /(\d{1,2})\s*(?:คน|ท่าน|ppl|people|pax|persons?|guests?|pp)(?![a-z])/i;
const PAX_FOR = /\bfor\s+(\d{1,2})\b(?!\s*(?:am|pm|:|\.|h\b|hours?|o'?clock|ทุ่ม))/i;

/** The next night with this weekday on or after `today`. */
function nextWeekday(today: string, day: number): string {
  const diff = (day - weekdayOf(today) + 7) % 7;
  return addDays(today, diff);
}

function extractDate(text: string, today: string): string | undefined {
  if (TOMORROW.test(text)) return addDays(today, 1);
  if (TONIGHT.test(text)) return today;
  for (const w of WEEKDAYS) {
    if (w.re.test(text)) {
      const d = nextWeekday(today, w.day);
      return NEXT_WEEK.test(text) ? addDays(d, 7) : d;
    }
  }
  const dm = text.match(DAY_MONTH);
  if (dm) {
    const day = Number(dm[1]);
    const month = Number(dm[2]);
    if (day < 1 || day > 31 || month < 1 || month > 12) return undefined;
    let year = dm[3] ? Number(dm[3]) : Number(today.slice(0, 4));
    if (year < 100) year += 2000;
    if (year > 2400) year -= 543; // Buddhist era year (2569 = 2026)
    const date = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    if (!dm[3] && date < today) return `${year + 1}${date.slice(4)}`;
    return date;
  }
  return undefined;
}

function extractPax(text: string): number | undefined {
  const m = text.match(PAX) ?? text.match(PAX_FOR);
  if (!m) return undefined;
  const n = Number(m[1]);
  return n >= 1 && n <= MAX_PAX ? n : undefined;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A club table code written as its own token ("17A", "b1"); the club's spelling is returned. */
function extractTableCode(text: string, codes: readonly string[]): string | undefined {
  // Longest first, so "B10" wins over "B1".
  for (const code of [...codes].sort((a, b) => b.length - a.length)) {
    if (!/[A-Za-z]/.test(code) || code.length < 2) continue; // a bare number is a party size, not a table
    if (new RegExp(`(^|[^A-Za-z0-9])${escapeRe(code)}(?![A-Za-z0-9])`, 'i').test(text)) return code;
  }
  return undefined;
}

function extractZone(text: string, zones: ExtractContext['zones']): string | undefined {
  const lower = text.toLowerCase();
  return zones.find((z) => (z.name && lower.includes(z.name.toLowerCase())) || (z.nameTh && text.includes(z.nameTh)))?.id;
}

/** Deterministic extraction. Returns only the fields it found. */
export function extractBookingDetails(text: string, ctx: ExtractContext): BookingDetails {
  const out: BookingDetails = {};
  const date = extractDate(text, ctx.today);
  if (date) out.date = date;
  const pax = extractPax(text);
  if (pax) out.pax = pax;
  const tableCode = extractTableCode(text, ctx.tableCodes);
  if (tableCode) out.tableCode = tableCode;
  const zone = extractZone(text, ctx.zones);
  if (zone) out.zonePref = zone;
  return out;
}

/** True when the details are enough to move the booking flow past its first step. */
export function hasBookingDetails(d: BookingDetails): boolean {
  return Boolean(d.date || d.tableCode);
}

/**
 * For text with no booking word: only a table code, or a night together with a party size, reads
 * as a booking request ("17A sat 6ppl"). A night alone ("I lost my phone on Saturday") does not.
 */
export function looksLikeBookingRequest(d: BookingDetails): boolean {
  return Boolean(d.tableCode || (d.date && d.pax));
}

/**
 * Validates details from model output (`{ date, pax, table_code, zone_pref }`). Unknown keys
 * (a club id, a guest id) are never read. Invalid values are dropped, not corrected.
 */
export function normalizeDetails(input: unknown, ctx: ExtractContext): BookingDetails {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const out: BookingDetails = {};
  if (typeof raw.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(raw.date) && raw.date >= ctx.today) out.date = raw.date;
  const pax = typeof raw.pax === 'number' ? raw.pax : typeof raw.pax === 'string' ? Number(raw.pax) : NaN;
  if (Number.isInteger(pax) && pax >= 1 && pax <= MAX_PAX) out.pax = pax;
  if (typeof raw.table_code === 'string') {
    const code = ctx.tableCodes.find((c) => c.toLowerCase() === (raw.table_code as string).trim().toLowerCase());
    if (code) out.tableCode = code;
  }
  if (typeof raw.zone_pref === 'string') {
    const z = raw.zone_pref.trim().toLowerCase();
    const zone = ctx.zones.find((x) => x.id === raw.zone_pref || x.name.toLowerCase() === z || x.nameTh === raw.zone_pref);
    if (zone) out.zonePref = zone.id;
  }
  return out;
}

/** The pax range key (`PAX_RANGES`) a party size falls in. One guest books as 2-4. */
export function paxKeyFor(pax: number): string {
  return (PAX_RANGES.find((r) => pax >= r.min && pax <= r.max) ?? PAX_RANGES[0]).key;
}
