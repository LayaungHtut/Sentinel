CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"name" text NOT NULL,
	"key_hash" text NOT NULL,
	"prefix" text NOT NULL,
	"created_by" text,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "api_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"incident_id" text NOT NULL,
	"kind" text DEFAULT 'photo' NOT NULL,
	"mime" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"data" text NOT NULL,
	"caption" text,
	"uploaded_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "auth_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"org_id" text NOT NULL,
	"role" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_role_ck" CHECK ("memberships"."role" in ('reporter', 'coordinator', 'manager', 'admin'))
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" text PRIMARY KEY NOT NULL,
	"org_id" text NOT NULL,
	"incident_id" text,
	"escalation_id" text,
	"action_id" text,
	"contact_id" text,
	"channel" text NOT NULL,
	"to_address" text,
	"body" text NOT NULL,
	"status" text NOT NULL,
	"provider_message_id" text,
	"error" text,
	"ack_token_hash" text,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notifications_channel_ck" CHECK ("notifications"."channel" in ('sms', 'voice_call', 'email', 'slack', 'webhook')),
	CONSTRAINT "notifications_status_ck" CHECK ("notifications"."status" in ('queued', 'sent', 'delivered', 'failed', 'simulated', 'not_configured'))
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
INSERT INTO "organizations" ("id", "name", "slug", "is_demo")
SELECT 'org_legacy', 'Default organisation', 'default', true
WHERE EXISTS (SELECT 1 FROM "incidents") OR EXISTS (SELECT 1 FROM "contacts");
--> statement-breakpoint
CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"window_start" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"voice_consent_at" timestamp with time zone,
	"disabled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "facts" DROP CONSTRAINT "facts_basis_ck";--> statement-breakpoint
ALTER TABLE "facts" DROP CONSTRAINT "facts_source_ck";--> statement-breakpoint
DROP INDEX "incidents_code_uq";--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "org_id" text;--> statement-breakpoint
UPDATE "contacts" SET "org_id" = 'org_legacy' WHERE "org_id" IS NULL;--> statement-breakpoint
ALTER TABLE "contacts" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "phone" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "email" text;--> statement-breakpoint
ALTER TABLE "contacts" ADD COLUMN "on_call" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "facts" ADD COLUMN "source_ref" text;--> statement-breakpoint
ALTER TABLE "incidents" ADD COLUMN "org_id" text;--> statement-breakpoint
UPDATE "incidents" SET "org_id" = 'org_legacy' WHERE "org_id" IS NULL;--> statement-breakpoint
ALTER TABLE "incidents" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD COLUMN "chain_seq" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD COLUMN "prev_hash" text;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD COLUMN "hash" text;--> statement-breakpoint
ALTER TABLE "tool_invocations" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "stt_confidence" double precision;--> statement-breakpoint
ALTER TABLE "transcripts" ADD COLUMN "redacted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD COLUMN "org_id" text;--> statement-breakpoint
UPDATE "voice_sessions" SET "org_id" = 'org_legacy' WHERE "org_id" IS NULL;--> statement-breakpoint
ALTER TABLE "voice_sessions" ALTER COLUMN "org_id" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD COLUMN "user_id" text;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD COLUMN "consent_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD COLUMN "reconciled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD COLUMN "reconciliation" jsonb;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD COLUMN "provider_deleted_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "api_keys" ADD CONSTRAINT "api_keys_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "auth_sessions" ADD CONSTRAINT "auth_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "memberships" ADD CONSTRAINT "memberships_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_incident_idx" ON "attachments" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "auth_sessions_user_idx" ON "auth_sessions" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_user_org_uq" ON "memberships" USING btree ("user_id","org_id");--> statement-breakpoint
CREATE INDEX "notifications_incident_idx" ON "notifications" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "notifications_provider_idx" ON "notifications" USING btree ("provider_message_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree (lower("email"));--> statement-breakpoint
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incidents" ADD CONSTRAINT "incidents_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_org_code_uq" ON "incidents" USING btree ("org_id","code");--> statement-breakpoint
CREATE INDEX "incidents_org_idx" ON "incidents" USING btree ("org_id","reported_at");--> statement-breakpoint
UPDATE "timeline_events" t SET "chain_seq" = r.n
FROM (SELECT "id", row_number() OVER (PARTITION BY "incident_id" ORDER BY "occurred_at", "id") AS n FROM "timeline_events") r
WHERE t."id" = r."id";--> statement-breakpoint
CREATE UNIQUE INDEX "timeline_chain_uq" ON "timeline_events" USING btree ("incident_id","chain_seq");--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_basis_ck" CHECK ("facts"."basis" in ('stated', 'inferred', 'observed'));--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_source_ck" CHECK ("facts"."source_type" in ('voice_transcript', 'typed_message', 'operator_entry', 'agent_inference', 'system', 'demo_simulation', 'sensor'));--> statement-breakpoint
CREATE OR REPLACE FUNCTION sentinel_forbid_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	RAISE EXCEPTION 'append-only table %: % is not allowed', TG_TABLE_NAME, TG_OP USING ERRCODE = 'insufficient_privilege';
END
$$;--> statement-breakpoint
CREATE TRIGGER "timeline_events_append_only" BEFORE UPDATE OR DELETE ON "timeline_events" FOR EACH ROW EXECUTE FUNCTION sentinel_forbid_change();--> statement-breakpoint
CREATE TRIGGER "tool_invocations_append_only" BEFORE UPDATE OR DELETE ON "tool_invocations" FOR EACH ROW EXECUTE FUNCTION sentinel_forbid_change();--> statement-breakpoint
CREATE OR REPLACE FUNCTION sentinel_facts_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
	IF TG_OP = 'DELETE' THEN
		RAISE EXCEPTION 'facts are never deleted: supersede or retract them' USING ERRCODE = 'insufficient_privilege';
	END IF;
	IF NEW."incident_id" IS DISTINCT FROM OLD."incident_id"
		OR NEW."key" IS DISTINCT FROM OLD."key"
		OR NEW."value" IS DISTINCT FROM OLD."value"
		OR NEW."numeric_value" IS DISTINCT FROM OLD."numeric_value"
		OR NEW."unit" IS DISTINCT FROM OLD."unit"
		OR NEW."basis" IS DISTINCT FROM OLD."basis"
		OR NEW."source_type" IS DISTINCT FROM OLD."source_type"
		OR NEW."observed_at" IS DISTINCT FROM OLD."observed_at"
		OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
		RAISE EXCEPTION 'fact evidence fields are immutable: record a new fact that supersedes this one' USING ERRCODE = 'insufficient_privilege';
	END IF;
	RETURN NEW;
END
$$;--> statement-breakpoint
CREATE TRIGGER "facts_evidence_guard" BEFORE UPDATE OR DELETE ON "facts" FOR EACH ROW EXECUTE FUNCTION sentinel_facts_guard();
