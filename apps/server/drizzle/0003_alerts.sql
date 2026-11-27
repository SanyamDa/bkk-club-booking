CREATE TABLE "alerts" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"level" text NOT NULL,
	"kind" text NOT NULL,
	"conversation_id" text,
	"booking_id" text,
	"text_en" text NOT NULL,
	"text_th" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	"sent_line_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "club_alert_settings" (
	"club_id" text PRIMARY KEY NOT NULL,
	"info_to_line" boolean DEFAULT false NOT NULL,
	"updated_by" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "alerts" ADD CONSTRAINT "alerts_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "club_alert_settings" ADD CONSTRAINT "club_alert_settings_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "alerts_club_created" ON "alerts" USING btree ("club_id","created_at");--> statement-breakpoint
CREATE INDEX "alerts_club_kind_open" ON "alerts" USING btree ("club_id","kind","resolved_at");