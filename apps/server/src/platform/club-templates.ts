import type { ClubSettings } from '../db/schema.js';
import { bangkokParts, toDateString } from '../lib/time.js';

/**
 * Complete settings for a console-created club (plan A5): today's operating values from
 * `db/seed.ts`, with empty rules, greeting, address and map link for the founder or the manager
 * to fill before go-live. `refPrefix` is the slug's base prefix; `uniqueRefPrefix` makes it unique.
 */
export function newClubSettings(slug: string, now: Date): ClubSettings {
  const p = bangkokParts(now);
  return {
    openWeekdays: [3, 4, 5, 6], // Wed–Sat
    closedDates: [],
    bookingWindowDays: 30,
    holdMinutes: 10,
    nightStartHour: 18,
    nightEndHour: 6,
    arrivalBy: '23:30',
    handoffTimeoutMinutes: 30,
    refPrefix: baseRefPrefix(slug),
    accentColor: '#C9A45C',
    rulesVersion: toDateString(p.year, p.month, p.day),
    rules: { en: [], th: [] },
    greeting: { en: '', th: '' },
    address: '',
    mapUrl: '',
  };
}

/** First three letters of the slug, upper case. */
export function baseRefPrefix(slug: string): string {
  return slug.replace(/[^a-z]/gi, '').slice(0, 3).toUpperCase() || 'CLB';
}

/** The slug's prefix, with a digit added (2, 3, …) when another club already uses it. */
export function uniqueRefPrefix(slug: string, taken: Iterable<string>): string {
  const used = new Set(taken);
  const base = baseRefPrefix(slug);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}${n}`)) return `${base}${n}`;
}
