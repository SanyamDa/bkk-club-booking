CREATE TABLE "audit_log" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"actor" text NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" text NOT NULL,
	"data" jsonb,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bookings" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"ref_code" text NOT NULL,
	"guest_id" text NOT NULL,
	"table_id" text NOT NULL,
	"night_date" text NOT NULL,
	"pax" integer NOT NULL,
	"status" text NOT NULL,
	"source" text NOT NULL,
	"hold_expires_at" timestamp with time zone,
	"min_spend_satang" integer NOT NULL,
	"deposit_satang" integer NOT NULL,
	"rules_version" text,
	"rules_accepted_at" timestamp with time zone,
	"special_request" text,
	"notes" text,
	"status_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "bookings_ref_code_unique" UNIQUE("ref_code")
);
--> statement-breakpoint
CREATE TABLE "clubs" (
	"id" text PRIMARY KEY NOT NULL,
	"slug" text NOT NULL,
	"name" text NOT NULL,
	"settings" jsonb NOT NULL,
	"line_channel_secret_env" text,
	"line_access_token_env" text,
	"liff_id" text,
	"promptpay_id" text,
	"promptpay_name" text,
	"staff_group_id" text,
	"staff_link_code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clubs_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"guest_id" text NOT NULL,
	"mode" text DEFAULT 'bot' NOT NULL,
	"state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"handoff_requested_at" timestamp with time zone,
	"handoff_reason" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deposits" (
	"id" text PRIMARY KEY NOT NULL,
	"booking_id" text NOT NULL,
	"amount_satang" integer NOT NULL,
	"method" text NOT NULL,
	"status" text NOT NULL,
	"slip_path" text,
	"slip_received_at" timestamp with time zone,
	"verified_by" text,
	"verified_at" timestamp with time zone,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guests" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"line_user_id" text,
	"display_name" text,
	"name" text,
	"phone" text,
	"nationality" text,
	"lang" text DEFAULT 'en' NOT NULL,
	"consent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"guest_id" text,
	"target" text,
	"direction" text NOT NULL,
	"kind" text NOT NULL,
	"payload" jsonb NOT NULL,
	"line_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tables" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"zone_id" text NOT NULL,
	"code" text NOT NULL,
	"min_pax" integer NOT NULL,
	"max_pax" integer NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"min_spend_satang" integer,
	"deposit_satang" integer,
	"active" boolean DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE TABLE "zones" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"name" text NOT NULL,
	"name_th" text NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"min_spend_satang" integer NOT NULL,
	"deposit_satang" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bookings" ADD CONSTRAINT "bookings_table_id_tables_id_fk" FOREIGN KEY ("table_id") REFERENCES "public"."tables"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "deposits" ADD CONSTRAINT "deposits_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guests" ADD CONSTRAINT "guests_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tables" ADD CONSTRAINT "tables_zone_id_zones_id_fk" FOREIGN KEY ("zone_id") REFERENCES "public"."zones"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "zones" ADD CONSTRAINT "zones_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_entity" ON "audit_log" USING btree ("entity","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "bookings_one_active_per_table_night" ON "bookings" USING btree ("table_id","night_date") WHERE "bookings"."status" in ('held','awaiting_payment','payment_review','confirmed','arrived');--> statement-breakpoint
CREATE INDEX "bookings_club_night" ON "bookings" USING btree ("club_id","night_date");--> statement-breakpoint
CREATE INDEX "bookings_guest" ON "bookings" USING btree ("guest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_guest" ON "conversations" USING btree ("guest_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guests_club_line_user" ON "guests" USING btree ("club_id","line_user_id");--> statement-breakpoint
CREATE INDEX "messages_guest_time" ON "messages" USING btree ("guest_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_line_message_id" ON "messages" USING btree ("club_id","line_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tables_club_code" ON "tables" USING btree ("club_id","code");