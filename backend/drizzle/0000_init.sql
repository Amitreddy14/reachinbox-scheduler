CREATE TYPE "public"."campaign_status" AS ENUM('ACTIVE', 'COMPLETED', 'CANCELLED');--> statement-breakpoint
CREATE TYPE "public"."email_status" AS ENUM('SCHEDULED', 'QUEUED', 'SENDING', 'SENT', 'FAILED', 'CANCELLED');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"body_text" text NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"delay_ms" integer NOT NULL,
	"hourly_limit" integer NOT NULL,
	"total_recipients" integer NOT NULL,
	"status" "campaign_status" DEFAULT 'ACTIVE' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"campaign_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"sender_id" uuid NOT NULL,
	"to_email" text NOT NULL,
	"subject" text NOT NULL,
	"body_html" text NOT NULL,
	"body_text" text NOT NULL,
	"status" "email_status" DEFAULT 'SCHEDULED' NOT NULL,
	"scheduled_at" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"sequence" integer NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"message_id" text,
	"preview_url" text,
	"queue_job_id" text NOT NULL,
	"defer_count" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "senders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"display_name" text NOT NULL,
	"smtp_host" text NOT NULL,
	"smtp_port" integer NOT NULL,
	"smtp_secure" boolean DEFAULT false NOT NULL,
	"smtp_user" text NOT NULL,
	"smtp_password" text NOT NULL,
	"hourly_limit" integer,
	"min_gap_ms" integer,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "slack_integrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"team_id" text NOT NULL,
	"team_name" text NOT NULL,
	"channel_id" text,
	"channel_name" text,
	"webhook_url" text,
	"bot_token" text,
	"scope" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"google_id" text NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"avatar_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "campaigns" ADD CONSTRAINT "campaigns_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_jobs" ADD CONSTRAINT "email_jobs_campaign_id_campaigns_id_fk" FOREIGN KEY ("campaign_id") REFERENCES "public"."campaigns"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_jobs" ADD CONSTRAINT "email_jobs_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_jobs" ADD CONSTRAINT "email_jobs_sender_id_senders_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."senders"("id") ON DELETE restrict ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "senders" ADD CONSTRAINT "senders_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "slack_integrations" ADD CONSTRAINT "slack_integrations_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "campaigns_user_created_idx" ON "campaigns" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_jobs_queue_job_id_key" ON "email_jobs" USING btree ("queue_job_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_jobs_user_status_idx" ON "email_jobs" USING btree ("user_id","status","scheduled_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_jobs_campaign_sequence_idx" ON "email_jobs" USING btree ("campaign_id","sequence");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_jobs_sender_status_idx" ON "email_jobs" USING btree ("sender_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "senders_user_email_key" ON "senders" USING btree ("user_id","email");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "senders_user_active_idx" ON "senders" USING btree ("user_id","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "slack_integrations_user_key" ON "slack_integrations" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_google_id_key" ON "users" USING btree ("google_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "users_email_key" ON "users" USING btree ("email");