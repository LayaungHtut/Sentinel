import { and, asc, desc, eq, inArray, max, sql } from 'drizzle-orm';
import type { Database } from '../db';
import * as t from '../db/schema';
import type {
	ActionRecord,
	ContactRecord,
	EscalationRecord,
	FactRecord,
	IncidentRecord,
	IncidentSnapshot,
	InfoRequestRecord,
	ReportRecord,
	TimelineRecord,
	TranscriptRecord,
	VoiceSessionStats
} from '$lib/domain/types';

/** Any Drizzle handle — the root db or a transaction. */
export type Tx = Pick<Database, 'select' | 'insert' | 'update' | 'delete' | 'execute'>;

// Row → domain mappers. Enum columns are CHECK-constrained in the DB, so the casts are safe.
export const mapIncident = (r: typeof t.incidents.$inferSelect): IncidentRecord =>
	r as unknown as IncidentRecord;
export const mapFact = (r: typeof t.facts.$inferSelect): FactRecord => r as unknown as FactRecord;
export const mapInfo = (r: typeof t.infoRequests.$inferSelect): InfoRequestRecord =>
	r as unknown as InfoRequestRecord;
export const mapAction = (r: typeof t.actions.$inferSelect): ActionRecord =>
	r as unknown as ActionRecord;
export const mapEscalation = (r: typeof t.escalations.$inferSelect): EscalationRecord =>
	r as unknown as EscalationRecord;
export const mapTimeline = (r: typeof t.timelineEvents.$inferSelect): TimelineRecord =>
	r as unknown as TimelineRecord;
export const mapTranscript = (r: typeof t.transcripts.$inferSelect): TranscriptRecord =>
	r as unknown as TranscriptRecord;
export const mapContact = (r: typeof t.contacts.$inferSelect): ContactRecord =>
	r as unknown as ContactRecord;

export class NotFoundError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'NotFoundError';
	}
}

export async function getIncident(db: Tx, id: string): Promise<IncidentRecord> {
	const [row] = await db.select().from(t.incidents).where(eq(t.incidents.id, id));
	if (!row) throw new NotFoundError(`Incident ${id} not found`);
	return mapIncident(row);
}

export async function findIncidentByIdOrCode(db: Tx, ref: string): Promise<IncidentRecord | null> {
	const [row] = await db
		.select()
		.from(t.incidents)
		.where(sql`${t.incidents.id} = ${ref} or upper(${t.incidents.code}) = upper(${ref})`);
	return row ? mapIncident(row) : null;
}

export async function listContacts(db: Tx): Promise<ContactRecord[]> {
	const rows = await db.select().from(t.contacts).orderBy(asc(t.contacts.name));
	return rows.map(mapContact);
}

export async function loadSnapshot(db: Tx, incidentId: string): Promise<IncidentSnapshot> {
	const incident = await getIncident(db, incidentId);
	const [facts, infoRequests, actions, escalations, timeline, transcripts, contacts] =
		await Promise.all([
			db
				.select()
				.from(t.facts)
				.where(eq(t.facts.incidentId, incidentId))
				.orderBy(asc(t.facts.createdAt)),
			db
				.select()
				.from(t.infoRequests)
				.where(eq(t.infoRequests.incidentId, incidentId))
				.orderBy(asc(t.infoRequests.createdAt)),
			db
				.select()
				.from(t.actions)
				.where(eq(t.actions.incidentId, incidentId))
				.orderBy(asc(t.actions.seq)),
			db
				.select()
				.from(t.escalations)
				.where(eq(t.escalations.incidentId, incidentId))
				.orderBy(asc(t.escalations.seq)),
			db
				.select()
				.from(t.timelineEvents)
				.where(eq(t.timelineEvents.incidentId, incidentId))
				.orderBy(asc(t.timelineEvents.occurredAt)),
			db
				.select()
				.from(t.transcripts)
				.where(eq(t.transcripts.incidentId, incidentId))
				.orderBy(asc(t.transcripts.receivedAt)),
			listContacts(db)
		]);
	return {
		incident,
		facts: facts.map(mapFact),
		infoRequests: infoRequests.map(mapInfo),
		actions: actions.map(mapAction),
		escalations: escalations.map(mapEscalation),
		timeline: timeline.map(mapTimeline),
		transcripts: transcripts.map(mapTranscript),
		contacts
	};
}

export async function listIncidents(db: Tx, limit = 50) {
	const rows = await db
		.select()
		.from(t.incidents)
		.orderBy(desc(t.incidents.reportedAt))
		.limit(limit);
	if (!rows.length) return [];
	const ids = rows.map((r) => r.id);
	const [actionCounts, openEsc] = await Promise.all([
		db
			.select({
				incidentId: t.actions.incidentId,
				total: sql<number>`count(*)::int`,
				open: sql<number>`count(*) filter (where ${t.actions.status} not in ('completed','cancelled'))::int`
			})
			.from(t.actions)
			.where(inArray(t.actions.incidentId, ids))
			.groupBy(t.actions.incidentId),
		db
			.select({ incidentId: t.escalations.incidentId, open: sql<number>`count(*)::int` })
			.from(t.escalations)
			.where(and(inArray(t.escalations.incidentId, ids), eq(t.escalations.status, 'open')))
			.groupBy(t.escalations.incidentId)
	]);
	const ac = new Map(actionCounts.map((a) => [a.incidentId, a]));
	const ec = new Map(openEsc.map((e) => [e.incidentId, e.open]));
	return rows.map((r) => ({
		...mapIncident(r),
		actionsTotal: ac.get(r.id)?.total ?? 0,
		actionsOpen: ac.get(r.id)?.open ?? 0,
		openEscalations: ec.get(r.id) ?? 0
	}));
}

export async function nextIncidentCode(db: Tx): Promise<string> {
	const [row] = await db
		.select({ n: max(sql<number>`cast(substring(${t.incidents.code} from 5) as integer)`) })
		.from(t.incidents);
	// Numbering starts at INC-0040 so seeded history precedes the live demo incident.
	const next = Math.max(Number(row?.n) || 0, 39) + 1;
	return `INC-${String(next).padStart(4, '0')}`;
}

export async function nextSeq(
	db: Tx,
	table: typeof t.actions | typeof t.escalations,
	incidentId: string
) {
	const [row] = await db
		.select({ n: max(table.seq) })
		.from(table)
		.where(eq(table.incidentId, incidentId));
	return (row?.n ?? 0) + 1;
}

export async function addTimeline(
	db: Tx,
	event: Omit<typeof t.timelineEvents.$inferInsert, 'id'>
): Promise<void> {
	await db.insert(t.timelineEvents).values(event);
}

export async function touchIncident(
	db: Tx,
	incidentId: string,
	patch: Partial<typeof t.incidents.$inferInsert> = {}
) {
	await db
		.update(t.incidents)
		.set({ ...patch, updatedAt: new Date() })
		.where(eq(t.incidents.id, incidentId));
}

export async function latestReport(db: Tx, incidentId: string): Promise<ReportRecord | null> {
	const [row] = await db
		.select()
		.from(t.reports)
		.where(eq(t.reports.incidentId, incidentId))
		.orderBy(desc(t.reports.version))
		.limit(1);
	return (row as unknown as ReportRecord) ?? null;
}

/** Session telemetry computed from recorded rows — nothing estimated. */
export async function voiceSessionStats(db: Tx, incidentId: string): Promise<VoiceSessionStats[]> {
	const sessions = await db
		.select()
		.from(t.voiceSessions)
		.where(eq(t.voiceSessions.incidentId, incidentId))
		.orderBy(asc(t.voiceSessions.startedAt));
	if (!sessions.length) return [];
	const ids = sessions.map((s) => s.id);
	const [turns, tools] = await Promise.all([
		db
			.select({
				sessionId: t.transcripts.voiceSessionId,
				user: sql<number>`count(*) filter (where ${t.transcripts.speaker} = 'user')::int`,
				agent: sql<number>`count(*) filter (where ${t.transcripts.speaker} = 'agent')::int`,
				interrupted: sql<number>`count(*) filter (where ${t.transcripts.interrupted})::int`
			})
			.from(t.transcripts)
			.where(inArray(t.transcripts.voiceSessionId, ids))
			.groupBy(t.transcripts.voiceSessionId),
		db
			.select({
				sessionId: t.toolInvocations.voiceSessionId,
				total: sql<number>`count(*)::int`,
				failed: sql<number>`count(*) filter (where not ${t.toolInvocations.ok})::int`
			})
			.from(t.toolInvocations)
			.where(inArray(t.toolInvocations.voiceSessionId, ids))
			.groupBy(t.toolInvocations.voiceSessionId)
	]);
	const tm = new Map(turns.map((r) => [r.sessionId, r]));
	const to = new Map(tools.map((r) => [r.sessionId, r]));
	return sessions.map((s) => ({
		id: s.id,
		providerSessionId: s.providerSessionId,
		status: s.status,
		startedAt: s.readyAt ?? s.startedAt,
		endedAt: s.endedAt,
		durationSec: s.endedAt
			? Math.round((s.endedAt.getTime() - (s.readyAt ?? s.startedAt).getTime()) / 1000)
			: null,
		userTurns: tm.get(s.id)?.user ?? 0,
		agentTurns: tm.get(s.id)?.agent ?? 0,
		interruptions: tm.get(s.id)?.interrupted ?? 0,
		toolCalls: to.get(s.id)?.total ?? 0,
		toolErrors: to.get(s.id)?.failed ?? 0,
		reconnects: s.reconnects,
		errors: s.errorCount
	}));
}

export interface ToolInvocationRow {
	id: string;
	toolName: string;
	origin: string;
	ok: boolean;
	error: string | null;
	arguments: unknown;
	createdAt: Date;
}

export async function listToolInvocations(
	db: Tx,
	incidentId: string
): Promise<ToolInvocationRow[]> {
	return db
		.select({
			id: t.toolInvocations.id,
			toolName: t.toolInvocations.toolName,
			origin: t.toolInvocations.origin,
			ok: t.toolInvocations.ok,
			error: t.toolInvocations.error,
			arguments: t.toolInvocations.arguments,
			createdAt: t.toolInvocations.createdAt
		})
		.from(t.toolInvocations)
		.where(eq(t.toolInvocations.incidentId, incidentId))
		.orderBy(asc(t.toolInvocations.createdAt));
}
