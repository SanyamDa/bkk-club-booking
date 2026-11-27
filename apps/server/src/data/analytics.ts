import { sql } from 'drizzle-orm';
import type { Db } from '../db/client.js';

/**
 * The views of the `analytics` schema (B14, migration 0006_analytics_views). The same names exist in
 * `analytics_demo` (demo clubs only). Every view has a `club_id` column.
 */
export const ANALYTICS_VIEWS = [
  'clubs',
  'events',
  'booking_funnel',
  'booking_pace',
  'booking_curve',
  'demand_no_table',
  'no_show_rate',
  'door_vs_bookings',
  'busyness_by_hour',
] as const;

export type AnalyticsView = (typeof ANALYTICS_VIEWS)[number];

/** The read-only database role Metabase connects with. */
export const METABASE_ROLE = 'metabase_ro';

/**
 * Test rows visible in the `analytics` schema; must be 0 (the `testInAggregates` nightly check, §14.2).
 * Counts rows of a demo club in any view, plus `analytics.events` rows whose event is `is_test`.
 */
export async function testRowsInAnalytics(db: Db): Promise<number> {
  let total = 0;
  for (const view of ANALYTICS_VIEWS) {
    const key = view === 'clubs' ? 'id' : 'club_id';
    const r = await db.execute(
      sql.raw(
        `select count(*)::int as n from analytics.${view} v join public.clubs c on c.id = v.${key} where c.status = 'demo'`,
      ),
    );
    total += Number((r.rows[0] as { n: number }).n);
  }
  const r = await db.execute(
    sql`select count(*)::int as n from analytics.events v join public.events e on e.id = v.id where e.is_test`,
  );
  return total + Number((r.rows[0] as { n: number }).n);
}
