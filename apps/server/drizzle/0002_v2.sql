CREATE TABLE "nights" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"date" text NOT NULL,
	"status" text NOT NULL,
	"closed_reason" text,
	"event_type" text,
	"event_name" text,
	"lineup" jsonb,
	"notes" text,
	"edited_by" text
);
--> statement-breakpoint
CREATE TABLE "pos_bills" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"booking_id" text,
	"provider_bill_id" text,
	"table_code" text,
	"covers" integer,
	"opened_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"total_satang" integer,
	"synced_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "price_rules" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"scope" text NOT NULL,
	"scope_id" text,
	"weekday" integer,
	"night_id" text,
	"min_spend_satang" integer NOT NULL,
	"deposit_satang" integer NOT NULL,
	"priority" integer DEFAULT 0 NOT NULL,
	"valid_from" date,
	"valid_to" date
);
--> statement-breakpoint
CREATE TABLE "channels" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"kind" text NOT NULL,
	"external_id" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"connected_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "club_credentials" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"kind" text NOT NULL,
	"ciphertext" text NOT NULL,
	"key_ref" text NOT NULL,
	"last4" text,
	"set_by" text,
	"set_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "club_memberships" (
	"user_id" text NOT NULL,
	"club_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "club_memberships_user_id_club_id_pk" PRIMARY KEY("user_id","club_id")
);
--> statement-breakpoint
CREATE TABLE "club_profile" (
	"club_id" text PRIMARY KEY NOT NULL,
	"capacity_standing" integer,
	"capacity_seated" integer,
	"lat" double precision,
	"lng" double precision,
	"district" text,
	"venue_type" text,
	"genres" text[],
	"price_band" text,
	"opening_hours" jsonb,
	"usual_peak_hour" integer,
	"licence_type" text,
	"crowd_mix" text,
	"guestlist_offered" boolean,
	"pos_vendor" text,
	"go_live_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "invites" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_by" text,
	CONSTRAINT "invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "platform_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id_hash" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "support_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"club_id" text NOT NULL,
	"reason" text NOT NULL,
	"ticket_ref" text,
	"mode" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"ip" text
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text,
	"platform_role" text,
	"totp_secret" text,
	"failed_login_count" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "booking_status_history" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text NOT NULL,
	"from_status" text,
	"to_status" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"reason_code" text
);
--> statement-breakpoint
CREATE TABLE "calendar_days" (
	"date" date NOT NULL,
	"kind" text NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	CONSTRAINT "calendar_days_date_kind_name_pk" PRIMARY KEY("date","kind","name")
);
--> statement-breakpoint
CREATE TABLE "crowd_ratings" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"night_date" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"level" integer NOT NULL,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "door_counts" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"night_date" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"delta" integer NOT NULL,
	"kind" text NOT NULL,
	"user_id" text
);
--> statement-breakpoint
CREATE TABLE "events" (
	"seq" bigserial NOT NULL,
	"id" text PRIMARY KEY NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"club_id" text NOT NULL,
	"type" text NOT NULL,
	"v" integer DEFAULT 1 NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text,
	"channel" text,
	"data_origin" text NOT NULL,
	"source" text,
	"guest_id" text,
	"person_id" text,
	"conversation_id" text,
	"booking_id" text,
	"table_id" text,
	"zone_id" text,
	"night_date" text,
	"attempt_id" text,
	"cause_id" text,
	"lang" text,
	"props" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"raw" jsonb,
	"is_test" boolean DEFAULT false NOT NULL,
	"dedupe_key" text,
	CONSTRAINT "events_seq_unique" UNIQUE("seq")
);
--> statement-breakpoint
CREATE TABLE "events_dead_letter" (
	"id" text PRIMARY KEY NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL,
	"error" text NOT NULL
);
--> statement-breakpoint
CREATE TABLE "handoff_episodes" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"conversation_id" text NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone,
	"trigger" text NOT NULL,
	"reason" text,
	"resolver_user_id" text,
	"first_message_id" text,
	"last_message_id" text,
	"ended_by" text,
	"topic" text,
	"matched_note_id" text
);
--> statement-breakpoint
CREATE TABLE "identity_map" (
	"person_id" text NOT NULL,
	"club_id" text NOT NULL,
	"guest_id" text NOT NULL,
	"platform_line_sub" text,
	"phone_hash" text,
	"first_linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notices" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"guest_id" text NOT NULL,
	"purpose" text NOT NULL,
	"text_version" text NOT NULL,
	"channel" text NOT NULL,
	"shown_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "occupancy_snapshots" (
	"club_id" text NOT NULL,
	"night_date" text NOT NULL,
	"taken_at" timestamp with time zone NOT NULL,
	"lead_bucket" text NOT NULL,
	"tables_active" integer NOT NULL,
	"tables_held" integer NOT NULL,
	"tables_confirmed" integer NOT NULL,
	"tables_arrived" integer NOT NULL,
	"pax_booked" integer NOT NULL,
	"min_spend_booked_satang" integer NOT NULL,
	"deposits_verified_satang" integer NOT NULL,
	CONSTRAINT "occupancy_snapshots_club_id_night_date_taken_at_pk" PRIMARY KEY("club_id","night_date","taken_at")
);
--> statement-breakpoint
CREATE TABLE "ops_events" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text,
	"kind" text NOT NULL,
	"detail" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "raw_webhooks" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text,
	"channel" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"body" jsonb NOT NULL,
	"signature_ok" boolean NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "removal_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"guest_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"channel" text NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" text
);
--> statement-breakpoint
CREATE TABLE "brain_note_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"note_id" text NOT NULL,
	"body_md" text NOT NULL,
	"edited_by" text,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"slug" text NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"body_md" text NOT NULL,
	"frontmatter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"source_episode_id" text,
	"approved_by" text,
	"approved_at" timestamp with time zone,
	"valid_from" date,
	"valid_until" date,
	"review_by" date,
	"supersedes_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_snapshots" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"version" integer NOT NULL,
	"compiled_text" text NOT NULL,
	"token_count" integer NOT NULL,
	"hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_log" ALTER COLUMN "club_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ALTER COLUMN "staff_link_code" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_type" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "actor_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "session_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "support_grant_id" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "reason" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "ip" text;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "before" jsonb;--> statement-breakpoint
ALTER TABLE "audit_log" ADD COLUMN "after" jsonb;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "occasion" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "arrived_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "arrived_pax" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "cancel_reason_code" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "no_show_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "released_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "running_late_minutes" integer;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "attempt_id" text;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "reminder_sent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "bookings" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "staff_link_code_hash" text;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "staff_link_code_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "pending_staff_group_id" text;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "status" text DEFAULT 'onboarding' NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "bot_paused" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "bot_paused_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "created_by" text;--> statement-breakpoint
UPDATE "clubs" SET "status" = 'demo' WHERE "id" = 'club_demo';--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "external_ref" text;--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "club_id" text;--> statement-breakpoint
UPDATE "deposits" SET "club_id" = "bookings"."club_id" FROM "bookings" WHERE "bookings"."id" = "deposits"."booking_id";--> statement-breakpoint
ALTER TABLE "deposits" ALTER COLUMN "club_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "slip_trans_ref" text;--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "slip_amount_satang" integer;--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "slip_receiver" text;--> statement-breakpoint
ALTER TABLE "deposits" ADD COLUMN "slip_time" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "birth_date" date;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "channel_id" text;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "external_user_id" text;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "is_test" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "author_type" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "author_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "channel_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "occurred_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "sent_via" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "delivery_status" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "error" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "external_id" text;--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "processed_at" timestamp with time zone;--> statement-breakpoint
UPDATE "messages" SET "processed_at" = "created_at";--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "floor_x" real;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "floor_y" real;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "shape" text;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "valid_from" date;--> statement-breakpoint
ALTER TABLE "tables" ADD COLUMN "valid_to" date;--> statement-breakpoint
ALTER TABLE "nights" ADD CONSTRAINT "nights_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_bills" ADD CONSTRAINT "pos_bills_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pos_bills" ADD CONSTRAINT "pos_bills_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "price_rules" ADD CONSTRAINT "price_rules_night_id_nights_id_fk" FOREIGN KEY ("night_id") REFERENCES "public"."nights"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "channels" ADD CONSTRAINT "channels_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_credentials" ADD CONSTRAINT "club_credentials_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_memberships" ADD CONSTRAINT "club_memberships_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_profile" ADD CONSTRAINT "club_profile_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invites" ADD CONSTRAINT "invites_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "support_grants" ADD CONSTRAINT "support_grants_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_status_history" ADD CONSTRAINT "booking_status_history_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "crowd_ratings" ADD CONSTRAINT "crowd_ratings_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "door_counts" ADD CONSTRAINT "door_counts_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_episodes" ADD CONSTRAINT "handoff_episodes_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_episodes" ADD CONSTRAINT "handoff_episodes_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_episodes" ADD CONSTRAINT "handoff_episodes_first_message_id_messages_id_fk" FOREIGN KEY ("first_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "handoff_episodes" ADD CONSTRAINT "handoff_episodes_last_message_id_messages_id_fk" FOREIGN KEY ("last_message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_map" ADD CONSTRAINT "identity_map_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "identity_map" ADD CONSTRAINT "identity_map_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notices" ADD CONSTRAINT "notices_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "occupancy_snapshots" ADD CONSTRAINT "occupancy_snapshots_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "raw_webhooks" ADD CONSTRAINT "raw_webhooks_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "removal_requests" ADD CONSTRAINT "removal_requests_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "removal_requests" ADD CONSTRAINT "removal_requests_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_note_versions" ADD CONSTRAINT "brain_note_versions_note_id_brain_notes_id_fk" FOREIGN KEY ("note_id") REFERENCES "public"."brain_notes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_notes" ADD CONSTRAINT "brain_notes_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_snapshots" ADD CONSTRAINT "brain_snapshots_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "nights_club_date" ON "nights" USING btree ("club_id","date");--> statement-breakpoint
CREATE INDEX "pos_bills_club" ON "pos_bills" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "price_rules_club" ON "price_rules" USING btree ("club_id");--> statement-breakpoint
CREATE UNIQUE INDEX "channels_club_kind" ON "channels" USING btree ("club_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "club_credentials_club_kind" ON "club_credentials" USING btree ("club_id","kind");--> statement-breakpoint
CREATE INDEX "sessions_user" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "support_grants_user_club" ON "support_grants" USING btree ("user_id","club_id");--> statement-breakpoint
CREATE INDEX "booking_status_history_booking" ON "booking_status_history" USING btree ("booking_id","at");--> statement-breakpoint
CREATE INDEX "crowd_ratings_club_night" ON "crowd_ratings" USING btree ("club_id","night_date");--> statement-breakpoint
CREATE INDEX "door_counts_club_night" ON "door_counts" USING btree ("club_id","night_date");--> statement-breakpoint
CREATE UNIQUE INDEX "events_club_dedupe" ON "events" USING btree ("club_id","dedupe_key");--> statement-breakpoint
CREATE INDEX "events_club_occurred" ON "events" USING btree ("club_id","occurred_at");--> statement-breakpoint
CREATE INDEX "events_booking" ON "events" USING btree ("booking_id");--> statement-breakpoint
CREATE INDEX "handoff_episodes_club_conv" ON "handoff_episodes" USING btree ("club_id","conversation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "identity_map_club_guest" ON "identity_map" USING btree ("club_id","guest_id");--> statement-breakpoint
CREATE INDEX "identity_map_person" ON "identity_map" USING btree ("person_id");--> statement-breakpoint
CREATE INDEX "identity_map_sub" ON "identity_map" USING btree ("platform_line_sub");--> statement-breakpoint
CREATE INDEX "notices_club_guest" ON "notices" USING btree ("club_id","guest_id");--> statement-breakpoint
CREATE INDEX "ops_events_club_at" ON "ops_events" USING btree ("club_id","at");--> statement-breakpoint
CREATE INDEX "raw_webhooks_club_received" ON "raw_webhooks" USING btree ("club_id","received_at");--> statement-breakpoint
CREATE INDEX "removal_requests_club" ON "removal_requests" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "brain_note_versions_note" ON "brain_note_versions" USING btree ("note_id");--> statement-breakpoint
CREATE INDEX "brain_notes_club_status" ON "brain_notes" USING btree ("club_id","status");--> statement-breakpoint
CREATE INDEX "brain_notes_club_slug" ON "brain_notes" USING btree ("club_id","slug");--> statement-breakpoint
CREATE UNIQUE INDEX "brain_snapshots_club_version" ON "brain_snapshots" USING btree ("club_id","version");--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "deposits_club_slip_trans_ref" ON "deposits" USING btree ("club_id","slip_trans_ref");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_club_external_id" ON "messages" USING btree ("club_id","external_id");--> statement-breakpoint
-- Every existing club gets its kind = 'line' row in channels.
INSERT INTO "channels" ("id", "club_id", "kind", "status") SELECT 'chan_line_' || "id", "id", 'line', 'pending' FROM "clubs" ON CONFLICT DO NOTHING;