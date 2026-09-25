import { and, asc, eq, inArray, or } from 'drizzle-orm';
import * as t from '../db/schema';
import {
	addTimeline,
	getOrgSettings,
	getIncident,
	loadSnapshot,
	mapFact,
	touchIncident,
	type Tx
} from './repository';
import {
	assertIncidentTransition,
	autoProgression,
	canTransitionIncident
} from '$lib/domain/state-machine';
import {
	classifyFact,
	defaultNeedsVerification,
	EPISTEMIC_LABELS,
	formatFactValue,
	humanizeKey,
	matchEvidenceQuote,
	normalizeFactKey,
	sameClaim
} from '$lib/domain/evidence';
import { getPlaybook } from '$lib/domain/playbooks';
import { assessSeverity } from '$lib/domain/severity';
import { buildChecklist, nextQuestions } from '$lib/domain/information';
import { evaluateResponseTimeouts, findContact, isAwaitingResponse } from '$lib/domain/escalation';
import { queueNotification } from '../notifications/outbox';
import type {
	FactCategory,
	FactRecord,
	IncidentRecord,
	IncidentSnapshot,
	IncidentStatus,
	SourceType,
	TimelineRecord
} from '$lib/domain/types';

/** external = a contact acting through an acknowledgement link; sensor = the observations API. */
export type Origin = 'voice' | 'operator' | 'demo_simulation' | 'system' | 'external' | 'sensor';

export interface EngineContext {
	origin: Origin;
	/** Display name of the person (or integration) acting; recorded on timeline events. */
	actorName?: string | null;
	voiceSessionId: string | null;
	toolName?: string;
	now: Date;
	/** Sensor API: the device/reading identifier stored as the fact's source reference. */
	sourceRef?: string | null;
}

export function timelineSource(origin: Origin): TimelineRecord['source'] {
	switch (origin) {
		case 'voice':
			return 'agent_tool';
		case 'operator':
			return 'operator';
		case 'demo_simulation':
			return 'demo_simulation';
		case 'external':
			return 'external';
		case 'sensor':
			return 'sensor';
		default:
			return 'system';
	}
}

export async function transitionIncident(
	db: Tx,
	incident: IncidentRecord,
	to: IncidentStatus,
	reason: string,
	ctx: EngineContext
): Promise<IncidentRecord> {
	if (incident.status === to) return incident;
	assertIncidentTransition(incident.status, to);
	const patch: Partial<typeof t.incidents.$inferInsert> = { status: to };
	if (to === 'resolved') patch.resolvedAt = ctx.now;
	if (to === 'closed') patch.closedAt = ctx.now;
	if (to === 'active' && incident.status === 'resolved') patch.resolvedAt = null;
	await touchIncident(db, incident.id, patch);
	await addTimeline(db, {
		incidentId: incident.id,
		eventType: 'status_changed',
		description: `Status ${incident.status.toUpperCase()} → ${to.toUpperCase()}: ${reason}`,
		source: timelineSource(ctx.origin),
		actor: ctx.actorName ?? null,
		toolName: ctx.toolName,
		metadata: { from: incident.status, to },
		occurredAt: ctx.now
	});
	return { ...incident, ...patch, status: to } as IncidentRecord;
}

export async function applyAutoProgression(
	db: Tx,
	incidentId: string,
	event: Parameters<typeof autoProgression>[1],
	ctx: EngineContext
): Promise<IncidentStatus | null> {
	const incident = await getIncident(db, incidentId);
	const next = autoProgression(incident.status, event);
	if (!next) return null;
	await transitionIncident(db, incident, next.to, `${next.reason} (automatic)`, ctx);
	return next.to;
}

/** Recompute the rule-based severity and log it when it changes. */
export async function refreshSeverity(db: Tx, incidentId: string, ctx: EngineContext) {
	const snap = await loadSnapshot(db, incidentId);
	const assessment = assessSeverity({ ...snap, now: ctx.now });
	if (assessment.level !== snap.incident.severity) {
		await touchIncident(db, incidentId, { severity: assessment.level });
		const drivers = assessment.override
			? `override — ${assessment.override.reason}`
			: assessment.signals
					.filter((s) => s.level === assessment.computedLevel)
					.map((s) => s.reason)
					.join('; ');
		await addTimeline(db, {
			incidentId,
			eventType: 'severity_assessed',
			description: `Severity ${snap.incident.severity ? `${snap.incident.severity.toUpperCase()} → ` : ''}${assessment.level.toUpperCase()}: ${drivers}`,
			source: 'system',
			metadata: { level: assessment.level, provisional: assessment.provisional },
			occurredAt: ctx.now
		});
	}
	return assessment;
}

export interface FactOutcome {
	key: string;
	outcome: 'recorded' | 'superseded' | 'unchanged';
	display: string;
	class: string;
	quoteMatched: boolean | null;
	previous?: string;
}

interface FactWrite {
	key: string;
	/** Optional when numeric_value is given; derived from number + unit. */
	value?: string;
	numeric_value?: number;
	unit?: string;
	minutes_ago?: number;
	certainty: 'exact' | 'approximate';
	basis: 'stated' | 'inferred';
	evidence_quote?: string;
	category?: FactCategory;
	label?: string;
	verification?: 'unverified' | 'confirmed';
	confirmationNote?: string;
}

/**
 * Record facts with provenance. A new value for a key supersedes the current
 * one (kept as history, never deleted); an identical value is a no-op so a
 * retried tool call cannot create duplicates.
 */
export async function recordFacts(
	db: Tx,
	incident: IncidentRecord,
	inputs: FactWrite[],
	ctx: EngineContext
): Promise<FactOutcome[]> {
	const playbook = getPlaybook(incident.type);
	const templates = new Map(playbook.info.map((i) => [i.key, i]));
	const transcriptRows = await db
		.select()
		.from(t.transcripts)
		.where(
			ctx.voiceSessionId
				? or(
						eq(t.transcripts.incidentId, incident.id),
						eq(t.transcripts.voiceSessionId, ctx.voiceSessionId)
					)
				: eq(t.transcripts.incidentId, incident.id)
		)
		.orderBy(asc(t.transcripts.receivedAt));
	const outcomes: FactOutcome[] = [];

	for (const input of inputs) {
		const key = normalizeFactKey(input.key);
		if (!key) continue;
		const template = templates.get(key);
		const category: FactCategory = input.category ?? template?.category ?? 'other';
		const label = input.label?.trim() || template?.label || humanizeKey(key);

		// Provenance: trace the quote to the reporter's utterance.
		let transcriptId: string | null = null;
		let quoteMatched: boolean | null = null;
		let channel: string | null = null;
		if (input.evidence_quote) {
			const match = matchEvidenceQuote(input.evidence_quote, transcriptRows as never);
			quoteMatched = !!match;
			if (match) {
				transcriptId = match.transcriptId;
				channel = transcriptRows.find((r) => r.id === match.transcriptId)?.channel ?? null;
			}
		}
		// Sensor readings are machine observations: their own basis and source, never "stated".
		const basis = ctx.origin === 'sensor' ? 'observed' : input.basis;
		let sourceType: SourceType;
		if (ctx.origin === 'sensor') sourceType = 'sensor';
		else if (input.basis === 'inferred') sourceType = 'agent_inference';
		else if (ctx.origin === 'operator') sourceType = 'operator_entry';
		else if (ctx.origin === 'demo_simulation') sourceType = 'demo_simulation';
		else if (channel === 'typed') sourceType = 'typed_message';
		else sourceType = 'voice_transcript';

		// Lenient on a recoverable omission: derive the text from the number + unit.
		let value =
			input.value?.trim() ||
			`${input.numeric_value}${input.unit ? (/^[cf]$/i.test(input.unit) ? `°${input.unit.toUpperCase()}` : ` ${input.unit}`) : ''}`;
		if (key === 'incident_start' && input.minutes_ago !== undefined && !/ago|:/.test(value)) {
			value = `${value} (${Math.round(input.minutes_ago)} min before report)`;
		}

		const candidate = {
			value,
			numericValue: input.numeric_value ?? null,
			unit: input.unit ?? null,
			certainty: input.certainty
		};

		const [existingRow] = await db
			.select()
			.from(t.facts)
			.where(
				and(
					eq(t.facts.incidentId, incident.id),
					eq(t.facts.key, key),
					eq(t.facts.status, 'current')
				)
			);
		const existing = existingRow ? mapFact(existingRow) : null;

		if (existing && sameClaim(existing, candidate) && !input.verification) {
			outcomes.push({
				key,
				outcome: 'unchanged',
				display: formatFactValue(existing),
				class: classifyFact(existing),
				quoteMatched: existing.quoteMatched
			});
			continue;
		}

		const newId = crypto.randomUUID();
		if (existing) {
			await db
				.update(t.facts)
				.set({ status: 'superseded', supersededById: newId, updatedAt: ctx.now })
				.where(eq(t.facts.id, existing.id));
		}
		const verification = input.verification ?? 'unverified';
		const [row] = await db
			.insert(t.facts)
			.values({
				id: newId,
				incidentId: incident.id,
				category,
				key,
				label,
				value,
				numericValue: candidate.numericValue,
				unit: candidate.unit,
				certainty: input.certainty,
				basis,
				needsVerification: defaultNeedsVerification(category),
				verification,
				status: 'current',
				supersedesId: existing?.id ?? null,
				sourceType,
				transcriptId,
				evidenceQuote: input.evidence_quote ?? null,
				quoteMatched,
				sourceRef: ctx.sourceRef ?? null,
				speaker:
					input.basis === 'inferred'
						? 'SENTINEL'
						: (ctx.actorName ?? (ctx.origin === 'operator' ? 'Operator' : 'Reporter')),
				observedAt: ctx.now,
				confirmedAt: verification === 'confirmed' ? ctx.now : null,
				confirmationNote: input.confirmationNote ?? null
			})
			.returning();
		const fact = mapFact(row);
		const cls = classifyFact(fact);
		const display = formatFactValue(fact);

		await addTimeline(db, {
			incidentId: incident.id,
			eventType: existing ? 'fact_superseded' : 'fact_recorded',
			description: existing
				? `${label} updated: ${formatFactValue(existing)} → ${display} (${EPISTEMIC_LABELS[cls].toUpperCase()})`
				: `${label} recorded: ${display} (${EPISTEMIC_LABELS[cls].toUpperCase()})`,
			source: timelineSource(ctx.origin),
			actor: ctx.actorName ?? null,
			toolName: ctx.toolName,
			refType: 'fact',
			refId: fact.id,
			metadata: { key, class: cls, quoteMatched, transcriptId },
			occurredAt: ctx.now
		});

		// Answer any open information request for this key.
		await db
			.update(t.infoRequests)
			.set({ status: 'answered', answeredFactId: fact.id, resolvedAt: ctx.now })
			.where(and(eq(t.infoRequests.incidentId, incident.id), eq(t.infoRequests.key, key)));

		// Facts drive incident header fields, so the header always has provenance.
		if (key === 'location' && basis === 'stated') {
			await touchIncident(db, incident.id, { location: value });
			incident.location = value;
		}
		if (key === 'incident_start' && input.minutes_ago !== undefined) {
			await touchIncident(db, incident.id, {
				startedAt: new Date(ctx.now.getTime() - input.minutes_ago * 60000),
				startedAtPrecision: input.certainty
			});
		}

		outcomes.push({
			key,
			outcome: existing ? 'superseded' : 'recorded',
			display,
			class: cls,
			quoteMatched,
			previous: existing ? formatFactValue(existing) : undefined
		});
	}
	return outcomes;
}

/**
 * Response-timeout rule engine. Idempotent: the partial unique index on
 * (action_id) for timeout escalations means a racing second check is a no-op.
 */
export async function runEscalationCheck(db: Tx, incidentId: string, ctx: EngineContext) {
	const snap = await loadSnapshot(db, incidentId);
	const due = evaluateResponseTimeouts(
		snap.incident,
		snap.actions,
		snap.escalations,
		snap.contacts,
		ctx.now,
		(await getOrgSettings(db, snap.incident.orgId)).escalationChain
	);
	const created: {
		seq: number;
		target: string;
		reason: string;
		simulated: boolean;
		statement: string;
	}[] = [];
	let seq = snap.escalations.reduce((m, e) => Math.max(m, e.seq), 0);
	for (const d of due) {
		seq += 1;
		const inserted = await db
			.insert(t.escalations)
			.values({
				incidentId,
				seq,
				actionId: d.action.id,
				level: 1 + snap.escalations.filter((e) => e.actionId === d.action.id).length,
				targetName: d.target.name,
				targetRole: d.target.role,
				reason: d.reason,
				trigger: 'response_timeout',
				status: 'open',
				simulated: snap.incident.isDemo,
				notificationStatus: 'queued',
				createdAt: ctx.now
			})
			.onConflictDoNothing()
			.returning();
		if (!inserted.length) {
			seq -= 1;
			continue;
		}
		await db
			.update(t.actions)
			.set({ status: 'escalated', updatedAt: ctx.now })
			.where(eq(t.actions.id, d.action.id));
		const q = await queueNotification(db, {
			incident: snap.incident,
			contact: d.target.role
				? findContact(d.target.role, snap.incident.location, snap.contacts)
				: null,
			contactName: d.target.name,
			purpose: 'escalation',
			text: `${snap.incident.title}${snap.incident.location ? ` at ${snap.incident.location}` : ''}. ${d.reason}.`,
			escalationId: inserted[0].id
		});
		await db
			.update(t.escalations)
			.set({ notificationStatus: q.status })
			.where(eq(t.escalations.id, inserted[0].id));
		await addTimeline(db, {
			incidentId,
			eventType: 'escalation_created',
			description: `${d.reason} — escalated to ${d.target.name}. ${q.statement}`,
			source: snap.incident.isDemo ? 'demo_simulation' : 'system',
			refType: 'escalation',
			refId: inserted[0].id,
			metadata: { rule: 'response_timeout', actionSeq: d.action.seq },
			occurredAt: ctx.now
		});
		created.push({
			seq,
			target: d.target.name,
			reason: d.reason,
			simulated: snap.incident.isDemo,
			statement: q.statement
		});
	}
	if (created.length) {
		await applyAutoProgression(db, incidentId, 'escalation_opened', ctx);
	}
	return created;
}

/** Compact, speakable incident state returned to the voice agent after each tool call. */
export function agentStateSummary(snap: IncidentSnapshot, now: Date) {
	const severity = assessSeverity({ ...snap, now });
	const checklist = buildChecklist(snap.incident, snap.infoRequests, snap.facts);
	const current = snap.facts.filter((f: FactRecord) => f.status === 'current');
	return {
		incident: snap.incident.code,
		status: snap.incident.status,
		severity: `${severity.level}${severity.provisional ? ' (provisional)' : ''}`,
		severity_reasons: severity.signals
			.filter((s) => s.rule !== 'incident_type_baseline')
			.map((s) => s.reason),
		known: Object.fromEntries(
			current.map((f) => [
				f.key,
				`${formatFactValue(f)} [${EPISTEMIC_LABELS[classifyFact(f)].toLowerCase()}]`
			])
		),
		unknown: checklist
			.filter((c) => c.state === 'open')
			.map((c) => `${c.key} (${c.priority}): ${c.question}`),
		reporter_does_not_know: checklist.filter((c) => c.state === 'unavailable').map((c) => c.key),
		actions: snap.actions.map(
			(a) =>
				`A${a.seq} ${a.title} — ${a.status}${isAwaitingResponse(a) ? ' (awaiting response)' : ''}${a.contactName ? ` [contact: ${a.contactName}]` : ''}`
		),
		escalations: snap.escalations.map(
			(e) => `E${e.seq} → ${e.targetName} — ${e.status}${e.simulated ? ' (demo simulation)' : ''}`
		),
		next_questions: nextQuestions(checklist).map((c) => c.question)
	};
}

export async function linkSessionToIncident(db: Tx, voiceSessionId: string, incidentId: string) {
	await db
		.update(t.voiceSessions)
		.set({ incidentId })
		.where(eq(t.voiceSessions.id, voiceSessionId));
	await db
		.update(t.transcripts)
		.set({ incidentId })
		.where(eq(t.transcripts.voiceSessionId, voiceSessionId));
}

export async function seedInfoRequests(db: Tx, incident: IncidentRecord, ctx: EngineContext) {
	const playbook = getPlaybook(incident.type);
	if (!playbook.info.length) return;
	await db
		.insert(t.infoRequests)
		.values(
			playbook.info.map((i) => ({
				incidentId: incident.id,
				key: i.key,
				question: i.question,
				priority: i.priority,
				status: 'open',
				origin: 'playbook',
				createdAt: ctx.now
			}))
		)
		.onConflictDoNothing();
}

export async function reseedInfoRequestsForType(
	db: Tx,
	incident: IncidentRecord,
	ctx: EngineContext
) {
	await seedInfoRequests(db, incident, ctx);
	// Mark requests already answered by existing facts.
	const current = await db
		.select()
		.from(t.facts)
		.where(and(eq(t.facts.incidentId, incident.id), eq(t.facts.status, 'current')));
	const keys = current.map((f) => f.key);
	if (keys.length) {
		await db
			.update(t.infoRequests)
			.set({ status: 'answered', resolvedAt: ctx.now })
			.where(and(eq(t.infoRequests.incidentId, incident.id), inArray(t.infoRequests.key, keys)));
	}
}

export { canTransitionIncident };
