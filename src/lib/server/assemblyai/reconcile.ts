import { and, asc, eq, inArray, isNull, lt, isNotNull } from 'drizzle-orm';
import { env } from '$lib/server/env';
import type { Database } from '../db';
import * as t from '../db/schema';
import { addTimeline } from '../incidents/repository';
import { normalizeText } from '$lib/domain/evidence';
import { log } from '../observability';

/**
 * Post-session reconciliation with AssemblyAI's own session record
 * (Sessions API: GET /v1/sessions/{id} → `timeline` artifact).
 *
 * SENTINEL's transcripts come from the live stream it relayed; AssemblyAI's
 * timeline is an independent record of the same conversation. Matching them
 * turn-by-turn gives each utterance a second witness and its STT confidence,
 * and flags any divergence on the incident timeline.
 */
const API = 'https://agents.assemblyai.com/v1';

interface ProviderTurn {
	status?: string;
	trigger?: string;
	user_transcript?: string | null;
	user_confidence?: number;
	agent_text?: string | null;
	tool_calls?: { name: string; is_error?: boolean }[];
}

type Fetch = typeof fetch;

export async function fetchProviderSession(sessionId: string, fetchImpl: Fetch = fetch) {
	const res = await fetchImpl(`${API}/sessions/${encodeURIComponent(sessionId)}`, {
		headers: { Authorization: env.ASSEMBLYAI_API_KEY ?? '' }
	});
	if (res.status === 404) return { status: 'missing' as const };
	if (!res.ok) throw new Error(`sessions API ${res.status}`);
	const body = (await res.json()) as {
		status?: string;
		artifacts?: { type: string; url: string }[];
	};
	return {
		status: 'ok' as const,
		sessionStatus: body.status ?? 'unknown',
		artifacts: body.artifacts ?? []
	};
}

export async function fetchTimeline(
	url: string,
	fetchImpl: Fetch = fetch
): Promise<ProviderTurn[]> {
	// Pre-signed artifact URL: no Authorization header (per AssemblyAI docs).
	const res = await fetchImpl(url);
	if (!res.ok) throw new Error(`timeline artifact ${res.status}`);
	const json = (await res.json()) as { turns?: ProviderTurn[] };
	return json.turns ?? [];
}

function similarity(a: string, b: string): number {
	const ta = new Set(normalizeText(a).split(' ').filter(Boolean));
	const tb = new Set(normalizeText(b).split(' ').filter(Boolean));
	if (!ta.size || !tb.size) return 0;
	let hit = 0;
	for (const w of ta) if (tb.has(w)) hit++;
	return hit / Math.max(ta.size, tb.size);
}

export interface Reconciliation extends Record<string, unknown> {
	status: 'reconciled' | 'unavailable';
	providerUserTurns: number;
	localUserTurns: number;
	matched: number;
	meanConfidence: number | null;
	minConfidence: number | null;
	providerToolCalls: number;
	localToolCalls: number;
	interruptedTurns: number;
}

/** Pure matching step (unit-tested): align provider user turns with local transcripts in order. */
export function matchTurns(
	provider: ProviderTurn[],
	local: { id: string; text: string }[]
): { matches: { transcriptId: string; confidence: number | null }[]; matched: number } {
	const users = provider.filter((p) => p.user_transcript);
	const matches: { transcriptId: string; confidence: number | null }[] = [];
	let li = 0;
	for (const p of users) {
		// Look ahead a little: live STT sometimes splits one provider turn into two finals.
		for (let j = li; j < Math.min(local.length, li + 3); j++) {
			const joined = local[j].text;
			if (
				similarity(p.user_transcript!, joined) >= 0.5 ||
				normalizeText(p.user_transcript!).includes(normalizeText(joined))
			) {
				matches.push({ transcriptId: local[j].id, confidence: p.user_confidence ?? null });
				li = j + 1;
				break;
			}
		}
	}
	return { matches, matched: matches.length };
}

export async function reconcileSession(
	db: Database,
	voiceSessionId: string,
	fetchImpl: Fetch = fetch
) {
	const [vs] = await db
		.select()
		.from(t.voiceSessions)
		.where(eq(t.voiceSessions.id, voiceSessionId));
	if (!vs?.providerSessionId) return null;
	const session = await fetchProviderSession(vs.providerSessionId, fetchImpl);
	const giveUp = vs.endedAt && Date.now() - vs.endedAt.getTime() > 24 * 3600 * 1000;
	const timelineUrl =
		session.status === 'ok' ? session.artifacts.find((a) => a.type === 'timeline')?.url : undefined;
	if (!timelineUrl) {
		if (giveUp || session.status === 'missing') {
			const rec: Reconciliation = {
				status: 'unavailable',
				providerUserTurns: 0,
				localUserTurns: 0,
				matched: 0,
				meanConfidence: null,
				minConfidence: null,
				providerToolCalls: 0,
				localToolCalls: 0,
				interruptedTurns: 0
			};
			await db
				.update(t.voiceSessions)
				.set({ reconciledAt: new Date(), reconciliation: rec })
				.where(eq(t.voiceSessions.id, vs.id));
			return rec;
		}
		return null; // artifacts appear once the session completes; retry later
	}
	const turns = await fetchTimeline(timelineUrl, fetchImpl);
	const local = await db
		.select({ id: t.transcripts.id, text: t.transcripts.text })
		.from(t.transcripts)
		.where(
			and(
				eq(t.transcripts.voiceSessionId, vs.id),
				eq(t.transcripts.speaker, 'user'),
				eq(t.transcripts.channel, 'voice')
			)
		)
		.orderBy(asc(t.transcripts.receivedAt));
	const { matches, matched } = matchTurns(turns, local);
	for (const m of matches) {
		if (m.confidence !== null) {
			await db
				.update(t.transcripts)
				.set({ sttConfidence: m.confidence })
				.where(eq(t.transcripts.id, m.transcriptId));
		}
	}
	const confidences = matches.map((m) => m.confidence).filter((c): c is number => c !== null);
	const localTools = await db
		.select({ id: t.toolInvocations.id })
		.from(t.toolInvocations)
		.where(eq(t.toolInvocations.voiceSessionId, vs.id));
	const rec: Reconciliation = {
		status: 'reconciled',
		providerUserTurns: turns.filter((x) => x.user_transcript).length,
		localUserTurns: local.length,
		matched,
		meanConfidence: confidences.length
			? +(confidences.reduce((a, b) => a + b, 0) / confidences.length).toFixed(3)
			: null,
		minConfidence: confidences.length ? Math.min(...confidences) : null,
		providerToolCalls: turns.reduce((n, x) => n + (x.tool_calls?.length ?? 0), 0),
		localToolCalls: localTools.length,
		interruptedTurns: turns.filter((x) => x.status === 'interrupted').length
	};
	await db
		.update(t.voiceSessions)
		.set({ reconciledAt: new Date(), reconciliation: rec })
		.where(eq(t.voiceSessions.id, vs.id));
	if (vs.incidentId) {
		const toolsAgree = rec.providerToolCalls === rec.localToolCalls;
		await addTimeline(db, {
			incidentId: vs.incidentId,
			eventType: 'transcript_reconciled',
			description: `Voice record reconciled with AssemblyAI's session record: ${rec.matched}/${rec.providerUserTurns} user turns matched${rec.meanConfidence !== null ? `, mean STT confidence ${rec.meanConfidence}` : ''}${rec.minConfidence !== null && rec.minConfidence < 0.8 ? ` (lowest ${rec.minConfidence}: check that utterance)` : ''}; tool calls ${toolsAgree ? `agree (${rec.localToolCalls})` : `DIFFER (provider ${rec.providerToolCalls}, audit log ${rec.localToolCalls})`}`,
			source: 'system',
			metadata: rec,
			refType: 'voice_session',
			refId: vs.id
		});
	}
	return rec;
}

/** Sessions that ended at least 20 s ago and haven't been reconciled yet. */
export async function pendingReconciliations(db: Database, limit = 5) {
	return db
		.select({ id: t.voiceSessions.id })
		.from(t.voiceSessions)
		.where(
			and(
				isNotNull(t.voiceSessions.providerSessionId),
				isNull(t.voiceSessions.reconciledAt),
				inArray(t.voiceSessions.status, ['ended', 'error']),
				lt(t.voiceSessions.endedAt, new Date(Date.now() - 20_000))
			)
		)
		.limit(limit);
}

export async function deleteProviderSession(
	sessionId: string,
	fetchImpl: Fetch = fetch
): Promise<boolean> {
	const res = await fetchImpl(`${API}/sessions/${encodeURIComponent(sessionId)}`, {
		method: 'DELETE',
		headers: { Authorization: env.ASSEMBLYAI_API_KEY ?? '' }
	});
	if (res.status === 204 || res.status === 404) return true;
	log.warn('provider session delete failed', { status: res.status });
	return false;
}

/** Fresh pre-signed recording URL for playback (URLs expire quickly; never stored). */
export async function recordingUrl(
	providerSessionId: string,
	fetchImpl: Fetch = fetch
): Promise<string | null> {
	const s = await fetchProviderSession(providerSessionId, fetchImpl);
	return s.status === 'ok' ? (s.artifacts.find((a) => a.type === 'audio')?.url ?? null) : null;
}
