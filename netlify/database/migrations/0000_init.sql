CREATE TABLE "actions" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"seq" integer NOT NULL,
	"title" text NOT NULL,
	"description" text,
	"priority" text DEFAULT 'normal' NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"owner" text,
	"contact_name" text,
	"contact_role" text,
	"requires_response" boolean DEFAULT false NOT NULL,
	"response_due_at" timestamp with time zone,
	"response_received_at" timestamp with time zone,
	"response_summary" text,
	"notification_status" text,
	"origin" text NOT NULL,
	"blocked_reason" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	CONSTRAINT "actions_status_ck" CHECK ("actions"."status" in ('pending', 'in_progress', 'completed', 'blocked', 'escalated', 'cancelled')),
	CONSTRAINT "actions_priority_ck" CHECK ("actions"."priority" in ('immediate', 'high', 'normal'))
);
--> statement-breakpoint
CREATE TABLE "contacts" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"role_label" text NOT NULL,
	"site" text,
	"organization" text NOT NULL,
	"is_demo" boolean DEFAULT true NOT NULL,
	"notification_channel" text DEFAULT 'none' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "escalations" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"seq" integer NOT NULL,
	"action_id" text,
	"level" integer DEFAULT 1 NOT NULL,
	"target_name" text NOT NULL,
	"target_role" text,
	"reason" text NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"simulated" boolean DEFAULT false NOT NULL,
	"notification_status" text NOT NULL,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "escalations_status_ck" CHECK ("escalations"."status" in ('open', 'acknowledged', 'resolved')),
	CONSTRAINT "escalations_trigger_ck" CHECK ("escalations"."trigger" in ('response_timeout', 'blocked_action', 'agent', 'operator'))
);
--> statement-breakpoint
CREATE TABLE "facts" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"category" text NOT NULL,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"value" text NOT NULL,
	"numeric_value" double precision,
	"unit" text,
	"certainty" text NOT NULL,
	"basis" text NOT NULL,
	"needs_verification" boolean DEFAULT false NOT NULL,
	"verification" text DEFAULT 'unverified' NOT NULL,
	"status" text DEFAULT 'current' NOT NULL,
	"supersedes_id" text,
	"superseded_by_id" text,
	"source_type" text NOT NULL,
	"transcript_id" text,
	"evidence_quote" text,
	"quote_matched" boolean,
	"speaker" text,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"confirmed_at" timestamp with time zone,
	"confirmation_note" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "facts_category_ck" CHECK ("facts"."category" in ('location', 'timing', 'measurement', 'impact', 'equipment', 'people', 'mitigation', 'other')),
	CONSTRAINT "facts_certainty_ck" CHECK ("facts"."certainty" in ('exact', 'approximate')),
	CONSTRAINT "facts_basis_ck" CHECK ("facts"."basis" in ('stated', 'inferred')),
	CONSTRAINT "facts_verification_ck" CHECK ("facts"."verification" in ('unverified', 'confirmed', 'disputed')),
	CONSTRAINT "facts_status_ck" CHECK ("facts"."status" in ('current', 'superseded', 'retracted')),
	CONSTRAINT "facts_source_ck" CHECK ("facts"."source_type" in ('voice_transcript', 'typed_message', 'operator_entry', 'agent_inference', 'system', 'demo_simulation'))
);
--> statement-breakpoint
CREATE TABLE "incidents" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"title" text NOT NULL,
	"type" text NOT NULL,
	"location" text,
	"summary" text,
	"status" text DEFAULT 'new' NOT NULL,
	"severity" text,
	"severity_override" text,
	"severity_override_reason" text,
	"reported_at" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"started_at_precision" text DEFAULT 'unknown' NOT NULL,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"resolution_summary" text,
	"is_demo" boolean DEFAULT false NOT NULL,
	"scenario" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "incidents_status_ck" CHECK ("incidents"."status" in ('new', 'assessing', 'active', 'mitigating', 'monitoring', 'escalated', 'blocked', 'resolved', 'closed')),
	CONSTRAINT "incidents_type_ck" CHECK ("incidents"."type" in ('refrigeration_failure', 'pos_outage', 'it_outage', 'equipment_failure', 'power_outage', 'water_leak', 'damaged_shipment', 'guest_safety', 'fire_safety', 'other')),
	CONSTRAINT "incidents_severity_ck" CHECK ("incidents"."severity" is null or "incidents"."severity" in ('low', 'medium', 'high', 'critical')),
	CONSTRAINT "incidents_severity_override_ck" CHECK ("incidents"."severity_override" is null or "incidents"."severity_override" in ('low', 'medium', 'high', 'critical'))
);
--> statement-breakpoint
CREATE TABLE "info_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"key" text NOT NULL,
	"question" text NOT NULL,
	"priority" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"origin" text NOT NULL,
	"answered_fact_id" text,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"resolved_at" timestamp with time zone,
	CONSTRAINT "info_requests_priority_ck" CHECK ("info_requests"."priority" in ('critical', 'important', 'optional')),
	CONSTRAINT "info_requests_status_ck" CHECK ("info_requests"."status" in ('open', 'answered', 'unavailable', 'not_applicable'))
);
--> statement-breakpoint
CREATE TABLE "reports" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"version" integer NOT NULL,
	"content" jsonb NOT NULL,
	"markdown" text NOT NULL,
	"generated_by" text NOT NULL,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_events" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text NOT NULL,
	"event_type" text NOT NULL,
	"description" text NOT NULL,
	"source" text NOT NULL,
	"actor" text,
	"tool_name" text,
	"ref_type" text,
	"ref_id" text,
	"metadata" jsonb,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tool_invocations" (
	"id" text PRIMARY KEY NOT NULL,
	"voice_session_id" text,
	"incident_id" text,
	"call_id" text,
	"tool_name" text NOT NULL,
	"origin" text NOT NULL,
	"arguments" jsonb,
	"result" jsonb,
	"ok" boolean NOT NULL,
	"error" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "transcripts" (
	"id" text PRIMARY KEY NOT NULL,
	"voice_session_id" text,
	"incident_id" text,
	"speaker" text NOT NULL,
	"text" text NOT NULL,
	"channel" text DEFAULT 'voice' NOT NULL,
	"provider_item_id" text,
	"interrupted" boolean DEFAULT false NOT NULL,
	"offset_ms" integer,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "voice_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"incident_id" text,
	"provider_session_id" text,
	"status" text DEFAULT 'connecting' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"scenario" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ready_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "actions" ADD CONSTRAINT "actions_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "escalations" ADD CONSTRAINT "escalations_action_id_actions_id_fk" FOREIGN KEY ("action_id") REFERENCES "public"."actions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "facts" ADD CONSTRAINT "facts_transcript_id_transcripts_id_fk" FOREIGN KEY ("transcript_id") REFERENCES "public"."transcripts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "info_requests" ADD CONSTRAINT "info_requests_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reports" ADD CONSTRAINT "reports_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_events" ADD CONSTRAINT "timeline_events_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_voice_session_id_voice_sessions_id_fk" FOREIGN KEY ("voice_session_id") REFERENCES "public"."voice_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "transcripts" ADD CONSTRAINT "transcripts_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "voice_sessions" ADD CONSTRAINT "voice_sessions_incident_id_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."incidents"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "actions_seq_uq" ON "actions" USING btree ("incident_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "escalations_seq_uq" ON "escalations" USING btree ("incident_id","seq");--> statement-breakpoint
CREATE UNIQUE INDEX "escalations_action_timeout_uq" ON "escalations" USING btree ("action_id") WHERE "escalations"."trigger" = 'response_timeout';--> statement-breakpoint
CREATE INDEX "facts_incident_idx" ON "facts" USING btree ("incident_id");--> statement-breakpoint
CREATE UNIQUE INDEX "facts_current_key_uq" ON "facts" USING btree ("incident_id","key") WHERE "facts"."status" = 'current';--> statement-breakpoint
CREATE UNIQUE INDEX "incidents_code_uq" ON "incidents" USING btree ("code");--> statement-breakpoint
CREATE INDEX "incidents_created_idx" ON "incidents" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "info_requests_key_uq" ON "info_requests" USING btree ("incident_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "reports_version_uq" ON "reports" USING btree ("incident_id","version");--> statement-breakpoint
CREATE INDEX "timeline_incident_idx" ON "timeline_events" USING btree ("incident_id","occurred_at");--> statement-breakpoint
CREATE INDEX "tool_invocations_incident_idx" ON "tool_invocations" USING btree ("incident_id");--> statement-breakpoint
CREATE INDEX "transcripts_incident_idx" ON "transcripts" USING btree ("incident_id","received_at");--> statement-breakpoint
CREATE INDEX "transcripts_session_idx" ON "transcripts" USING btree ("voice_session_id");