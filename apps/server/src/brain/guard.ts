import { lintNote } from './lint.js';

/**
 * Output guard for a bot answer (spec §8.4 "Prices and availability", §8.5, plan B16). Any amount,
 * table code or "available" claim in a model answer must match a booking-system result from the
 * same turn. The live answer path runs no booking query before it answers (the booking tools are
 * terminal: they hand the guest to the button flow), so in practice every amount, table code and
 * availability claim in a model answer fails and the answer is never sent.
 */
export type GuardIssue = { code: 'price' | 'availability' | 'table_code'; match: string };

/** What the booking system said in this turn; the only values an answer may repeat. */
export interface TurnFacts {
  /** Amount strings the booking system produced this turn, digits only ("5000"). */
  amounts: readonly string[];
  tableCodes: readonly string[];
  /** True when a booking-system availability result was produced this turn. */
  availability: boolean;
}

export const NO_FACTS: TurnFacts = { amounts: [], tableCodes: [], availability: false };

const digits = (s: string) => s.replace(/[^\d]/g, '');

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function guardAnswer(text: string, clubTableCodes: readonly string[], facts: TurnFacts = NO_FACTS): GuardIssue[] {
  const issues: GuardIssue[] = [];
  // The brain save-time lint is the same price and availability detector (B15).
  for (const i of lintNote({ type: 'faq', title: '', bodyMd: text })) {
    if (i.code === 'price') {
      const d = digits(i.match);
      if (!d || !facts.amounts.includes(d)) issues.push({ code: 'price', match: i.match });
    } else if (i.code === 'availability' && !facts.availability) {
      issues.push({ code: 'availability', match: i.match });
    }
  }
  for (const code of clubTableCodes) {
    if (facts.tableCodes.includes(code)) continue;
    if (new RegExp(`(^|[^A-Za-z0-9])${escapeRe(code)}(?![A-Za-z0-9])`, /[A-Za-z]/.test(code) ? 'i' : '').test(text)) {
      // A bare-number code ("12") only counts next to the word table/โต๊ะ, or every time would fail.
      if (!/[A-Za-z]/.test(code) && !new RegExp(`(table|โต๊ะ)\\s*${escapeRe(code)}(?!\\d)`, 'i').test(text)) continue;
      issues.push({ code: 'table_code', match: code });
    }
  }
  return issues;
}
