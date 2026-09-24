/**
 * Core SENTINEL domain vocabulary. Shared by server (persistence, tools)
 * and client (rendering). Everything here is plain data — no I/O.
 */

export const INCIDENT_STATUSES = [
	'new',
	'assessing',
	'active',
	'mitigating',
	'monitoring',
	'escalated',
	'blocked',
	'resolved',
	'closed'
] as const;
export type IncidentStatus = (typeof INCIDENT_STATUSES)[number];

export const SEVERITIES = ['low', 'medium', 'high', 'critical'] as const;
export type Severity = (typeof SEVERITIES)[number];

export const INCIDENT_TYPES = [
	'refrigeration_failure',
	'pos_outage',
	'it_outage',
	'equipment_failure',
	'power_outage',
	'water_leak',
	'damaged_shipment',
	'guest_safety',
	'fire_safety',
	'other'
] as const;
export type IncidentType = (typeof INCIDENT_TYPES)[number];

export const ACTION_STATUSES = [
	'pending',
	'in_progress',
	'completed',
	'blocked',
	'escalated',
	'cancelled'
] as const;
export type ActionStatus = (typeof ACTION_STATUSES)[number];

export const ACTION_PRIORITIES = ['immediate', 'high', 'normal'] as const;
export type ActionPriority = (typeof ACTION_PRIORITIES)[number];

/** How precise the stated value is. */
export const FACT_CERTAINTIES = ['exact', 'approximate'] as const;
export type FactCertainty = (typeof FACT_CERTAINTIES)[number];

/** Where the value came from: said directly, or reasoned by the system. */
export const FACT_BASES = ['stated', 'inferred'] as const;
export type FactBasis = (typeof FACT_BASES)[number];

export const FACT_VERIFICATIONS = ['unverified', 'confirmed', 'disputed'] as const;
export type FactVerification = (typeof FACT_VERIFICATIONS)[number];

export const FACT_STATUSES = ['current', 'superseded', 'retracted'] as const;
export type FactStatus = (typeof FACT_STATUSES)[number];

export const FACT_CATEGORIES = [
	'location',
	'timing',
	'measurement',
	'impact',
	'equipment',
	'people',
	'mitigation',
	'other'
] as const;
export type FactCategory = (typeof FACT_CATEGORIES)[number];

export const SOURCE_TYPES = [
	'voice_transcript',
	'typed_message',
	'operator_entry',
	'agent_inference',
	'system',
	'demo_simulation'
] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

export const INFO_PRIORITIES = ['critical', 'important', 'optional'] as const;
export type InfoPriority = (typeof INFO_PRIORITIES)[number];

export const INFO_STATUSES = ['open', 'answered', 'unavailable', 'not_applicable'] as const;
export type InfoStatus = (typeof INFO_STATUSES)[number];

export const ESCALATION_STATUSES = ['open', 'acknowledged', 'resolved'] as const;
export type EscalationStatus = (typeof ESCALATION_STATUSES)[number];

export const ESCALATION_TRIGGERS = [
	'response_timeout',
	'blocked_action',
	'agent',
	'operator'
] as const;
export type EscalationTrigger = (typeof ESCALATION_TRIGGERS)[number];

/**
 * Notification delivery state. SENTINEL ships with no outbound messaging
 * integration, so nothing is ever reported as "sent".
 */
export const NOTIFICATION_STATUSES = ['not_configured', 'simulated'] as const;
export type NotificationStatus = (typeof NOTIFICATION_STATUSES)[number];

export const CONTACT_ROLES = [
	'branch_manager',
	'maintenance',
	'operations_manager',
	'it_support',
	'food_safety',
	'security'
] as const;
export type ContactRole = (typeof CONTACT_ROLES)[number];

/**
 * The epistemic class shown in the UI. Derived — never stored — so it can
 * never drift from the underlying certainty/basis/verification fields.
 */
export type EpistemicClass =
	'confirmed' | 'reported' | 'unverified' | 'approximate' | 'inferred' | 'disputed';

export interface FactRecord {
	id: string;
	incidentId: string;
	category: FactCategory;
	key: string;
	label: string;
	value: string;
	numericValue: number | null;
	unit: string | null;
	certainty: FactCertainty;
	basis: FactBasis;
	needsVerification: boolean;
	verification: FactVerification;
	status: FactStatus;
	supersedesId: string | null;
	supersededById: string | null;
	sourceType: SourceType;
	transcriptId: string | null;
	evidenceQuote: string | null;
	quoteMatched: boolean | null;
	speaker: string | null;
	observedAt: Date;
	confirmedAt: Date | null;
	confirmationNote: string | null;
	note: string | null;
	createdAt: Date;
}

export interface InfoRequestRecord {
	id: string;
	incidentId: string;
	key: string;
	question: string;
	priority: InfoPriority;
	status: InfoStatus;
	origin: 'playbook' | 'agent' | 'operator';
	answeredFactId: string | null;
	note: string | null;
	createdAt: Date;
	resolvedAt: Date | null;
}

export interface ActionRecord {
	id: string;
	incidentId: string;
	seq: number;
	title: string;
	description: string | null;
	priority: ActionPriority;
	status: ActionStatus;
	owner: string | null;
	contactName: string | null;
	contactRole: ContactRole | null;
	requiresResponse: boolean;
	responseDueAt: Date | null;
	responseReceivedAt: Date | null;
	responseSummary: string | null;
	notificationStatus: NotificationStatus | null;
	origin: 'playbook' | 'agent' | 'operator';
	blockedReason: string | null;
	/** Fact that made this action necessary (evidence → action). */
	reasonFactId: string | null;
	note: string | null;
	createdAt: Date;
	startedAt: Date | null;
	completedAt: Date | null;
}

export interface EscalationRecord {
	id: string;
	incidentId: string;
	seq: number;
	actionId: string | null;
	level: number;
	targetName: string;
	targetRole: ContactRole | null;
	reason: string;
	trigger: EscalationTrigger;
	status: EscalationStatus;
	simulated: boolean;
	notificationStatus: NotificationStatus;
	resolutionNote: string | null;
	createdAt: Date;
	acknowledgedAt: Date | null;
	resolvedAt: Date | null;
}

export interface TimelineRecord {
	id: string;
	incidentId: string;
	eventType: string;
	description: string;
	source: 'voice' | 'agent_tool' | 'operator' | 'system' | 'demo_simulation';
	actor: string | null;
	toolName: string | null;
	refType: string | null;
	refId: string | null;
	metadata: Record<string, unknown> | null;
	occurredAt: Date;
}

export interface TranscriptRecord {
	id: string;
	voiceSessionId: string | null;
	incidentId: string | null;
	speaker: 'user' | 'agent' | 'system';
	text: string;
	channel: 'voice' | 'typed';
	interrupted: boolean;
	offsetMs: number | null;
	receivedAt: Date;
}

export interface IncidentRecord {
	id: string;
	code: string;
	title: string;
	type: IncidentType;
	location: string | null;
	summary: string | null;
	status: IncidentStatus;
	severity: Severity | null;
	severityOverride: Severity | null;
	severityOverrideReason: string | null;
	reportedAt: Date;
	startedAt: Date | null;
	startedAtPrecision: 'exact' | 'approximate' | 'unknown';
	resolvedAt: Date | null;
	closedAt: Date | null;
	resolutionSummary: string | null;
	isDemo: boolean;
	scenario: string | null;
	createdAt: Date;
	updatedAt: Date;
}

export interface ContactRecord {
	id: string;
	name: string;
	role: ContactRole;
	roleLabel: string;
	site: string | null;
	organization: string;
	isDemo: boolean;
	notificationChannel: 'none';
}

export interface ReportRecord {
	id: string;
	incidentId: string;
	version: number;
	content: import('./report').IncidentReport;
	markdown: string;
	generatedAt: Date;
	generatedBy: string;
}

/** Measured (never estimated) metrics for one voice session. */
export interface VoiceSessionStats {
	id: string;
	providerSessionId: string | null;
	status: string;
	startedAt: Date;
	endedAt: Date | null;
	durationSec: number | null;
	userTurns: number;
	agentTurns: number;
	interruptions: number;
	toolCalls: number;
	toolErrors: number;
	reconnects: number;
	errors: number;
}

/** Everything needed to render or reason about one incident. */
export interface IncidentSnapshot {
	incident: IncidentRecord;
	facts: FactRecord[];
	infoRequests: InfoRequestRecord[];
	actions: ActionRecord[];
	escalations: EscalationRecord[];
	timeline: TimelineRecord[];
	transcripts: TranscriptRecord[];
	contacts: ContactRecord[];
}
