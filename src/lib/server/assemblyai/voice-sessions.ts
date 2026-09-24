import { eq } from 'drizzle-orm';
import type { Database } from '../db';
import * as t from '../db/schema';
import {
	addTimeline,
	getIncident,
	listContacts,
	loadSnapshot,
	NotFoundError
} from '../incidents/repository';
import { buildSessionUpdate } from './session-config';
import { getScenario } from '$lib/demo/scenarios';

export async function getVoiceSession(db: Database, id: string) {
	const [row] = await db.select().from(t.voiceSessions).where(eq(t.voiceSessions.id, id));
	if (!row) throw new NotFoundError('Voice session not found.');
	return row;
}

export async function createVoiceSession(
	db: Database,
	opts: { incidentId?: string | null; scenario?: string | null }
) {
	let isDemo = !!getScenario(opts.scenario);
	if (opts.incidentId) {
		const incident = await getIncident(db, opts.incidentId);
		if (incident.status === 'closed') throw new NotFoundError(`${incident.code} is closed.`);
		isDemo = incident.isDemo;
	}
	const [row] = await db
		.insert(t.voiceSessions)
		.values({
			incidentId: opts.incidentId ?? null,
			scenario: getScenario(opts.scenario)?.id ?? null,
			isDemo,
			status: 'connecting'
		})
		.returning();
	return row;
}

/** The session.update payload for the session's current state (tier + live incident record). */
export async function sessionConfigFor(db: Database, voiceSessionId: string, initial: boolean) {
	const session = await getVoiceSession(db, voiceSessionId);
	const [snap, contacts] = await Promise.all([
		session.incidentId ? loadSnapshot(db, session.incidentId) : Promise.resolve(null),
		listContacts(db)
	]);
	return buildSessionUpdate({
		now: new Date(),
		snap,
		contacts,
		isDemo: session.isDemo,
		scenario: getScenario(session.scenario),
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
		patch.readyAt = now;
		if (detail.providerSessionId) patch.providerSessionId = detail.providerSessionId;
	} else if (event === 'resumed') {
		patch.status = 'active';
	} else if (event === 'disconnected') {
		patch.status = 'reconnecting';
		patch.reconnects = session.reconnects + 1;
	} else {
		if (session.status === 'ended' || session.status === 'error') return;
		patch.status = event === 'ended' ? 'ended' : 'error';
		if (event === 'error') patch.errorCount = session.errorCount + 1;
		patch.endedAt = now;
		patch.endReason = detail.reason?.slice(0, 200) ?? null;
	}
	await db.update(t.voiceSessions).set(patch).where(eq(t.voiceSessions.id, voiceSessionId));

	if (session.incidentId) {
		const text: Record<LifecycleEvent, string> = {
			ready: 'Voice session connected (AssemblyAI Voice Agent)',
			resumed: 'Voice connection restored (session resumed)',
			disconnected: 'Voice connection lost — reconnecting',
			ended: 'Voice session ended',
			error: `Voice session failed${detail.reason ? `: ${detail.reason.slice(0, 120)}` : ''} — incident data preserved`
		};
		await addTimeline(db, {
			incidentId: session.incidentId,
			eventType: `voice_${event}`,
			description: text[event],
			source: 'system',
			occurredAt: now
		});
	}
}

export async function saveTranscript(
	db: Database,
	voiceSessionId: string,
	input: {
		speaker: 'user' | 'agent';
		text: string;
		channel: 'voice' | 'typed';
		interrupted?: boolean;
		offsetMs?: number;
		itemId?: string;
	}
) {
	const session = await getVoiceSession(db, voiceSessionId);
	if (session.status === 'ended' || session.status === 'error') {
		throw new NotFoundError('Voice session has ended.');
	}
	const [row] = await db
		.insert(t.transcripts)
		.values({
			voiceSessionId,
			incidentId: session.incidentId,
			speaker: input.speaker,
			text: input.text,
			channel: input.channel,
			interrupted: input.interrupted ?? false,
			offsetMs: input.offsetMs ?? null,
			providerItemId: input.itemId ?? null
		})
		.returning();
	return row;
}
