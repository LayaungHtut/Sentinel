import type { TimelineRecord, TranscriptRecord } from './types';

/**
 * Incident replay: reconstructs the recorded chain
 *   voice → transcript → tool call → record change → SENTINEL reply
 * purely from stored rows (transcripts, tool audit log, timeline). Each user
 * turn owns everything recorded until the next user turn.
 */
export interface ReplayToolCall {
	id: string;
	toolName: string;
	ok: boolean;
	error: string | null;
	origin: string;
	at: Date;
}

export interface ReplayTurn {
	index: number;
	/** null for records made before the first utterance (e.g. operator entries). */
	utterance: { text: string; channel: string; at: Date } | null;
	toolCalls: ReplayToolCall[];
	changes: { eventType: string; description: string; source: string; at: Date }[];
	replies: { text: string; interrupted: boolean; at: Date }[];
}

export function buildReplay(
	transcripts: Pick<
		TranscriptRecord,
		'speaker' | 'text' | 'channel' | 'interrupted' | 'receivedAt'
	>[],
	toolCalls: ReplayToolCall[],
	timeline: Pick<TimelineRecord, 'eventType' | 'description' | 'source' | 'occurredAt'>[]
): ReplayTurn[] {
	const users = transcripts
		.filter((t) => t.speaker === 'user')
		.sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
	const bounds = users.map((u) => u.receivedAt.getTime());
	/** Index of the turn owning time t (-1 = before the first utterance). */
	const owner = (t: number) => {
		let i = -1;
		while (i + 1 < bounds.length && bounds[i + 1] <= t) i++;
		return i;
	};
	const turns: ReplayTurn[] = [
		{ index: 0, utterance: null, toolCalls: [], changes: [], replies: [] },
		...users.map((u, i) => ({
			index: i + 1,
			utterance: { text: u.text, channel: u.channel, at: u.receivedAt },
			toolCalls: [] as ReplayToolCall[],
			changes: [] as ReplayTurn['changes'],
			replies: [] as ReplayTurn['replies']
		}))
	];
	const slot = (t: Date) => turns[owner(t.getTime()) + 1];

	for (const c of toolCalls) slot(c.at).toolCalls.push(c);
	for (const e of timeline) {
		if (e.eventType.startsWith('voice_')) continue;
		slot(e.occurredAt).changes.push({
			eventType: e.eventType,
			description: e.description,
			source: e.source,
			at: e.occurredAt
		});
	}
	for (const t of transcripts.filter((x) => x.speaker === 'agent')) {
		slot(t.receivedAt).replies.push({ text: t.text, interrupted: t.interrupted, at: t.receivedAt });
	}
	return turns.filter((t) => t.utterance || t.toolCalls.length || t.changes.length);
}
