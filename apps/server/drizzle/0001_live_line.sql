ALTER TABLE "clubs" ADD COLUMN "line_login_channel_id_env" text;--> statement-breakpoint
ALTER TABLE "clubs" ADD COLUMN "line_login_channel_secret_env" text;--> statement-breakpoint
ALTER TABLE "guests" ADD COLUMN "unfollowed_at" timestamp with time zone;