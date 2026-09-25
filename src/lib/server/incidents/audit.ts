import { asc, desc, eq, sql } from 'drizzle-orm';
import * as t from '../db/schema';
import { sha256Hex } from '../db/crypto';
import type { Tx } from './repository';

/**
 * Tamper-evident timeline: every event carries a per-incident sequence number
 * and SHA-256(prev_hash + canonical event). The table is append-only at the
 * database level (trigger), and `verifyChain` detects any edited, removed or
 * reordered event.
 */

type TimelineInsert = Omit<
	typeof t.timelineEvents.$inferInsert,
	'id' | 'chainSeq' | 'prevHash' | 'hash'
>;

/** Deterministic JSON: object keys sorted recursively (jsonb does not keep key order). */
export function canonical(value: unknown): string {
	if (value === null || value === undefined) return 'null';
	if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
	if (value instanceof Date) return JSON.stringify(value.toISOString());
	if (typeof value === 'object') {
		return `{${Object.keys(value as object)
			.sort()
			.filter((k) => (value as Record<string, unknown>)[k] !== undefined)
			.map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`)
			.join(',')}}`;
	}
	return JSON.stringify(value);
}

export function eventHash(e: {
	prevHash: string | null;
	incidentId: string;
	chainSeq: number;
	eventType: string;
	description: string;
	source: string;
	actor: string | null;
	toolName: string | null;
	refType: string | null;
	refId: string | null;
	metadata: Record<string, unknown> | null;
	occurredAt: Date;
}): string {
	return sha256Hex(
		canonical([
			e.prevHash,
			e.incidentId,
			e.chainSeq,
			e.eventType,
			e.description,
			e.source,
			e.actor,
			e.toolName,
			e.refType,
			e.refId,
			e.metadata,
			// Millisecond precision: what Postgres timestamptz round-trips.
			new Date(e.occurredAt).toISOString()
		])
	);
}

export async function appendTimeline(db: Tx, event: TimelineInsert): Promise<void> {
	// Serialise appends per incident so sequence numbers and links never fork.
	await db.execute(sql`select pg_advisory_xact_lock(hashtext(${event.incidentId}))`);
	const [last] = await db
		.select({ seq: t.timelineEvents.chainSeq, hash: t.timelineEvents.hash })
		.from(t.timelineEvents)
		.where(eq(t.timelineEvents.incidentId, event.incidentId))
		.orderBy(desc(t.timelineEvents.chainSeq))
		.limit(1);
	const chainSeq = (last?.seq ?? 0) + 1;
	const prevHash = last?.hash ?? null;
	// Truncate to milliseconds so the stored value hashes identically on read.
	const occurredAt = new Date(Math.floor((event.occurredAt ?? new Date()).getTime()));
	const row = {
		incidentId: event.incidentId,
		eventType: event.eventType,
		description: event.description,
		source: event.source,
		actor: event.actor ?? null,
		toolName: event.toolName ?? null,
		refType: event.refType ?? null,
		refId: event.refId ?? null,
		metadata: (event.metadata as Record<string, unknown> | null | undefined) ?? null,
		occurredAt
	};
	const hash = eventHash({ ...row, prevHash, chainSeq });
	await db.insert(t.timelineEvents).values({ ...row, chainSeq, prevHash, hash });
}

export interface ChainVerification {
	ok: boolean;
	events: number;
	verified: number;
	/** Events written before the chain existed (no hash), not verifiable. */
	legacy: number;
	brokenAt: number | null;
	reason: string | null;
	headHash: string | null;
}

export async function verifyChain(db: Tx, incidentId: string): Promise<ChainVerification> {
	const rows = await db
		.select()
		.from(t.timelineEvents)
		.where(eq(t.timelineEvents.incidentId, incidentId))
		.orderBy(asc(t.timelineEvents.chainSeq));
	let prev: string | null = null;
	let verified = 0;
	let legacy = 0;
	// Chains start at 1, so a deleted first event is detected too.
	let expectedSeq = 1;
	for (const r of rows) {
		if (r.chainSeq !== expectedSeq) {
			return {
				ok: false,
				events: rows.length,
				verified,
				legacy,
				brokenAt: r.chainSeq,
				reason: `sequence gap before #${r.chainSeq} (an event is missing)`,
				headHash: prev
			};
		}
		expectedSeq++;
		if (!r.hash) {
			legacy++;
			prev = null;
			continue;
		}
		if (r.prevHash !== prev) {
			return {
				ok: false,
				events: rows.length,
				verified,
				legacy,
				brokenAt: r.chainSeq,
				reason: `link broken at #${r.chainSeq}`,
				headHash: prev
			};
		}
		const recomputed = eventHash({
			prevHash: r.prevHash,
			incidentId: r.incidentId,
			chainSeq: r.chainSeq,
			eventType: r.eventType,
			description: r.description,
			source: r.source,
			actor: r.actor,
			toolName: r.toolName,
			refType: r.refType,
			refId: r.refId,
			metadata: r.metadata ?? null,
			occurredAt: r.occurredAt
		});
		if (recomputed !== r.hash) {
			return {
				ok: false,
				events: rows.length,
				verified,
				legacy,
				brokenAt: r.chainSeq,
				reason: `content altered at #${r.chainSeq}`,
				headHash: prev
			};
		}
		prev = r.hash;
		verified++;
	}
	return {
		ok: true,
		events: rows.length,
		verified,
		legacy,
		brokenAt: null,
		reason: null,
		headHash: prev
	};
}
