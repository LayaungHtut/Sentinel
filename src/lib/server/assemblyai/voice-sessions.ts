import { and, eq, gte, inArray, sql } from 'drizzle-orm';
import type { Database } from '../db';
import * as t from '../db/schema';
import {
	addTimeline,
	getIncidentInOrg,
	getOrg,
	getOrgSettings,
	listContacts,
	loadSnapshot,
	NotFoundError
} from '../incidents/repository';
import { buildSessionUpdate } from './session-config';
import { getScenario } from '$lib/demo/scenarios';
import { metrics } from '../observability';

export class QuotaError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'QuotaError';
	}
}

export async function getVoiceSession(db: Database, id: string) {
	const [row] = await db.select().from(t.voiceSessions).where(eq(t.voiceSessions.id, id));
	if (!row) throw new NotFoundError('Voice session not found.');
	return row;
}

/**
 * Voice cost controls from organisation policy: concurrent sessions and
 * minutes used today (UTC). Checked before any AssemblyAI session is opened.
 */
export async function assertVoiceQuota(db: Database, orgId: string) {
	const settings = await getOrgSettings(db, orgId);
	const [live] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(t.voiceSessions)
		.where(
			and(
				eq(t.voiceSessions.orgId, orgId),
				inArray(t.voiceSessions.status, ['connecting', 'active', 'reconnecting']),
				// Ignore rows stuck from a crashed process.
				gte(t.voiceSessions.startedAt, new Date(Date.now() - 3 * 3600 * 1000))
			)
		);
	if (live.n >= settings.voiceMaxConcurrent) {
		throw new QuotaError(
			`Your organisation already has ${live.n} live voice session(s) (limit ${settings.voiceMaxConcurrent}). End one, or continue manually.`
		);
	}
	const dayStart = new Date();
	dayStart.setUTCHours(0, 0, 0, 0);
	const [used] = await db
		.select({
			sec: sql<number>`coalesce(sum(extract(epoch from (coalesce(${t.voiceSessions.endedAt}, now()) - coalesce(${t.voiceSessions.readyAt}, ${t.voiceSessions.startedAt})))), 0)::float`
		})
		.from(t.voiceSessions)
		.where(and(eq(t.voiceSessions.orgId, orgId), gte(t.voiceSessions.startedAt, dayStart)));
	if (used.sec / 60 >= settings.voiceDailyMinutes) {
		throw new QuotaError(
			`Today's voice allowance (${settings.voiceDailyMinutes} min) is used up. An administrator can raise it in Settings. Manual reporting still works.`
		);
	}
}

export async function createVoiceSession(
	db: Database,
	opts: {
		orgId: string;
		userId: string;
		incidentId?: string | null;
		scenario?: string | null;
		consentAt: Date;
	}
) {
	const org = await getOrg(db, opts.orgId);
	let isDemo = org.isDemo;
	if (opts.incidentId) {
		const incident = await getIncidentInOrg(db, opts.orgId, opts.incidentId);
		if (incident.status === 'closed') throw new NotFoundError(`${incident.code} is closed.`);
		isDemo = incident.isDemo;
	}
	await assertVoiceQuota(db, opts.orgId);
	const [row] = await db
		.insert(t.voiceSessions)
		.values({
			orgId: opts.orgId,
			userId: opts.userId,
			consentAt: opts.consentAt,
			incidentId: opts.incidentId ?? null,
			scenario: isDemo ? (getScenario(opts.scenario)?.id ?? null) : null,
			isDemo,
			status: 'connecting'
		})
		.returning();
	return row;
}

/** The session.update payload for the session's current state (tier + live incident record). */
export async function sessionConfigFor(db: Database, voiceSessionId: string, initial: boolean) {
	const session = await getVoiceSession(db, voiceSessionId);
	const [snap, contacts, settings] = await Promise.all([
		session.incidentId ? loadSnapshot(db, session.incidentId) : Promise.resolve(null),
		listContacts(db, session.orgId),
		getOrgSettings(db, session.orgId)
	]);
	return buildSessionUpdate({
		now: new Date(),
		snap,
		contacts,
		isDemo: session.isDemo,
		scenario: getScenario(session.scenario),
		responseTimeoutSeconds: settings.responseTimeoutSeconds,
		initial
	});
}

export type LifecycleEvent = 'ready' | 'resumed' | 'disconnected' | 'ended' | 'error';

export async function recordLifecycle(
	db: Database,
	voiceSessionId: string,
	event: LifecycleEvent,
	detail: { providerSessionId?: string; reason?: string }
) {
	const session = await getVoiceSession(db, voiceSessionId);
	const now = new Date();
	const patch: Partial<typeof t.voiceSessions.$inferInsert> = {};
	if (event === 'ready') {
		patch.status = 'active';
		patch.readyAt = session.readyAt ?? now;
		if (detail.providerSessionId) patch.providerSessionId = detail.providerSessionId;
	} else if (event === 'resumed') {
		patch.status = 'active';
		if (detail.providerSessionId) patch.providerSessionId = detail.providerSessionId;
	} else if (event === 'disconnected') {
		patch.status = 'reconnecting';
		patch.reconnects = session.reconnects + 1;
	} else {
		if (session.status === 'ended' || session.status === 'error') return;
		patch.status = event === 'ended' ? 'ended' : 'error';
		if (event === 'error') patch.errorCount = session.errorCount + 1;
		patch.endedAt = now;
		patch.endReason = detail.reason?.slice(0, 200) ?? null;
		const seconds = (now.getTime() - (session.readyAt ?? session.startedAt).getTime()) / 1000;
		metrics.voiceSessions.inc({ outcome: event });
		metrics.voiceSeconds.inc({}, Math.max(0, seconds));
	}
	await db.update(t.voiceSessions).set(patch).where(eq(t.voiceSessions.id, voiceSessionId));

	if (session.incidentId) {
		const text: Record<LifecycleEvent, string> = {
			ready: 'Voice session connected (AssemblyAI Voice Agent)',
			resumed: detail.reason ?? 'Voice connection restored',
			disconnected: 'Voice connection lost — reconnecting',
			ended: `Voice session ended${detail.reason ? ` (${detail.reason.slice(0, 80)})` : ''}`,
			error: `Voice session failed${detail.reason ? `: ${detail.reason.slice(0, 120)}` : ''} — incident data preserved`
		};
		await addTimeline(db, {
			incidentId: session.incidentId,
			eventType: `voice_${event}`,
			description: text[event],
			source: 'system',
			metadata: detail.providerSessionId ? { providerSessionId: detail.providerSessionId } : null,
			occurredAt: now
		});
	}
}

/** Server-side only: transcripts come from the AssemblyAI stream the relay holds. */
export async function saveTranscript(
	db: Database,
	voiceSessionId: string,
	input: {
		speaker: 'user' | 'agent';
		text: string;
		channel: 'voice' | 'typed';
		userId?: string | null;
		interrupted?: boolean;
		offsetMs?: number;
		itemId?: string;
	}
) {
	const session = await getVoiceSession(db, voiceSessionId);
	const [row] = await db
		.insert(t.transcripts)
		.values({
			voiceSessionId,
			incidentId: session.incidentId,
			speaker: input.speaker,
			userId: input.speaker === 'user' ? (input.userId ?? session.userId) : null,
			text: input.text,
			channel: input.channel,
			interrupted: input.interrupted ?? false,
			offsetMs: input.offsetMs ?? null,
			providerItemId: input.itemId ?? null
		})
		.returning();
	return row;
}
