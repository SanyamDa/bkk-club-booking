CREATE TABLE "staff_groups" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"line_group_id" text NOT NULL,
	"purpose" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "staff_link_code_purpose" text;--> statement-breakpoint
ALTER TABLE "staff_groups" ADD CONSTRAINT "staff_groups_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "staff_groups_club_purpose" ON "staff_groups" USING btree ("club_id","purpose");