import { describe, expect, it } from 'vitest';
import { VELORA } from '../src/demo/velora-content.js';

/** Task B0: the Velora demo club content is consistent before anything writes it to a database. */

const normalise = (s: string) => s.trim().toLowerCase().replace(/\s+/g, ' ');

describe('Velora content', () => {
  it('every table code is unique', () => {
    const codes = VELORA.tables.map((t) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it('every table belongs to a declared zone', () => {
    const zones = VELORA.zones.map((z) => z.code);
    for (const t of VELORA.tables) expect(zones, `table ${t.code}`).toContain(t.zone);
  });

  it('every FAQ has non-empty Thai and English', () => {
    for (const f of [...VELORA.faqs, ...VELORA.gaps]) {
      for (const text of [f.question_en, f.question_th, f.answer_en, f.answer_th]) {
        expect(text.trim().length, JSON.stringify(f)).toBeGreaterThan(0);
      }
    }
    for (const p of VELORA.policies) {
      expect(p.en.trim().length).toBeGreaterThan(0);
      expect(p.th.trim().length).toBeGreaterThan(0);
    }
  });

  it('gap questions do not appear in faqs', () => {
    const asked = new Set(VELORA.faqs.flatMap((f) => [normalise(f.question_en), normalise(f.question_th)]));
    for (const g of VELORA.gaps) {
      expect(asked.has(normalise(g.question_en)), g.question_en).toBe(false);
      expect(asked.has(normalise(g.question_th)), g.question_th).toBe(false);
    }
  });

  it('prices are integers in satang', () => {
    const amounts = [
      ...VELORA.zones.flatMap((z) => [z.minSpendSatang, z.depositSatang]),
      ...VELORA.tables.flatMap((t) => [t.minSpendSatang, t.depositSatang]).filter((a): a is number => a !== null),
      ...VELORA.priceRules.flatMap((r) => [r.minSpendSatang, r.depositSatang]),
    ];
    for (const a of amounts) {
      expect(Number.isInteger(a), String(a)).toBe(true);
      expect(a).toBeGreaterThanOrEqual(0);
      expect(a % 100, `${a} is not a whole baht amount`).toBe(0);
    }
    // A minimum spend below ฿1,000 means someone typed baht instead of satang.
    for (const z of VELORA.zones) expect(z.minSpendSatang).toBeGreaterThanOrEqual(100_000);
  });

  // ----- Shape the plan asks for (B0 Decisions) -----

  it('has the four zones and 18–24 tables with floor positions', () => {
    expect(VELORA.zones.map((z) => z.kind).sort()).toEqual(['booth', 'high', 'standing', 'vip']);
    expect(VELORA.tables.length).toBeGreaterThanOrEqual(18);
    expect(VELORA.tables.length).toBeLessThanOrEqual(24);
    for (const t of VELORA.tables) {
      expect(t.minPax).toBeGreaterThanOrEqual(1);
      expect(t.minPax).toBeLessThanOrEqual(t.maxPax);
      for (const v of [t.floorX, t.floorY]) {
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
    const spots = new Set(VELORA.tables.map((t) => `${t.floorX},${t.floorY}`));
    expect(spots.size, 'two tables share a floor position').toBe(VELORA.tables.length);
  });

  it('price rules point at real zones and differ on weekends and the event night', () => {
    const zones = VELORA.zones.map((z) => z.code);
    const tables = VELORA.tables.map((t) => t.code);
    for (const r of VELORA.priceRules) {
      if (r.scope === 'zone') expect(zones).toContain(r.target);
      if (r.scope === 'table') expect(tables).toContain(r.target);
      if (r.scope === 'club') expect(r.target).toBeNull();
      if (r.weekday !== null) {
        expect(r.weekday).toBeGreaterThanOrEqual(0);
        expect(r.weekday).toBeLessThanOrEqual(6);
        expect(VELORA.profile.openWeekdays, `rule for a closed night: ${r.label}`).toContain(r.weekday);
      }
    }
    const event = VELORA.profile.eventNight.weekday;
    for (const z of VELORA.zones) {
      const rule = (weekday: number) => VELORA.priceRules.find((r) => r.scope === 'zone' && r.target === z.code && r.weekday === weekday);
      expect(rule(6)?.minSpendSatang, `${z.code} Saturday`).toBeGreaterThan(z.minSpendSatang);
      expect(rule(event)?.minSpendSatang, `${z.code} event night`).toBeGreaterThan(z.minSpendSatang);
    }
  });

  it('has about 25 FAQs with unique slugs and exactly three gaps', () => {
    expect(VELORA.faqs.length).toBeGreaterThanOrEqual(22);
    expect(VELORA.faqs.length).toBeLessThanOrEqual(28);
    const slugs = VELORA.faqs.map((f) => f.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
    for (const s of slugs) expect(s).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(VELORA.gaps).toHaveLength(3);
  });

  it('FAQs and policies state no prices, so they pass the brain price check (spec §8.2, §8.5)', () => {
    const money = /฿|\bthb\b|\bbaht\b|บาท/i;
    const tableCode = new RegExp(`\\b(${VELORA.tables.map((t) => t.code).join('|')})\\b`);
    const texts = [
      ...VELORA.faqs.flatMap((f) => [f.answer_en, f.answer_th]),
      ...VELORA.gaps.flatMap((g) => [g.answer_en, g.answer_th]),
      ...VELORA.policies.flatMap((p) => [p.en, p.th]),
    ];
    for (const t of texts) {
      expect(money.test(t), t).toBe(false);
      expect(tableCode.test(t), t).toBe(false);
    }
  });

  it('profile seated capacity matches the tables', () => {
    expect(VELORA.profile.capacitySeated).toBe(VELORA.tables.reduce((n, t) => n + t.maxPax, 0));
    expect(VELORA.profile.capacityStanding).toBeGreaterThan(VELORA.profile.capacitySeated);
  });
});
