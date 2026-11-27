CREATE TABLE "guest_notes" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"guest_id" text NOT NULL,
	"text" text NOT NULL,
	"author_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guest_tags" (
	"guest_id" text NOT NULL,
	"club_id" text NOT NULL,
	"tag" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guest_tags_guest_id_tag_pk" PRIMARY KEY("guest_id","tag")
);
--> statement-breakpoint
CREATE TABLE "promoter_attributions" (
	"booking_id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"promoter_id" text NOT NULL,
	"via" text NOT NULL,
	"attributed_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "promoters" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"user_id" text,
	"commission_bps" integer DEFAULT 0 NOT NULL,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "guest_notes" ADD CONSTRAINT "guest_notes_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_notes" ADD CONSTRAINT "guest_notes_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_tags" ADD CONSTRAINT "guest_tags_guest_id_guests_id_fk" FOREIGN KEY ("guest_id") REFERENCES "public"."guests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guest_tags" ADD CONSTRAINT "guest_tags_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promoter_attributions" ADD CONSTRAINT "promoter_attributions_booking_id_bookings_id_fk" FOREIGN KEY ("booking_id") REFERENCES "public"."bookings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promoter_attributions" ADD CONSTRAINT "promoter_attributions_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promoter_attributions" ADD CONSTRAINT "promoter_attributions_promoter_id_promoters_id_fk" FOREIGN KEY ("promoter_id") REFERENCES "public"."promoters"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promoters" ADD CONSTRAINT "promoters_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "promoters" ADD CONSTRAINT "promoters_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "guest_notes_guest" ON "guest_notes" USING btree ("guest_id");--> statement-breakpoint
CREATE INDEX "guest_tags_club_tag" ON "guest_tags" USING btree ("club_id","tag");--> statement-breakpoint
CREATE INDEX "promoter_attributions_club_promoter" ON "promoter_attributions" USING btree ("club_id","promoter_id");--> statement-breakpoint
CREATE UNIQUE INDEX "promoters_club_code" ON "promoters" USING btree ("club_id","code");