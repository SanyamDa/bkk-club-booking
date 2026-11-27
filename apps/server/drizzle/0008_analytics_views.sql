-- B14 Data dashboard v1 (spec §14.5, §14.6, §14.8, §14.10). Custom migration: views and a role only.
--
-- analytics_src  private base views (never granted). Each row carries `demo` (its club has status 'demo').
--                Test rows of real clubs (is_test on the event, booking or guest) are dropped here.
--                Only first-party and POS data: events with data_origin in (first_party, pos) and not on
--                the instagram channel; bookings whose source is not instagram. No raw, no free text, no names.
-- analytics      the same views WHERE NOT demo: real clubs only. Read by Metabase and cross-club figures.
-- analytics_demo the same views WHERE demo: Velora only, behind the boards' "dataset = demo" filter.
-- metabase_ro    read-only role: USAGE + SELECT on analytics and analytics_demo, nothing else.
CREATE SCHEMA IF NOT EXISTS analytics_src;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS analytics;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS analytics_demo;
--> statement-breakpoint
CREATE VIEW analytics_src.clubs AS
SELECT c.id, c.slug, c.name, c.status, c.created_at, (c.status = 'demo') AS demo
FROM public.clubs c;
--> statement-breakpoint
CREATE VIEW analytics_src.events AS
SELECT e.seq, e.id, e.occurred_at, e.recorded_at, e.club_id, e.night_date, e.type, e.v,
       e.actor_type, e.actor_id, e.channel, e.data_origin, e.source,
       e.guest_id, e.person_id, e.conversation_id, e.booking_id, e.table_id, e.zone_id,
       e.attempt_id, e.cause_id, e.lang, e.props,
       (c.status = 'demo') AS demo
FROM public.events e
JOIN public.clubs c ON c.id = e.club_id
WHERE e.data_origin IN ('first_party', 'pos')
  AND e.channel IS DISTINCT FROM 'instagram'
  AND (c.status = 'demo' OR NOT e.is_test);
--> statement-breakpoint
CREATE VIEW analytics_src.bookings AS
SELECT b.id, b.club_id, b.table_id, t.zone_id, b.night_date, b.pax, b.status, b.source,
       b.min_spend_satang, b.deposit_satang, b.created_at, b.arrived_at, b.arrived_pax,
       (c.status = 'demo') AS demo
FROM public.bookings b
JOIN public.clubs c ON c.id = b.club_id
JOIN public.guests g ON g.id = b.guest_id
JOIN public.tables t ON t.id = b.table_id
WHERE b.source <> 'instagram'
  AND (c.status = 'demo' OR (NOT b.is_test AND NOT g.is_test));
--> statement-breakpoint
-- §14.10 funnel: one row per club, start day (Bangkok) and step, counting attempts that reached the step.
CREATE VIEW analytics_src.booking_funnel AS
WITH steps(step_no, step, type) AS (
  VALUES (1, 'started', 'booking.started'), (2, 'night', 'night.selected'), (3, 'pax', 'pax.selected'),
         (4, 'table', 'table.held'), (5, 'details', 'details.submitted'), (6, 'rules', 'rules.accepted'),
         (7, 'paid', 'deposit.verified'), (8, 'confirmed', 'booking.confirmed')
), attempts AS (
  SELECT club_id, attempt_id, bool_or(demo) AS demo,
         (min(occurred_at) AT TIME ZONE 'Asia/Bangkok')::date AS started_on
  FROM analytics_src.events
  WHERE attempt_id IS NOT NULL
  GROUP BY club_id, attempt_id
)
SELECT a.club_id, a.started_on, s.step_no, s.step,
       count(DISTINCT e.attempt_id)::int AS attempts, a.demo
FROM attempts a
CROSS JOIN steps s
LEFT JOIN analytics_src.events e
  ON e.club_id = a.club_id AND e.attempt_id = a.attempt_id AND e.type = s.type
GROUP BY a.club_id, a.started_on, s.step_no, s.step, a.demo;
--> statement-breakpoint
-- Booking pace: bookings that reached confirmed, by days between booking and the night.
CREATE VIEW analytics_src.booking_pace AS
WITH b AS (
  SELECT club_id, night_date, demo, pax,
         (night_date::date - (created_at AT TIME ZONE 'Asia/Bangkok')::date) AS days_before
  FROM analytics_src.bookings
  WHERE status IN ('confirmed', 'arrived', 'completed', 'no_show')
), g AS (
  SELECT club_id, night_date, days_before, demo, count(*)::int AS bookings, sum(pax)::int AS pax
  FROM b GROUP BY club_id, night_date, days_before, demo
)
SELECT club_id, night_date, days_before, bookings, pax,
       (sum(bookings) OVER (PARTITION BY club_id, night_date ORDER BY days_before DESC))::int AS cumulative_bookings,
       demo
FROM g;
--> statement-breakpoint
-- Booking curve (§14.3): the occupancy snapshots.
CREATE VIEW analytics_src.booking_curve AS
SELECT s.club_id, s.night_date, s.taken_at, s.lead_bucket, s.tables_active, s.tables_held,
       s.tables_confirmed, s.tables_arrived, s.pax_booked, s.min_spend_booked_satang,
       round((s.tables_confirmed + s.tables_arrived)::numeric / nullif(s.tables_active, 0), 4) AS booked_share,
       (c.status = 'demo') AS demo
FROM public.occupancy_snapshots s
JOIN public.clubs c ON c.id = s.club_id;
--> statement-breakpoint
-- Demand that found no table: zero-result searches and sold-out nights shown.
CREATE VIEW analytics_src.demand_no_table AS
SELECT club_id, coalesce(night_date, props->>'night_date') AS night_date, props->>'pax_range' AS pax_range,
       (count(*) FILTER (WHERE type = 'availability.searched'))::int AS zero_result_searches,
       (count(*) FILTER (WHERE type = 'night.sold_out_shown'))::int AS sold_out_shown,
       demo
FROM analytics_src.events
WHERE (type = 'availability.searched' AND props->>'result_count' = '0') OR type = 'night.sold_out_shown'
GROUP BY club_id, coalesce(night_date, props->>'night_date'), props->>'pax_range', demo;
--> statement-breakpoint
-- No-show rate per club-night: bookings that were due (arrived, completed or no-show).
CREATE VIEW analytics_src.no_show_rate AS
SELECT club_id, night_date,
       count(*)::int AS due,
       (count(*) FILTER (WHERE status IN ('arrived', 'completed')))::int AS arrived,
       (count(*) FILTER (WHERE status = 'no_show'))::int AS no_shows,
       round((count(*) FILTER (WHERE status = 'no_show'))::numeric / count(*), 4) AS no_show_rate,
       demo
FROM analytics_src.bookings
WHERE status IN ('arrived', 'completed', 'no_show')
GROUP BY club_id, night_date, demo;
--> statement-breakpoint
-- Door counts against bookings per club-night.
CREATE VIEW analytics_src.door_vs_bookings AS
WITH d AS (
  SELECT club_id, night_date,
         coalesce(sum(delta) FILTER (WHERE delta > 0), 0)::int AS door_in,
         coalesce(-sum(delta) FILTER (WHERE delta < 0), 0)::int AS door_out
  FROM public.door_counts GROUP BY club_id, night_date
), b AS (
  SELECT club_id, night_date, sum(pax)::int AS booked_pax, coalesce(sum(arrived_pax), 0)::int AS arrived_pax
  FROM analytics_src.bookings
  WHERE status IN ('confirmed', 'arrived', 'completed', 'no_show')
  GROUP BY club_id, night_date
), k AS (
  SELECT club_id, night_date FROM d UNION SELECT club_id, night_date FROM b
)
SELECT k.club_id, k.night_date,
       coalesce(d.door_in, 0) AS door_in, coalesce(d.door_out, 0) AS door_out,
       coalesce(d.door_in, 0) - coalesce(d.door_out, 0) AS door_net,
       coalesce(b.booked_pax, 0) AS booked_pax, coalesce(b.arrived_pax, 0) AS arrived_pax,
       (c.status = 'demo') AS demo
FROM k
JOIN public.clubs c ON c.id = k.club_id
LEFT JOIN d ON d.club_id = k.club_id AND d.night_date = k.night_date
LEFT JOIN b ON b.club_id = k.club_id AND b.night_date = k.night_date;
--> statement-breakpoint
-- Busyness by club and hour (Bangkok): door net, check-ins and the average staff crowd rating.
CREATE VIEW analytics_src.busyness_by_hour AS
WITH x AS (
  SELECT club_id, night_date, extract(hour FROM at AT TIME ZONE 'Asia/Bangkok')::int AS hour,
         delta AS door, 0 AS checkin, NULL::int AS rating
  FROM public.door_counts
  UNION ALL
  SELECT club_id, night_date, extract(hour FROM arrived_at AT TIME ZONE 'Asia/Bangkok')::int, 0, 1, NULL
  FROM analytics_src.bookings WHERE arrived_at IS NOT NULL
  UNION ALL
  SELECT club_id, night_date, extract(hour FROM at AT TIME ZONE 'Asia/Bangkok')::int, 0, 0, level
  FROM public.crowd_ratings
)
SELECT x.club_id, x.night_date, x.hour,
       sum(x.door)::int AS door_net, sum(x.checkin)::int AS checkins,
       round(avg(x.rating), 2) AS crowd_rating_avg,
       (c.status = 'demo') AS demo
FROM x
JOIN public.clubs c ON c.id = x.club_id
GROUP BY x.club_id, x.night_date, x.hour, c.status;
--> statement-breakpoint
CREATE VIEW analytics.clubs AS SELECT id, slug, name, status, created_at FROM analytics_src.clubs WHERE NOT demo;
--> statement-breakpoint
CREATE VIEW analytics_demo.clubs AS SELECT id, slug, name, status, created_at FROM analytics_src.clubs WHERE demo;
--> statement-breakpoint
CREATE VIEW analytics.events AS
SELECT seq, id, occurred_at, recorded_at, club_id, night_date, type, v, actor_type, actor_id, channel, data_origin,
       source, guest_id, person_id, conversation_id, booking_id, table_id, zone_id, attempt_id, cause_id, lang, props
FROM analytics_src.events WHERE NOT demo;
--> statement-breakpoint
CREATE VIEW analytics_demo.events AS
SELECT seq, id, occurred_at, recorded_at, club_id, night_date, type, v, actor_type, actor_id, channel, data_origin,
       source, guest_id, person_id, conversation_id, booking_id, table_id, zone_id, attempt_id, cause_id, lang, props
FROM analytics_src.events WHERE demo;
--> statement-breakpoint
CREATE VIEW analytics.booking_funnel AS SELECT club_id, started_on, step_no, step, attempts FROM analytics_src.booking_funnel WHERE NOT demo;
--> statement-breakpoint
CREATE VIEW analytics_demo.booking_funnel AS SELECT club_id, started_on, step_no, step, attempts FROM analytics_src.booking_funnel WHERE demo;
--> statement-breakpoint
CREATE VIEW analytics.booking_pace AS SELECT club_id, night_date, days_before, bookings, pax, cumulative_bookings FROM analytics_src.booking_pace WHERE NOT demo;
--> statement-breakpoint
CREATE VIEW analytics_demo.booking_pace AS SELECT club_id, night_date, days_before, bookings, pax, cumulative_bookings FROM analytics_src.booking_pace WHERE demo;
--> statement-breakpoint
CREATE VIEW analytics.booking_curve AS
SELECT club_id, night_date, taken_at, lead_bucket, tables_active, tables_held, tables_confirmed, tables_arrived,
       pax_booked, min_spend_booked_satang, booked_share
FROM analytics_src.booking_curve WHERE NOT demo;
--> statement-breakpoint
CREATE VIEW analytics_demo.booking_curve AS
SELECT club_id, night_date, taken_at, lead_bucket, tables_active, tables_held, tables_confirmed, tables_arrived,
       pax_booked, min_spend_booked_satang, booked_share
FROM analytics_src.booking_curve WHERE demo;
--> statement-breakpoint
CREATE VIEW analytics.demand_no_table AS SELECT club_id, night_date, pax_range, zero_result_searches, sold_out_shown FROM analytics_src.demand_no_table WHERE NOT demo;
--> statement-breakpoint
CREATE VIEW analytics_demo.demand_no_table AS SELECT club_id, night_date, pax_range, zero_result_searches, sold_out_shown FROM analytics_src.demand_no_table WHERE demo;
--> statement-breakpoint
CREATE VIEW analytics.no_show_rate AS SELECT club_id, night_date, due, arrived, no_shows, no_show_rate FROM analytics_src.no_show_rate WHERE NOT demo;
--> statement-breakpoint
CREATE VIEW analytics_demo.no_show_rate AS SELECT club_id, night_date, due, arrived, no_shows, no_show_rate FROM analytics_src.no_show_rate WHERE demo;
--> statement-breakpoint
CREATE VIEW analytics.door_vs_bookings AS SELECT club_id, night_date, door_in, door_out, door_net, booked_pax, arrived_pax FROM analytics_src.door_vs_bookings WHERE NOT demo;
--> statement-breakpoint
CREATE VIEW analytics_demo.door_vs_bookings AS SELECT club_id, night_date, door_in, door_out, door_net, booked_pax, arrived_pax FROM analytics_src.door_vs_bookings WHERE demo;
--> statement-breakpoint
CREATE VIEW analytics.busyness_by_hour AS SELECT club_id, night_date, hour, door_net, checkins, crowd_rating_avg FROM analytics_src.busyness_by_hour WHERE NOT demo;
--> statement-breakpoint
CREATE VIEW analytics_demo.busyness_by_hour AS SELECT club_id, night_date, hour, door_net, checkins, crowd_rating_avg FROM analytics_src.busyness_by_hour WHERE demo;
--> statement-breakpoint
-- The read-only role. Guarded: an app user without CREATEROLE logs a notice and skips it
-- (infra/metabase/init-role.sh then creates it as the superuser and re-runs the grants).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro') THEN
    CREATE ROLE metabase_ro NOLOGIN;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'metabase_ro not created: run infra/metabase/init-role.sh as a superuser';
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'metabase_ro') THEN
    ALTER ROLE metabase_ro SET default_transaction_read_only = on;
    REVOKE ALL ON SCHEMA analytics_src FROM PUBLIC;
    GRANT USAGE ON SCHEMA analytics, analytics_demo TO metabase_ro;
    GRANT SELECT ON ALL TABLES IN SCHEMA analytics, analytics_demo TO metabase_ro;
  END IF;
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'metabase_ro grants skipped: run infra/metabase/init-role.sh as a superuser';
END $$;
