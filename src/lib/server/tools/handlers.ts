import { and, eq } from 'drizzle-orm';
import * as t from '../db/schema';
import {
	addTimeline,
	getIncident,
	getIncidentInOrg,
	listContacts,
	loadSnapshot,
	mapAction,
	mapEscalation,
	nextIncidentCode,
	nextSeq,
	touchIncident,
	type Tx
} from '../incidents/repository';
import {
	agentStateSummary,
	applyAutoProgression,
	linkSessionToIncident,
	recordFacts,
	refreshSeverity,
	reseedInfoRequestsForType,
	seedInfoRequests,
	timelineSource,
	transitionIncident,
	type EngineContext
} from '../incidents/engine';
import {
	ACTION_TRANSITIONS,
	assertActionTransition,
	TransitionError
} from '$lib/domain/state-machine';
import {
	classifyFact,
	EPISTEMIC_LABELS,
	formatFactValue,
	normalizeFactKey,
	normalizeText
} from '$lib/domain/evidence';
import {
	findContact,
	findContactName,
	formatDuration,
	responseDueAt
} from '$lib/domain/escalation';
import { queueNotification, type QueuedNotification } from '../notifications/outbox';
import type { OrgSettings } from '$lib/domain/org-settings';
import { CONTACT_ROLE_LABELS, getPlaybook } from '$lib/domain/playbooks';
import { buildReport, renderReportMarkdown } from '$lib/domain/report';
import type { ContactRole, IncidentRecord } from '$lib/domain/types';
import type { ToolArgs, ToolName } from './schemas';

export class ToolError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'ToolError';
	}
}

export interface HandlerContext extends EngineContext {
	/** Tenant boundary: every incident touched must belong to this organisation. */
	orgId: string;
	userId: string | null;
	settings: OrgSettings;
	incidentId: string | null;
	isDemoSession: boolean;
	sessionStartedAt: Date | null;
	scenario?: string | null;
}

export interface ToolOutput {
	message: string;
	/** Spoken-guidance for the agent: what to say / do next. */
	guidance?: string;
	incidentId?: string;
	data?: Record<string, unknown>;
}

type Handler<N extends ToolName> = (
	db: Tx,
	args: ToolArgs<N>,
	ctx: HandlerContext
) => Promise<ToolOutput>;

async function requireIncident(db: Tx, ctx: HandlerContext): Promise<IncidentRecord> {
	if (!ctx.incidentId) {
		throw new ToolError(
			'No incident exists yet. Call create_incident first with what the user has reported.'
		);
	}
	const incident = await getIncidentInOrg(db, ctx.orgId, ctx.incidentId);
	if (incident.status === 'closed') {
		throw new ToolError(`${incident.code} is closed. It can no longer be changed.`);
	}
	return incident;
}

async function findAction(db: Tx, incidentId: string, seq: number) {
	const [row] = await db
		.select()
		.from(t.actions)
		.where(and(eq(t.actions.incidentId, incidentId), eq(t.actions.seq, seq)));
	if (!row) {
		const all = await db
			.select({ seq: t.actions.seq, title: t.actions.title })
			.from(t.actions)
			.where(eq(t.actions.incidentId, incidentId));
		throw new ToolError(
			`There is no action A${seq}. Existing actions: ${all.map((a) => `A${a.seq} ${a.title}`).join('; ') || 'none'}.`
		);
	}
	return mapAction(row);
}

// ---------------------------------------------------------------------------

const createIncident: Handler<'create_incident'> = async (db, args, ctx) => {
	if (ctx.incidentId) {
		const existing = await getIncidentInOrg(db, ctx.orgId, ctx.incidentId);
		throw new ToolError(
			`${existing.code} is already open for this report. Use add_fact or update_incident instead of creating another incident.`
		);
	}
	const code = await nextIncidentCode(db, ctx.orgId);
	const [row] = await db
		.insert(t.incidents)
		.values({
			orgId: ctx.orgId,
			code,
			title: args.title.trim(),
			type: args.type,
			summary: args.summary?.trim() ?? null,
			status: 'new',
			reportedAt: ctx.sessionStartedAt ?? ctx.now,
			isDemo: ctx.isDemoSession,
			scenario: ctx.scenario ?? null,
			createdAt: ctx.now,
			updatedAt: ctx.now
		})
		.returning();
	let incident = row as unknown as IncidentRecord;
	ctx.incidentId = incident.id;

	await addTimeline(db, {
		incidentId: incident.id,
		eventType: 'incident_created',
		description: `Incident ${code} opened: ${incident.title}`,
		source: timelineSource(ctx.origin),
		actor: ctx.actorName ?? null,
		toolName: 'create_incident',
		refType: 'incident',
		refId: incident.id,
		occurredAt: ctx.sessionStartedAt ?? ctx.now
	});
	if (ctx.voiceSessionId) await linkSessionToIncident(db, ctx.voiceSessionId, incident.id);
	await seedInfoRequests(db, incident, ctx);
	incident = await transitionIncident(db, incident, 'assessing', 'Initial report received', ctx);

	const outcomes = await recordFacts(db, incident, args.facts, ctx);
	await refreshSeverity(db, incident.id, ctx);
	const snap = await loadSnapshot(db, incident.id);
	const playbook = getPlaybook(incident.type);
	return {
		incidentId: incident.id,
		message: `Created ${code} (${playbook.label}) with ${outcomes.length} fact(s).`,
		guidance:
			'Briefly acknowledge the most important fact, then ask the single most important next question. Do not list everything.',
		data: {
			facts: outcomes,
			state: agentStateSummary(snap, ctx.now),
			suggested_actions: playbook.actions.map((a) => a.title)
		}
	};
};

const updateIncident: Handler<'update_incident'> = async (db, args, ctx) => {
	let incident = await requireIncident(db, ctx);
	const changes: string[] = [];
	const patch: Partial<typeof t.incidents.$inferInsert> = {};
	if (args.title && args.title !== incident.title) {
		patch.title = args.title.trim();
		changes.push(`title → “${patch.title}”`);
	}
	if (args.summary) {
		patch.summary = args.summary.trim();
		changes.push('summary updated');
	}
	if (args.type && args.type !== incident.type) {
		patch.type = args.type;
		changes.push(`type → ${getPlaybook(args.type).label}`);
	}
	if (args.severity) {
		if (!args.reason)
			throw new ToolError('A severity override needs a reason. Ask why, or omit severity.');
		patch.severityOverride = args.severity;
		patch.severityOverrideReason = args.reason;
		changes.push(`severity override → ${args.severity.toUpperCase()} (${args.reason})`);
	}
	if (Object.keys(patch).length) {
		await touchIncident(db, incident.id, patch);
		await addTimeline(db, {
			incidentId: incident.id,
			eventType: 'incident_updated',
			description: `Incident updated: ${changes.join('; ')}`,
			source: timelineSource(ctx.origin),
			actor: ctx.actorName ?? null,
			toolName: 'update_incident',
			occurredAt: ctx.now
		});
		incident = { ...incident, ...patch } as IncidentRecord;
		if (patch.type) await reseedInfoRequestsForType(db, incident, ctx);
	}
	if (args.status && args.status !== incident.status) {
		if (args.status === 'closed') throw new ToolError('Use close_incident to close an incident.');
		incident = await transitionIncident(
			db,
			incident,
			args.status,
			args.reason ?? 'Updated during response',
			ctx
		);
		changes.push(`status → ${args.status.toUpperCase()}`);
	}
	if (!changes.length)
		throw new ToolError('Nothing to update. Provide status, severity, title, summary or type.');
	const severity = await refreshSeverity(db, incident.id, ctx);
	return {
		message: `Updated ${incident.code}: ${changes.join('; ')}.`,
		data: { status: incident.status, severity: severity.level }
	};
};

const addFact: Handler<'add_fact'> = async (db, args, ctx) => {
	const incident = await requireIncident(db, ctx);
	const outcomes = await recordFacts(db, incident, args.facts, ctx);
	const severity = await refreshSeverity(db, incident.id, ctx);
	const snap = await loadSnapshot(db, incident.id);
	const superseded = outcomes.filter((o) => o.outcome === 'superseded');
	return {
		message: outcomes
			.map((o) =>
				o.outcome === 'superseded'
					? `${o.key}: ${o.previous} superseded by ${o.display}`
					: o.outcome === 'unchanged'
						? `${o.key}: already recorded as ${o.display}`
						: `${o.key}: ${o.display} [${o.class}]`
			)
			.join('; '),
		guidance: [
			superseded.length
				? 'Acknowledge the correction in a few words. The old value is kept in the audit trail.'
				: 'Acknowledge briefly. Ask the next most important question only if one remains.',
			openActionsNudge(snap)
		]
			.filter(Boolean)
			.join(' '),
		data: { facts: outcomes, severity: severity.level, state: agentStateSummary(snap, ctx.now) }
	};
};

/**
 * Keep actions in step with facts: after new information, remind the agent
 * which actions are still open so "I already moved the food" also completes
 * the matching action in the same turn (observed as a gap in live runs).
 */
function openActionsNudge(snap: Awaited<ReturnType<typeof loadSnapshot>>): string {
	const open = snap.actions.filter((a) => a.status === 'pending' || a.status === 'in_progress');
	if (!open.length) return '';
	return `Open actions: ${open.map((a) => `A${a.seq} "${a.title}" (${a.status.replace('_', ' ')})`).join('; ')}. If what the user just said means one of these is already done or underway, call update_action for it now.`;
}

async function currentFact(db: Tx, incidentId: string, key: string) {
	const k = normalizeFactKey(key);
	const [row] = await db
		.select()
		.from(t.facts)
		.where(
			and(eq(t.facts.incidentId, incidentId), eq(t.facts.key, k), eq(t.facts.status, 'current'))
		);
	if (!row) {
		const keys = await db
			.select({ key: t.facts.key })
			.from(t.facts)
			.where(and(eq(t.facts.incidentId, incidentId), eq(t.facts.status, 'current')));
		throw new ToolError(
			`No current fact with key "${k}". Known keys: ${keys.map((r) => r.key).join(', ') || 'none'}.`
		);
	}
	return row;
}

const markFactUncertain: Handler<'mark_fact_uncertain'> = async (db, args, ctx) => {
	const incident = await requireIncident(db, ctx);
	const fact = await currentFact(db, incident.id, args.key);
	const verification = args.disputed ? 'disputed' : 'unverified';
	await db
		.update(t.facts)
		.set({
			certainty: 'approximate',
			verification,
			confirmedAt: null,
			note: args.reason,
			updatedAt: ctx.now
		})
		.where(eq(t.facts.id, fact.id));
	await addTimeline(db, {
		incidentId: incident.id,
		eventType: 'fact_uncertain',
		description: `${fact.label} (${fact.value}) marked ${args.disputed ? 'DISPUTED' : 'UNCERTAIN'}: ${args.reason}`,
		source: timelineSource(ctx.origin),
		actor: ctx.actorName ?? null,
		toolName: 'mark_fact_uncertain',
		refType: 'fact',
		refId: fact.id,
		metadata: args.evidence_quote ? { quote: args.evidence_quote } : null,
		occurredAt: ctx.now
	});
	await refreshSeverity(db, incident.id, ctx);
	return {
		message: `${fact.label} is now ${verification === 'disputed' ? 'disputed' : 'approximate and unverified'}.`
	};
};

const markFactConfirmed: Handler<'mark_fact_confirmed'> = async (db, args, ctx) => {
	const incident = await requireIncident(db, ctx);
	const fact = await currentFact(db, incident.id, args.key);
	const methodLabel = {
		user_rechecked: 'Reporter re-checked',
		independent_source: 'Independent source',
		action_outcome: 'Confirmed by action outcome'
	}[args.method];
	// A correction may arrive as text, as a number, or both (live-observed: number only).
	const correctedNumber = args.corrected_numeric_value;
	const unit = (args.unit ?? fact.unit ?? '').trim();
	const correctedText =
		args.corrected_value?.trim() ||
		(correctedNumber !== undefined
			? `${correctedNumber}${/^[cf]$/i.test(unit) ? `°${unit.toUpperCase()}` : unit ? ` ${unit}` : ''}`
			: undefined);
	const changed =
		correctedText !== undefined &&
		(correctedNumber !== undefined
			? correctedNumber !== fact.numericValue
			: correctedText !== fact.value);

	// Guard: never confirm a numeric value that the user's own words contradict.
	if (!changed && fact.numericValue !== null && args.evidence_quote) {
		const spoken = (normalizeText(args.evidence_quote).match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
		if (spoken.length && !spoken.includes(fact.numericValue)) {
			throw new ToolError(
				`The user's words mention ${spoken.join(', ')} but ${fact.label.toLowerCase()} is recorded as ${fact.numericValue}. If the re-check gave a new reading, call mark_fact_confirmed again with corrected_numeric_value and corrected_value.`
			);
		}
	}

	if (changed) {
		// A re-check with a different reading supersedes the old value.
		const [outcome] = await recordFacts(
			db,
			incident,
			[
				{
					key: fact.key,
					value: correctedText!,
					numeric_value: correctedNumber,
					unit: args.unit ?? fact.unit ?? undefined,
					certainty: 'exact',
					basis: 'stated',
					evidence_quote: args.evidence_quote,
					category: fact.category as never,
					label: fact.label,
					verification: 'confirmed',
					confirmationNote: methodLabel
				}
			],
			{ ...ctx, toolName: 'mark_fact_confirmed' }
		);
		await refreshSeverity(db, incident.id, ctx);
		return {
			message: `${fact.label}: ${outcome.previous} superseded by confirmed ${outcome.display} (${methodLabel}).`,
			guidance: 'Acknowledge the corrected, confirmed value in one short sentence.'
		};
	}

	await db
		.update(t.facts)
		.set({
			verification: 'confirmed',
			confirmedAt: ctx.now,
			confirmationNote: methodLabel,
			updatedAt: ctx.now
		})
		.where(eq(t.facts.id, fact.id));
	await addTimeline(db, {
		incidentId: incident.id,
		eventType: 'fact_confirmed',
		description: `${fact.label} CONFIRMED: ${formatFactValue(fact as never)} — ${methodLabel}`,
		source: timelineSource(ctx.origin),
		actor: ctx.actorName ?? null,
		toolName: 'mark_fact_confirmed',
		refType: 'fact',
		refId: fact.id,
		metadata: args.evidence_quote ? { quote: args.evidence_quote } : null,
		occurredAt: ctx.now
	});
	await refreshSeverity(db, incident.id, ctx);
	return { message: `${fact.label} confirmed (${methodLabel}).` };
};

/** Queue (or honestly decline) a notification to a directory contact; see notifications/outbox. */
async function notifyContact(
	db: Tx,
	incident: IncidentRecord,
	name: string,
	role: ContactRole | null,
	purpose: 'contact' | 'escalation',
	text: string,
	ids: { actionId?: string; escalationId?: string }
): Promise<QueuedNotification> {
	const contacts = await listContacts(db, incident.orgId);
	const contact =
		contacts.find((c) => c.name.toLowerCase() === name.toLowerCase()) ??
		(role ? findContact(role, incident.location, contacts) : null);
	return queueNotification(db, {
		incident,
		contact,
		contactName: name,
		purpose,
		text,
		actionId: ids.actionId ?? null,
		escalationId: ids.escalationId ?? null
	});
}

async function resolveContact(
	db: Tx,
	incident: IncidentRecord,
	role: ContactRole | undefined,
	name: string | undefined
): Promise<{ name: string | null; role: ContactRole | null }> {
	if (!role && !name) return { name: null, role: null };
	const contacts = await listContacts(db, incident.orgId);
	if (name) {
		const match = contacts.find((c) => c.name.toLowerCase().includes(name.toLowerCase().trim()));
		return { name: match?.name ?? name.trim(), role: role ?? (match?.role as ContactRole) ?? null };
	}
	return { name: findContactName(role!, incident.location, contacts), role: role! };
}

const addAction: Handler<'add_action'> = async (db, args, ctx) => {
	const incident = await requireIncident(db, ctx);
	const existingCount = (
		await db
			.select({ id: t.actions.id })
			.from(t.actions)
			.where(eq(t.actions.incidentId, incident.id))
	).length;
	let seq = await nextSeq(db, t.actions, incident.id);
	const created: string[] = [];
	const notes: string[] = [];
	// Idempotency: an interrupted reply drops its tool.result, so the agent may
	// retry. Never create a second open action with the same title.
	const existing = (
		await db.select().from(t.actions).where(eq(t.actions.incidentId, incident.id))
	).map(mapAction);
	const normTitle = (s: string) =>
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, ' ')
			.trim();
	for (const a of args.actions) {
		const dup = existing.find(
			(x) => normTitle(x.title) === normTitle(a.title) && x.status !== 'cancelled'
		);
		if (dup) {
			// A repeated action that asks for a more advanced status ("get maintenance on it")
			// must advance the existing record, never be silently ignored; otherwise what
			// SENTINEL says and what the record shows would disagree (observed live).
			if (
				a.status !== 'pending' &&
				a.status !== dup.status &&
				ACTION_TRANSITIONS[dup.status].includes(a.status)
			) {
				await updateAction(db, { action: dup.seq, status: a.status }, ctx);
				created.push(
					`A${dup.seq} ${dup.title} [existing action now ${a.status.replace('_', ' ')}]`
				);
			} else {
				created.push(`A${dup.seq} ${dup.title} [already exists, ${dup.status}]`);
			}
			continue;
		}
		const contact = await resolveContact(db, incident, a.contact_role, a.contact_name);
		const reasonFact = a.because_of
			? (
					await db
						.select({ id: t.facts.id })
						.from(t.facts)
						.where(
							and(
								eq(t.facts.incidentId, incident.id),
								eq(t.facts.key, normalizeFactKey(a.because_of)),
								eq(t.facts.status, 'current')
							)
						)
				)[0]
			: undefined;
		const requiresResponse =
			a.requires_response ?? (contact.role === 'maintenance' || contact.role === 'it_support');
		const started = a.status === 'in_progress' || a.status === 'completed';
		const [row] = await db
			.insert(t.actions)
			.values({
				incidentId: incident.id,
				seq,
				title: a.title.trim(),
				description: a.description ?? null,
				priority: a.priority,
				status: a.status,
				owner: a.owner ?? null,
				contactName: contact.name,
				contactRole: contact.role,
				requiresResponse: !!contact.name && requiresResponse,
				responseDueAt:
					a.status === 'in_progress' && contact.name && requiresResponse
						? responseDueAt(ctx.now, ctx.settings.responseTimeoutSeconds)
						: null,
				notificationStatus: null,
				origin: ctx.origin === 'operator' ? 'operator' : 'agent',
				reasonFactId: reasonFact?.id ?? null,
				createdAt: ctx.now,
				updatedAt: ctx.now,
				startedAt: started ? ctx.now : null,
				completedAt: a.status === 'completed' ? ctx.now : null
			})
			.returning();
		await addTimeline(db, {
			incidentId: incident.id,
			eventType: 'action_created',
			description: `Action A${seq} added: ${row.title} — ${a.status.replace('_', ' ').toUpperCase()}${contact.name ? ` (contact: ${contact.name})` : ''}`,
			source: timelineSource(ctx.origin),
			actor: ctx.actorName ?? null,
			toolName: 'add_action',
			refType: 'action',
			refId: row.id,
			occurredAt: ctx.now
		});
		if (a.status === 'in_progress' && contact.name) {
			const q = await notifyContact(
				db,
				incident,
				contact.name,
				contact.role,
				'contact',
				`${incident.title}${incident.location ? ` at ${incident.location}` : ''}. Action needed: ${row.title}.`,
				{ actionId: row.id }
			);
			await db
				.update(t.actions)
				.set({ notificationStatus: q.status })
				.where(eq(t.actions.id, row.id));
			await addTimeline(db, {
				incidentId: incident.id,
				eventType: 'contact_initiated',
				description: `Contact with ${contact.name} initiated for A${seq}. ${q.statement}`,
				source: incident.isDemo ? 'demo_simulation' : timelineSource(ctx.origin),
				actor: ctx.actorName ?? null,
				refType: 'action',
				refId: row.id,
				occurredAt: ctx.now
			});
			notes.push(q.statement);
		}
		created.push(
			`A${seq} ${row.title} [${a.status}]${contact.name ? ` contact ${contact.name}` : ''}`
		);
		seq++;
	}
	if (existingCount === 0) await applyAutoProgression(db, incident.id, 'first_action_added', ctx);
	if (args.actions.some((a) => a.status !== 'pending')) {
		await applyAutoProgression(db, incident.id, 'action_started', ctx);
	}
	const snap = await loadSnapshot(db, incident.id);
	return {
		message: `Added ${created.join('; ')}.`,
		guidance:
			'Tell the user only the one or two most urgent actions in plain words. Do not read the whole list; it is on screen.' +
			(notes.length ? ` ${notes.join(' ')}` : ''),
		data: { state: agentStateSummary(snap, ctx.now) }
	};
};

const updateAction: Handler<'update_action'> = async (db, args, ctx) => {
	const incident = await requireIncident(db, ctx);
	const action = await findAction(db, incident.id, args.action);
	if (action.status === args.status) {
		return {
			message: `A${action.seq} ${action.title} is already ${args.status.replace('_', ' ')}.`
		};
	}
	try {
		assertActionTransition(action.status, args.status);
	} catch (e) {
		if (e instanceof TransitionError) throw new ToolError(`A${action.seq}: ${e.message}`);
		throw e;
	}
	if (args.status === 'blocked' && !args.blocked_reason) {
		throw new ToolError(
			'Blocking an action needs blocked_reason. Ask the user what is stopping it.'
		);
	}
	const patch: Partial<typeof t.actions.$inferInsert> = { status: args.status, updatedAt: ctx.now };
	if (args.note) patch.note = args.note;
	if (args.status === 'blocked') patch.blockedReason = args.blocked_reason;
	if (args.status === 'in_progress' && !action.startedAt) patch.startedAt = ctx.now;
	if (
		args.status === 'in_progress' &&
		action.requiresResponse &&
		!action.responseReceivedAt &&
		!action.responseDueAt
	) {
		patch.responseDueAt = responseDueAt(ctx.now, ctx.settings.responseTimeoutSeconds);
	}
	if (args.status === 'completed') patch.completedAt = ctx.now;
	await db.update(t.actions).set(patch).where(eq(t.actions.id, action.id));

	const extra: string[] = [];
	if (args.status === 'in_progress' && action.contactName && !action.startedAt) {
		const q = await notifyContact(
			db,
			incident,
			action.contactName,
			action.contactRole,
			'contact',
			`${incident.title}${incident.location ? ` at ${incident.location}` : ''}. Action needed: ${action.title}.`,
			{ actionId: action.id }
		);
		await db
			.update(t.actions)
			.set({ notificationStatus: q.status })
			.where(eq(t.actions.id, action.id));
		extra.push(q.statement);
		await addTimeline(db, {
			incidentId: incident.id,
			eventType: 'contact_initiated',
			description: `Contact with ${action.contactName} initiated for A${action.seq}. ${q.statement}`,
			source: incident.isDemo ? 'demo_simulation' : timelineSource(ctx.origin),
			actor: ctx.actorName ?? null,
			refType: 'action',
			refId: action.id,
			occurredAt: ctx.now
		});
	}
	await addTimeline(db, {
		incidentId: incident.id,
		eventType: 'action_updated',
		description: `A${action.seq} ${action.title}: ${action.status.replace('_', ' ').toUpperCase()} → ${args.status.replace('_', ' ').toUpperCase()}${args.blocked_reason ? ` — ${args.blocked_reason}` : args.note ? ` — ${args.note}` : ''}`,
		source: timelineSource(ctx.origin),
		actor: ctx.actorName ?? null,
		toolName: 'update_action',
		refType: 'action',
		refId: action.id,
		occurredAt: ctx.now
	});
	if (args.status === 'in_progress' || args.status === 'completed') {
		await applyAutoProgression(db, incident.id, 'action_started', ctx);
	}
	if (args.status === 'blocked' && action.priority === 'immediate') {
		await applyAutoProgression(db, incident.id, 'action_blocked', ctx);
	}
	const awaiting = patch.responseDueAt
		? ` Awaiting response from ${action.contactName}; escalates automatically after ${formatDuration(ctx.settings.responseTimeoutSeconds)} without reply${incident.isDemo ? ' (demo timing)' : ''}.`
		: '';
	return {
		message: `A${action.seq} ${action.title} is now ${args.status.replace('_', ' ')}.${awaiting}`,
		guidance:
			args.status === 'blocked'
				? 'Ask whether to escalate, or call create_escalation if the blocker needs a manager.'
				: extra.join(' ') || undefined
	};
};

const requestInformation: Handler<'request_information'> = async (db, args, ctx) => {
	const incident = await requireIncident(db, ctx);
	const key = normalizeFactKey(args.key);
	const [existing] = await db
		.select()
		.from(t.infoRequests)
		.where(and(eq(t.infoRequests.incidentId, incident.id), eq(t.infoRequests.key, key)));
	const resolved = args.status !== 'open' ? ctx.now : null;
	if (existing) {
		await db
			.update(t.infoRequests)
			.set({
				status: args.status,
				question: args.question,
				priority: args.priority,
				note: args.note ?? existing.note,
				resolvedAt: resolved
			})
			.where(eq(t.infoRequests.id, existing.id));
	} else {
		await db.insert(t.infoRequests).values({
			incidentId: incident.id,
			key,
			question: args.question,
			priority: args.priority,
			status: args.status,
			origin: ctx.origin === 'operator' ? 'operator' : 'agent',
			note: args.note ?? null,
			createdAt: ctx.now,
			resolvedAt: resolved
		});
	}
	const label = key.replace(/_/g, ' ');
	await addTimeline(db, {
		incidentId: incident.id,
		eventType: args.status === 'open' ? 'information_requested' : 'information_unavailable',
		description:
			args.status === 'open'
				? `Information needed: ${label} — “${args.question}”`
				: args.status === 'unavailable'
					? `${label} UNKNOWN — reporter does not know${args.note ? ` (${args.note})` : ''}`
					: `${label} marked not applicable`,
		source: timelineSource(ctx.origin),
		actor: ctx.actorName ?? null,
		toolName: 'request_information',
		occurredAt: ctx.now
	});
	return {
		message:
			args.status === 'open'
				? `Tracking open question: ${label}.`
				: `${label} recorded as ${args.status.replace('_', ' ')} — it stays visible as unknown.`
	};
};

const recordResponse: Handler<'record_response'> = async (db, args, ctx) => {
	const incident = await requireIncident(db, ctx);
	const action = await findAction(db, incident.id, args.action);
	await db
		.update(t.actions)
		.set({
			responseReceivedAt: ctx.now,
			responseSummary: `${args.responder}: ${args.response}`,
			status: action.status === 'pending' ? 'in_progress' : action.status,
			startedAt: action.startedAt ?? ctx.now,
			updatedAt: ctx.now
		})
		.where(eq(t.actions.id, action.id));
	await addTimeline(db, {
		incidentId: incident.id,
		eventType: 'response_received',
		description: `Response on A${action.seq} from ${args.responder}: “${args.response}”${ctx.origin === 'demo_simulation' ? ' (DEMO SIMULATION)' : ''}`,
		source: timelineSource(ctx.origin),
		actor: ctx.actorName ?? null,
		toolName: 'record_response',
		refType: 'action',
		refId: action.id,
		metadata: args.evidence_quote ? { quote: args.evidence_quote } : null,
		occurredAt: ctx.now
	});
	return {
		message: `Recorded ${args.responder}'s response on A${action.seq}. The response timer is stopped.`,
		guidance: 'Relay the response in one sentence and say what happens next.'
	};
};

const createEscalation: Handler<'create_escalation'> = async (db, args, ctx) => {
	const incident = await requireIncident(db, ctx);
	const action = args.action ? await findAction(db, incident.id, args.action) : null;
	const role: ContactRole = args.target_role ?? 'operations_manager';
	const contact = await resolveContact(db, incident, role, args.target_name);
	const targetName = contact.name ?? CONTACT_ROLE_LABELS[role];
	const [openDup] = await db
		.select()
		.from(t.escalations)
		.where(
			and(
				eq(t.escalations.incidentId, incident.id),
				eq(t.escalations.targetName, targetName),
				eq(t.escalations.status, 'open')
			)
		);
	if (openDup && (!action || openDup.actionId === action.id || openDup.actionId === null)) {
		return {
			message: `Escalation E${openDup.seq} to ${targetName} is already open (${openDup.reason}).`,
			guidance: `Nothing new was created. Tell the user in one sentence that it has been escalated to ${targetName}${openDup.trigger === 'response_timeout' ? ' because nobody responded in time' : ''}, then continue.`
		};
	}
	const seq = await nextSeq(db, t.escalations, incident.id);
	const priorForAction = action
		? (await db.select().from(t.escalations).where(eq(t.escalations.actionId, action.id))).length
		: 0;
	const [row] = await db
		.insert(t.escalations)
		.values({
			incidentId: incident.id,
			seq,
			actionId: action?.id ?? null,
			level: priorForAction + 1,
			targetName,
			targetRole: contact.role ?? role,
			reason: args.reason,
			trigger: ctx.origin === 'operator' ? 'operator' : 'agent',
			status: 'open',
			simulated: incident.isDemo,
			notificationStatus: 'queued',
			createdAt: ctx.now
		})
		.returning();
	const q = await notifyContact(
		db,
		incident,
		targetName,
		contact.role ?? role,
		'escalation',
		`${incident.title}${incident.location ? ` at ${incident.location}` : ''}. ${args.reason}`,
		{ escalationId: row.id }
	);
	await db
		.update(t.escalations)
		.set({ notificationStatus: q.status })
		.where(eq(t.escalations.id, row.id));
	if (action && ['in_progress', 'blocked'].includes(action.status)) {
		await db
			.update(t.actions)
			.set({ status: 'escalated', updatedAt: ctx.now })
			.where(eq(t.actions.id, action.id));
	}
	await addTimeline(db, {
		incidentId: incident.id,
		eventType: 'escalation_created',
		description: `Escalation E${seq} to ${targetName}: ${args.reason} — ${q.statement}`,
		source: incident.isDemo ? 'demo_simulation' : timelineSource(ctx.origin),
		actor: ctx.actorName ?? null,
		toolName: 'create_escalation',
		refType: 'escalation',
		refId: row.id,
		occurredAt: ctx.now
	});
	await applyAutoProgression(db, incident.id, 'escalation_opened', ctx);
	return {
		message: `Escalation E${seq} opened to ${targetName}.`,
		guidance: `${q.statement} Say only what that sentence says; never claim a message was delivered.`
	};
};

const resolveEscalation: Handler<'resolve_escalation'> = async (db, args, ctx) => {
	const incident = await requireIncident(db, ctx);
	const [row] = await db
		.select()
		.from(t.escalations)
		.where(and(eq(t.escalations.incidentId, incident.id), eq(t.escalations.seq, args.escalation)));
	if (!row) throw new ToolError(`There is no escalation E${args.escalation}.`);
	const esc = mapEscalation(row);
	if (esc.status === 'resolved') throw new ToolError(`E${esc.seq} is already resolved.`);
	if (esc.status === 'acknowledged' && args.status === 'acknowledged') {
		throw new ToolError(`E${esc.seq} is already acknowledged.`);
	}
	await db
		.update(t.escalations)
		.set({
			status: args.status,
			resolutionNote: args.note,
			acknowledgedAt: esc.acknowledgedAt ?? ctx.now,
			resolvedAt: args.status === 'resolved' ? ctx.now : null
		})
		.where(eq(t.escalations.id, esc.id));
	await addTimeline(db, {
		incidentId: incident.id,
		eventType: args.status === 'resolved' ? 'escalation_resolved' : 'escalation_acknowledged',
		description: `Escalation E${esc.seq} (${esc.targetName}) ${args.status.toUpperCase()}: ${args.note}${ctx.origin === 'demo_simulation' ? ' (DEMO SIMULATION)' : ''}`,
		source: timelineSource(ctx.origin),
		actor: ctx.actorName ?? null,
		toolName: 'resolve_escalation',
		refType: 'escalation',
		refId: esc.id,
		occurredAt: ctx.now
	});
	// Once every escalation is at least acknowledged, the response resumes.
	const open = await db
		.select()
		.from(t.escalations)
		.where(and(eq(t.escalations.incidentId, incident.id), eq(t.escalations.status, 'open')));
	const fresh = await getIncident(db, incident.id);
	if (!open.length && fresh.status === 'escalated') {
		await transitionIncident(
			db,
			fresh,
			'mitigating',
			'Escalations acknowledged — response continuing',
			ctx
		);
	}
	return { message: `E${esc.seq} ${args.status}.` };
};

const addTimelineEvent: Handler<'add_timeline_event'> = async (db, args, ctx) => {
	const incident = await requireIncident(db, ctx);
	await addTimeline(db, {
		incidentId: incident.id,
		eventType: args.event_type,
		description: args.description.trim(),
		source: timelineSource(ctx.origin),
		actor: ctx.actorName ?? null,
		toolName: 'add_timeline_event',
		occurredAt: ctx.now
	});
	return { message: 'Added to the timeline.' };
};

const generateIncidentReport: Handler<'generate_incident_report'> = async (db, _args, ctx) => {
	if (!ctx.incidentId) throw new ToolError('No incident exists yet.');
	const snap = await loadSnapshot(db, ctx.incidentId);
	const report = buildReport(snap, ctx.now);
	const version =
		(
			await db
				.select({ v: t.reports.version })
				.from(t.reports)
				.where(eq(t.reports.incidentId, snap.incident.id))
		).reduce((m, r) => Math.max(m, r.v), 0) + 1;
	await db.insert(t.reports).values({
		incidentId: snap.incident.id,
		version,
		content: report,
		markdown: renderReportMarkdown(report),
		generatedBy: ctx.origin === 'voice' ? 'SENTINEL voice agent' : ctx.origin,
		generatedAt: ctx.now
	});
	await addTimeline(db, {
		incidentId: snap.incident.id,
		eventType: 'report_generated',
		description: `Incident report v${version} generated from ${report.evidenceStats.facts} facts and ${snap.timeline.length} timeline events`,
		source: timelineSource(ctx.origin),
		actor: ctx.actorName ?? null,
		toolName: 'generate_incident_report',
		occurredAt: ctx.now
	});
	return {
		message: `Report v${version} generated. ${report.unknowns.length} unknown item(s), ${report.outstandingActions.length} outstanding action(s).`,
		guidance: 'Say the report is ready on screen. Mention at most the single biggest open item.',
		data: {
			version,
			path: `/incidents/${snap.incident.id}/report`,
			summary: report.executiveSummary
		}
	};
};

const closeIncident: Handler<'close_incident'> = async (db, args, ctx) => {
	let incident = await requireIncident(db, ctx);
	if (args.final_status === 'closed') {
		const open = await db.select().from(t.actions).where(eq(t.actions.incidentId, incident.id));
		const unfinished = open.filter((a) => !['completed', 'cancelled'].includes(a.status));
		if (unfinished.length) {
			throw new ToolError(
				`Cannot close: ${unfinished.length} action(s) still open (${unfinished.map((a) => `A${a.seq}`).join(', ')}). Complete or cancel them, or use final_status "resolved".`
			);
		}
	}
	await touchIncident(db, incident.id, { resolutionSummary: args.resolution_summary });
	if (incident.status !== 'resolved') {
		incident = await transitionIncident(db, incident, 'resolved', args.resolution_summary, ctx);
	}
	if (args.final_status === 'closed') {
		incident = await transitionIncident(db, incident, 'closed', 'Incident closed', ctx);
	}
	return { message: `${incident.code} is ${incident.status.toUpperCase()}.` };
};

export const HANDLERS: { [N in ToolName]: Handler<N> } = {
	create_incident: createIncident,
	update_incident: updateIncident,
	add_fact: addFact,
	mark_fact_uncertain: markFactUncertain,
	mark_fact_confirmed: markFactConfirmed,
	add_action: addAction,
	update_action: updateAction,
	request_information: requestInformation,
	record_response: recordResponse,
	create_escalation: createEscalation,
	resolve_escalation: resolveEscalation,
	add_timeline_event: addTimelineEvent,
	generate_incident_report: generateIncidentReport,
	close_incident: closeIncident
};

export { classifyFact, EPISTEMIC_LABELS };
