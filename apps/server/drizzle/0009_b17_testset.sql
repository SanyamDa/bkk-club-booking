CREATE TABLE "brain_test_cases" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"question" text NOT NULL,
	"lang" text NOT NULL,
	"kind" text NOT NULL,
	"reference" text,
	"must_not_contain" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"source_note_id" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "brain_test_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"club_id" text NOT NULL,
	"trigger" text NOT NULL,
	"snapshot_version" integer,
	"model" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"passed" integer DEFAULT 0 NOT NULL,
	"score" real,
	"results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "brain_test_cases" ADD CONSTRAINT "brain_test_cases_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "brain_test_runs" ADD CONSTRAINT "brain_test_runs_club_id_clubs_id_fk" FOREIGN KEY ("club_id") REFERENCES "public"."clubs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "brain_test_cases_club_question" ON "brain_test_cases" USING btree ("club_id","question");--> statement-breakpoint
CREATE INDEX "brain_test_runs_club_status" ON "brain_test_runs" USING btree ("club_id","status");