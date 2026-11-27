import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildPlan, fridayShape, parseArgs, percentile, scheduleArrivals, signBody, summarize } from '../src/scripts/load.js';

describe('load script: Friday 22:00-01:00 shape', () => {
  it('starts low at 22:00, peaks between 23:30 and 00:30, tapers by 01:00', () => {
    expect(fridayShape(0)).toBeCloseTo(0.4);
    expect(fridayShape(0.5)).toBe(1);
    expect(fridayShape(0.75)).toBe(1);
    expect(fridayShape(1)).toBeCloseTo(0.6);
    for (let f = 0; f <= 1; f += 0.05) {
      expect(fridayShape(f)).toBeGreaterThan(0);
      expect(fridayShape(f)).toBeLessThanOrEqual(1);
    }
  });
});

describe('load script: rate scheduler', () => {
  it('a flat 60/min over 60 s gives 60 evenly spaced arrivals', () => {
    const t = scheduleArrivals(60_000, 60, () => 1);
    expect(t).toHaveLength(60);
    expect(t[1]! - t[0]!).toBeCloseTo(1000, -2);
    expect(t.every((x, i) => i === 0 || x >= t[i - 1]!)).toBe(true);
    expect(t.at(-1)!).toBeLessThan(60_000);
  });

  it('the Friday shape sends fewer than the peak rate in total but the full rate at the peak', () => {
    const t = scheduleArrivals(60_000, 600, fridayShape);
    expect(t.length).toBeLessThan(600);
    expect(t.length).toBeGreaterThan(600 * 0.6);
    const inWindow = (a: number, b: number) => t.filter((x) => x >= a && x < b).length;
    // 10 s at the peak (fraction 0.5-0.67) is 100 arrivals at 600/min; 10 s at the start is about 40-50.
    expect(inWindow(30_000, 40_000)).toBeGreaterThanOrEqual(99);
    expect(inWindow(0, 10_000)).toBeLessThan(55);
  });

  it('zero rate gives no arrivals', () => {
    expect(scheduleArrivals(10_000, 0, () => 1)).toEqual([]);
  });
});

describe('load script: plan', () => {
  it('at scale 1 with 2 clubs: 50 bookings/min per club and 1,000 inbound/min in total', () => {
    const plan = buildPlan({ clubs: ['a', 'b'], scale: 1, bookingsPerMin: 50, inboundPerMin: 1000 });
    // A booking is 2 inbound events (start postback + night pick).
    expect(plan.find((p) => p.club === 'a' && p.kind === 'booking')!.perMin).toBe(50);
    expect(plan.find((p) => p.club === 'b' && p.kind === 'booking')!.perMin).toBe(50);
    const events = plan.reduce((s, p) => s + p.perMin * p.eventsPer, 0);
    expect(events).toBeCloseTo(1000);
  });

  it('scale shrinks every stream', () => {
    const plan = buildPlan({ clubs: ['a'], scale: 0.1, bookingsPerMin: 50, inboundPerMin: 1000 });
    expect(plan.find((p) => p.kind === 'booking')!.perMin).toBe(5);
    expect(plan.reduce((s, p) => s + p.perMin * p.eventsPer, 0)).toBeCloseTo(100);
  });
});

describe('load script: p95', () => {
  it('nearest-rank percentile', () => {
    const v = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(v, 95)).toBe(95);
    expect(percentile(v, 50)).toBe(50);
    expect(percentile(v, 100)).toBe(100);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNaN();
  });

  it('summarize passes under 3 s p95 and fails at or above it', () => {
    const ok = summarize([...Array(95).fill(100), ...Array(5).fill(5000)], 0, 3000);
    expect(ok.p95).toBe(100);
    expect(ok.pass).toBe(true);
    const slow = summarize([...Array(90).fill(100), ...Array(10).fill(3000)], 0, 3000);
    expect(slow.p95).toBe(3000);
    expect(slow.pass).toBe(false);
  });

  it('summarize fails when more than 1% of requests error', () => {
    expect(summarize(Array(98).fill(10), 2, 3000).pass).toBe(false);
    expect(summarize(Array(99).fill(10), 1, 3000).pass).toBe(true);
  });
});

describe('load script: signing and args', () => {
  it('signs the body the way LINE does (base64 HMAC-SHA256 with the channel secret)', () => {
    const body = '{"events":[]}';
    expect(signBody(body, 's3cret')).toBe(createHmac('sha256', 's3cret').update(body).digest('base64'));
  });

  it('parses flags with defaults', () => {
    const a = parseArgs([]);
    expect(a).toMatchObject({ mode: 'sim', clubs: ['demo'], durationSec: 30, scale: 1, base: 'http://127.0.0.1:8787' });
    const b = parseArgs(['--mode', 'webhook', '--clubs', 'x,y', '--duration', '10', '--scale', '0.2']);
    expect(b).toMatchObject({ mode: 'webhook', clubs: ['x', 'y'], durationSec: 10, scale: 0.2 });
    expect(() => parseArgs(['--mode', 'bogus'])).toThrow();
  });
});
