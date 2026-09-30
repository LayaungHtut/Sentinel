ALTER TABLE "actions" ADD COLUMN "reason_fact_id" text;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD COLUMN "reconnects" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD COLUMN "error_count" integer DEFAULT 0 NOT NULL;