import { eq } from 'drizzle-orm';
import type { Db } from '../db/client.js';
import { platformFlags } from '../db/schema.js';

/**
 * Per-club feature switches (plan A17b, spec §12.3 Controls, Phase 2). The list is agreed with
 * Track B in the sync files; adding a key is additive, renaming one is a contract change.
 */
export const FEATURE_KEYS = ['ai_answers', 'learning_loop', 'instagram', 'pos_sync', 'alerts_line', 'payment_gateway'] as const;
export type FeatureKey = (typeof FEATURE_KEYS)[number];
export type FeatureSwitches = Record<FeatureKey, boolean>;

/** Value of a switch the console has never set for the club. */
export const FEATURE_DEFAULTS: FeatureSwitches = {
  // AI answers go live only after the club's baseline brain is reviewed (spec §12.2 rows 10-12).
  ai_answers: false,
  // The brain learns from takeovers by default (spec §3 table: "Switched on").
  learning_loop: true,
  // Integrations are off until the club is connected.
  instagram: false,
  pos_sync: false,
  // Staff LINE group alerts are on from day one (spec §17).
  alerts_line: true,
  // A20b: deposits through the payment gateway instead of the PromptPay slip. Off until switched on.
  payment_gateway: false,
};

export const isFeatureKey = (k: string): k is FeatureKey => (FEATURE_KEYS as readonly string[]).includes(k);

/** `platform_flags` key holding one club's switches, as `{ [FeatureKey]: boolean }`. */
export const featuresFlagKey = (clubId: string) => `features:${clubId}`;

/** The club's switches with defaults filled in. Reads the database on every call (no cache). */
export async function featureSwitches(db: Db, clubId: string): Promise<FeatureSwitches> {
  const [row] = await db.select({ value: platformFlags.value }).from(platformFlags).where(eq(platformFlags.key, featuresFlagKey(clubId))).limit(1);
  const stored = (row?.value && typeof row.value === 'object' ? row.value : {}) as Record<string, unknown>;
  const out = { ...FEATURE_DEFAULTS };
  for (const k of FEATURE_KEYS) if (typeof stored[k] === 'boolean') out[k] = stored[k] as boolean;
  return out;
}

/** True when the switch is on for the club. Read per request, so a change needs no restart. */
export async function isFeatureOn(db: Db, clubId: string, key: FeatureKey): Promise<boolean> {
  return (await featureSwitches(db, clubId))[key];
}
