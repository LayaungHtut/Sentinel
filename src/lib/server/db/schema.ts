import {
	boolean,
	check,
	customType,
	doublePrecision,
	index,
	integer,
	jsonb,
	pgTable,
	text,
	timestamp,
	uniqueIndex
} from 'drizzle-orm/pg-core';
import { sql, type SQL } from 'drizzle-orm';
import {
	ACTION_PRIORITIES,
	ACTION_STATUSES,
	ESCALATION_STATUSES,
	ESCALATION_TRIGGERS,
	FACT_BASES,
	FACT_CATEGORIES,
	FACT_CERTAINTIES,
	FACT_STATUSES,
	FACT_VERIFICATIONS,
	INCIDENT_STATUSES,
	INCIDENT_TYPES,
	INFO_PRIORITIES,
	INFO_STATUSES,
	NOTIFICATION_CHANNELS,
	NOTIFICATION_STATES,
	SEVERITIES,
	SOURCE_TYPES,
	USER_ROLES
} from '../../domain/types';
import { decrypt, encrypt } from './crypto';

/** CHECK (col IN (...)) — enforces domain enums at the database layer too. */
const oneOf = (col: SQL | import('drizzle-orm/pg-core').AnyPgColumn, values: readonly string[]) =>
	sql`${col} in (${sql.raw(values.map((v) => `'${v}'`).join(', '))})`;

const id = () =>
	text('id')
		.primaryKey()
		.$defaultFn(() => crypto.randomUUID());
const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const createdAt = () => ts('created_at').notNull().defaultNow();

/** Text encrypted at rest when DATA_ENCRYPTION_KEY is set (transparent through the ORM). */
const encryptedText = customType<{ data: string; driverData: string }>({
	dataType: () => 'text',
	toDriver: (v) => encrypt(v),
	fromDriver: (v) => decrypt(v)
});

// ─── Identity & tenancy ──────────────────────────────────────────────────────

export const organizations = pgTable('organizations', {
	id: id(),
	name: text('name').notNull(),
	slug: text('slug').notNull().unique(),
	/** Demo orgs get compressed timers and simulated external actors. */
	isDemo: boolean('is_demo').notNull().default(false),
	/** Operational policy: response timeout, escalation chain, retention, voice caps. */
	settings: jsonb('settings').$type<Record<string, unknown>>().notNull().default({}),
	createdAt: createdAt()
});

export const users = pgTable(
	'users',
	{
		id: id(),
		email: text('email').notNull(),
		name: text('name').notNull(),
		passwordHash: text('password_hash'),
		/** Set when the user accepted the recording/transcription notice. */
		voiceConsentAt: ts('voice_consent_at'),
		disabledAt: ts('disabled_at'),
		createdAt: createdAt()
	},
	(t) => [uniqueIndex('users_email_uq').on(sql`lower(${t.email})`)]
);

export const memberships = pgTable(
	'memberships',
	{
		id: id(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		role: text('role').notNull(),
		createdAt: createdAt()
	},
	(t) => [
		uniqueIndex('memberships_user_org_uq').on(t.userId, t.orgId),
		check('memberships_role_ck', oneOf(t.role, USER_ROLES))
	]
);

export const authSessions = pgTable(
	'auth_sessions',
	{
		/** sha256 of the cookie token; the token itself is never stored. */
		id: text('id').primaryKey(),
		userId: text('user_id')
			.notNull()
			.references(() => users.id, { onDelete: 'cascade' }),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		expiresAt: ts('expires_at').notNull(),
		createdAt: createdAt()
	},
	(t) => [index('auth_sessions_user_idx').on(t.userId)]
);

/** Machine credentials (sensors, integrations). Stored hashed; shown once. */
export const apiKeys = pgTable('api_keys', {
	id: id(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	keyHash: text('key_hash').notNull().unique(),
	prefix: text('prefix').notNull(),
	createdBy: text('created_by'),
	lastUsedAt: ts('last_used_at'),
	revokedAt: ts('revoked_at'),
	createdAt: createdAt()
});

// ─── Incidents ───────────────────────────────────────────────────────────────

export const incidents = pgTable(
	'incidents',
	{
		id: id(),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		code: text('code').notNull(),
		title: text('title').notNull(),
		type: text('type').notNull(),
		location: text('location'),
		summary: text('summary'),
		status: text('status').notNull().default('new'),
		severity: text('severity'),
		severityOverride: text('severity_override'),
		severityOverrideReason: text('severity_override_reason'),
		reportedAt: ts('reported_at').notNull(),
		startedAt: ts('started_at'),
		startedAtPrecision: text('started_at_precision').notNull().default('unknown'),
		resolvedAt: ts('resolved_at'),
		closedAt: ts('closed_at'),
		resolutionSummary: text('resolution_summary'),
		isDemo: boolean('is_demo').notNull().default(false),
		scenario: text('scenario'),
		createdAt: createdAt(),
		updatedAt: ts('updated_at').notNull().defaultNow()
	},
	(t) => [
		uniqueIndex('incidents_org_code_uq').on(t.orgId, t.code),
		index('incidents_org_idx').on(t.orgId, t.reportedAt),
		index('incidents_created_idx').on(t.createdAt),
		check('incidents_status_ck', oneOf(t.status, INCIDENT_STATUSES)),
		check('incidents_type_ck', oneOf(t.type, INCIDENT_TYPES)),
		check('incidents_severity_ck', sql`${t.severity} is null or ${oneOf(t.severity, SEVERITIES)}`),
		check(
			'incidents_severity_override_ck',
			sql`${t.severityOverride} is null or ${oneOf(t.severityOverride, SEVERITIES)}`
		)
	]
);

export const voiceSessions = pgTable('voice_sessions', {
	id: id(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id, { onDelete: 'cascade' }),
	/** The person speaking on this session (attribution for multi-reporter incidents). */
	userId: text('user_id').references(() => users.id, { onDelete: 'set null' }),
	consentAt: ts('consent_at'),
	incidentId: text('incident_id').references(() => incidents.id, { onDelete: 'set null' }),
	providerSessionId: text('provider_session_id'),
	status: text('status').notNull().default('connecting'),
	isDemo: boolean('is_demo').notNull().default(false),
	scenario: text('scenario'),
	startedAt: ts('started_at').notNull().defaultNow(),
	readyAt: ts('ready_at'),
	endedAt: ts('ended_at'),
	endReason: text('end_reason'),
	reconnects: integer('reconnects').notNull().default(0),
	errorCount: integer('error_count').notNull().default(0),
	/** Post-session cross-check against AssemblyAI's own session record. */
	reconciledAt: ts('reconciled_at'),
	reconciliation: jsonb('reconciliation').$type<Record<string, unknown>>(),
	providerDeletedAt: ts('provider_deleted_at'),
	createdAt: createdAt()
});

export const transcripts = pgTable(
	'transcripts',
	{
		id: id(),
		voiceSessionId: text('voice_session_id').references(() => voiceSessions.id, {
			onDelete: 'cascade'
		}),
		incidentId: text('incident_id').references(() => incidents.id, { onDelete: 'cascade' }),
		speaker: text('speaker').notNull(),
		userId: text('user_id'),
		text: encryptedText('text').notNull(),
		/** STT confidence from AssemblyAI's session record (filled by reconciliation). */
		sttConfidence: doublePrecision('stt_confidence'),
		redactedAt: ts('redacted_at'),
		channel: text('channel').notNull().default('voice'),
		providerItemId: text('provider_item_id'),
		interrupted: boolean('interrupted').notNull().default(false),
		offsetMs: integer('offset_ms'),
		receivedAt: ts('received_at').notNull().defaultNow()
	},
	(t) => [
		index('transcripts_incident_idx').on(t.incidentId, t.receivedAt),
		index('transcripts_session_idx').on(t.voiceSessionId)
	]
);

export const facts = pgTable(
	'facts',
	{
		id: id(),
		incidentId: text('incident_id')
			.notNull()
			.references(() => incidents.id, { onDelete: 'cascade' }),
		category: text('category').notNull(),
		key: text('key').notNull(),
		label: text('label').notNull(),
		value: text('value').notNull(),
		numericValue: doublePrecision('numeric_value'),
		unit: text('unit'),
		certainty: text('certainty').notNull(),
		basis: text('basis').notNull(),
		needsVerification: boolean('needs_verification').notNull().default(false),
		verification: text('verification').notNull().default('unverified'),
		status: text('status').notNull().default('current'),
		supersedesId: text('supersedes_id'),
		supersededById: text('superseded_by_id'),
		sourceType: text('source_type').notNull(),
		transcriptId: text('transcript_id').references(() => transcripts.id, { onDelete: 'set null' }),
		evidenceQuote: encryptedText('evidence_quote'),
		quoteMatched: boolean('quote_matched'),
		speaker: text('speaker'),
		/** Sensor / device id for observed facts. */
		sourceRef: text('source_ref'),
		observedAt: ts('observed_at').notNull().defaultNow(),
		confirmedAt: ts('confirmed_at'),
		confirmationNote: text('confirmation_note'),
		note: text('note'),
		createdAt: createdAt(),
		updatedAt: ts('updated_at').notNull().defaultNow()
	},
	(t) => [
		index('facts_incident_idx').on(t.incidentId),
		// At most one current value per key per incident.
		uniqueIndex('facts_current_key_uq')
			.on(t.incidentId, t.key)
			.where(sql`${t.status} = 'current'`),
		check('facts_category_ck', oneOf(t.category, FACT_CATEGORIES)),
		check('facts_certainty_ck', oneOf(t.certainty, FACT_CERTAINTIES)),
		check('facts_basis_ck', oneOf(t.basis, FACT_BASES)),
		check('facts_verification_ck', oneOf(t.verification, FACT_VERIFICATIONS)),
		check('facts_status_ck', oneOf(t.status, FACT_STATUSES)),
		check('facts_source_ck', oneOf(t.sourceType, SOURCE_TYPES))
	]
);

export const infoRequests = pgTable(
	'info_requests',
	{
		id: id(),
		incidentId: text('incident_id')
			.notNull()
			.references(() => incidents.id, { onDelete: 'cascade' }),
		key: text('key').notNull(),
		question: text('question').notNull(),
		priority: text('priority').notNull(),
		status: text('status').notNull().default('open'),
		origin: text('origin').notNull(),
		answeredFactId: text('answered_fact_id'),
		note: text('note'),
		createdAt: createdAt(),
		resolvedAt: ts('resolved_at')
	},
	(t) => [
		uniqueIndex('info_requests_key_uq').on(t.incidentId, t.key),
		check('info_requests_priority_ck', oneOf(t.priority, INFO_PRIORITIES)),
		check('info_requests_status_ck', oneOf(t.status, INFO_STATUSES))
	]
);

export const actions = pgTable(
	'actions',
	{
		id: id(),
		incidentId: text('incident_id')
			.notNull()
			.references(() => incidents.id, { onDelete: 'cascade' }),
		seq: integer('seq').notNull(),
		title: text('title').notNull(),
		description: text('description'),
		priority: text('priority').notNull().default('normal'),
		status: text('status').notNull().default('pending'),
		owner: text('owner'),
		contactName: text('contact_name'),
		contactRole: text('contact_role'),
		requiresResponse: boolean('requires_response').notNull().default(false),
		responseDueAt: ts('response_due_at'),
		responseReceivedAt: ts('response_received_at'),
		responseSummary: text('response_summary'),
		notificationStatus: text('notification_status'),
		origin: text('origin').notNull(),
		blockedReason: text('blocked_reason'),
		/** The fact that made this action necessary (evidence → action link). */
		reasonFactId: text('reason_fact_id'),
		note: text('note'),
		createdAt: createdAt(),
		updatedAt: ts('updated_at').notNull().defaultNow(),
		startedAt: ts('started_at'),
		completedAt: ts('completed_at')
	},
	(t) => [
		uniqueIndex('actions_seq_uq').on(t.incidentId, t.seq),
		check('actions_status_ck', oneOf(t.status, ACTION_STATUSES)),
		check('actions_priority_ck', oneOf(t.priority, ACTION_PRIORITIES))
	]
);

export const escalations = pgTable(
	'escalations',
	{
		id: id(),
		incidentId: text('incident_id')
			.notNull()
			.references(() => incidents.id, { onDelete: 'cascade' }),
		seq: integer('seq').notNull(),
		actionId: text('action_id').references(() => actions.id, { onDelete: 'set null' }),
		level: integer('level').notNull().default(1),
		targetName: text('target_name').notNull(),
		targetRole: text('target_role'),
		reason: text('reason').notNull(),
		trigger: text('trigger').notNull(),
		status: text('status').notNull().default('open'),
		simulated: boolean('simulated').notNull().default(false),
		notificationStatus: text('notification_status').notNull(),
		resolutionNote: text('resolution_note'),
		createdAt: createdAt(),
		acknowledgedAt: ts('acknowledged_at'),
		resolvedAt: ts('resolved_at')
	},
	(t) => [
		uniqueIndex('escalations_seq_uq').on(t.incidentId, t.seq),
		// One timeout escalation per action — makes the rule check idempotent.
		uniqueIndex('escalations_action_timeout_uq')
			.on(t.actionId)
			.where(sql`${t.trigger} = 'response_timeout'`),
		check('escalations_status_ck', oneOf(t.status, ESCALATION_STATUSES)),
		check('escalations_trigger_ck', oneOf(t.trigger, ESCALATION_TRIGGERS))
	]
);

export const timelineEvents = pgTable(
	'timeline_events',
	{
		id: id(),
		incidentId: text('incident_id')
			.notNull()
			.references(() => incidents.id, { onDelete: 'cascade' }),
		eventType: text('event_type').notNull(),
		description: text('description').notNull(),
		source: text('source').notNull(),
		actor: text('actor'),
		toolName: text('tool_name'),
		refType: text('ref_type'),
		refId: text('ref_id'),
		metadata: jsonb('metadata').$type<Record<string, unknown>>(),
		occurredAt: ts('occurred_at').notNull().defaultNow(),
		/** Tamper evidence: per-incident sequence and SHA-256 hash chain. */
		chainSeq: integer('chain_seq').notNull().default(0),
		prevHash: text('prev_hash'),
		hash: text('hash')
	},
	(t) => [
		index('timeline_incident_idx').on(t.incidentId, t.occurredAt),
		uniqueIndex('timeline_chain_uq').on(t.incidentId, t.chainSeq)
	]
);

/** Audit log of every tool execution, successful or not. */
export const toolInvocations = pgTable(
	'tool_invocations',
	{
		id: id(),
		voiceSessionId: text('voice_session_id'),
		incidentId: text('incident_id'),
		userId: text('user_id'),
		callId: text('call_id'),
		toolName: text('tool_name').notNull(),
		origin: text('origin').notNull(),
		arguments: jsonb('arguments'),
		result: jsonb('result'),
		ok: boolean('ok').notNull(),
		error: text('error'),
		durationMs: integer('duration_ms'),
		createdAt: createdAt()
	},
	(t) => [index('tool_invocations_incident_idx').on(t.incidentId)]
);

export const reports = pgTable(
	'reports',
	{
		id: id(),
		incidentId: text('incident_id')
			.notNull()
			.references(() => incidents.id, { onDelete: 'cascade' }),
		version: integer('version').notNull(),
		content: jsonb('content').notNull(),
		markdown: text('markdown').notNull(),
		generatedBy: text('generated_by').notNull(),
		generatedAt: ts('generated_at').notNull().defaultNow()
	},
	(t) => [uniqueIndex('reports_version_uq').on(t.incidentId, t.version)]
);

export const contacts = pgTable('contacts', {
	id: id(),
	orgId: text('org_id')
		.notNull()
		.references(() => organizations.id, { onDelete: 'cascade' }),
	name: text('name').notNull(),
	role: text('role').notNull(),
	roleLabel: text('role_label').notNull(),
	site: text('site'),
	organization: text('organization').notNull(),
	isDemo: boolean('is_demo').notNull().default(true),
	notificationChannel: text('notification_channel').notNull().default('none'),
	phone: text('phone'),
	email: text('email'),
	/** On-call contacts are preferred when resolving an escalation target. */
	onCall: boolean('on_call').notNull().default(false),
	createdAt: createdAt()
});

// ─── Notifications, attachments, shared rate limiting ────────────────────────

export const notifications = pgTable(
	'notifications',
	{
		id: id(),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		incidentId: text('incident_id').references(() => incidents.id, { onDelete: 'cascade' }),
		escalationId: text('escalation_id'),
		actionId: text('action_id'),
		contactId: text('contact_id'),
		channel: text('channel').notNull(),
		toAddress: text('to_address'),
		body: text('body').notNull(),
		status: text('status').notNull(),
		providerMessageId: text('provider_message_id'),
		error: text('error'),
		/** sha256 of the one-time acknowledgement token sent in the message. */
		ackTokenHash: text('ack_token_hash'),
		acknowledgedAt: ts('acknowledged_at'),
		createdAt: createdAt(),
		updatedAt: ts('updated_at').notNull().defaultNow()
	},
	(t) => [
		index('notifications_incident_idx').on(t.incidentId),
		index('notifications_provider_idx').on(t.providerMessageId),
		check('notifications_channel_ck', oneOf(t.channel, NOTIFICATION_CHANNELS)),
		check('notifications_status_ck', oneOf(t.status, NOTIFICATION_STATES))
	]
);

export const attachments = pgTable(
	'attachments',
	{
		id: id(),
		orgId: text('org_id')
			.notNull()
			.references(() => organizations.id, { onDelete: 'cascade' }),
		incidentId: text('incident_id')
			.notNull()
			.references(() => incidents.id, { onDelete: 'cascade' }),
		kind: text('kind').notNull().default('photo'),
		mime: text('mime').notNull(),
		sizeBytes: integer('size_bytes').notNull(),
		sha256: text('sha256').notNull(),
		/** Base64 payload, kept in Postgres for zero-infrastructure deploys (≤ 5 MB). */
		data: text('data').notNull(),
		caption: text('caption'),
		uploadedBy: text('uploaded_by'),
		createdAt: createdAt()
	},
	(t) => [index('attachments_incident_idx').on(t.incidentId)]
);

/** Fixed-window counters shared by every app instance. */
export const rateLimits = pgTable('rate_limits', {
	key: text('key').primaryKey(),
	windowStart: ts('window_start').notNull(),
	count: integer('count').notNull()
});
