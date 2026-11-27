CREATE TABLE "booking_preorders" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"booking_id" text NOT NULL,
	"menu_item_id" text NOT NULL,
	"qty" integer NOT NULL,
	"unit_price_satang" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "menu_items" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"name" text NOT NULL,
	"name_th" text NOT NULL,
	"price_satang" integer NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"sort" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "waitlist_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"guest_id" text NOT NULL,
	"night_date" text NOT NULL,
	"pax_range" text NOT NULL,
	"status" text DEFAULT 'waiting' NOT NULL,
	"offered_at" timestamp with time zone,
	"offer_expires_at" timestamp with time zone,
	"booking_id" text,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "booking_preorders" ADD CONSTRAINT "booking_preorders_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_preorders" ADD CONSTRAINT "booking_preorders_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "booking_preorders" ADD CONSTRAINT "booking_preorders_menu_item_id_menu_items_id_fk" FOREIGN KEY ("menu_item_id") REFERENCES "public"."menu_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "menu_items" ADD CONSTRAINT "menu_items_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "waitlist_entries" ADD CONSTRAINT "waitlist_entries_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "booking_preorders_booking_item" ON "booking_preorders" USING btree ("booking_id","menu_item_id");--> statement-breakpoint
CREATE INDEX "booking_preorders_club" ON "booking_preorders" USING btree ("club_id");--> statement-breakpoint
CREATE INDEX "menu_items_club" ON "menu_items" USING btree ("club_id");--> statement-breakpoint
CREATE UNIQUE INDEX "waitlist_one_open_per_guest_night" ON "waitlist_entries" USING btree ("guest_id","night_date") WHERE "waitlist_entries"."status" in ('waiting','offered');--> statement-breakpoint
CREATE INDEX "waitlist_club_night" ON "waitlist_entries" USING btree ("club_id","night_date");