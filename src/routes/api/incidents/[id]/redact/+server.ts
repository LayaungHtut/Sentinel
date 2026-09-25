import { error, json } from '@sveltejs/kit';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '$lib/server/db';
import { facts, transcripts } from '$lib/server/db/schema';
import { idParam, rateLimit, readJson, requireRole } from '$lib/server/http';
import { addTimeline, getIncidentInOrg, NotFoundError } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

const body = z.object({
	/** Transcript lines to redact; omit to redact every line of the incident. */
	transcriptIds: z.array(z.string().max(64)).max(500).optional(),
	reason: z.string().min(3).max(300)
});

/**
 * Privacy request / accidental personal data: replace transcript text and the
 * evidence quotes traced to it. Structured facts and the hash-chained timeline
 * stay intact, and the redaction itself is recorded on the chain.
 */
export const POST: RequestHandler = async (event) => {
	const auth = requireRole(event, 'admin');
	await rateLimit(event, 'redact', 20);
	const id = idParam.parse(event.params.id);
	const input = await readJson(event.request, body);
	const db = await getDb();
	await getIncidentInOrg(db, auth.orgId, id).catch((e) => {
		if (e instanceof NotFoundError) error(404, 'Incident not found');
		throw e;
	});
	const marker = `[redacted by ${auth.userName}]`;
	const now = new Date();
	const count = await db.transaction(async (tx) => {
		const where = and(
			eq(transcripts.incidentId, id),
			isNull(transcripts.redactedAt),
			input.transcriptIds ? inArray(transcripts.id, input.transcriptIds) : undefined
		);
		const rows = await tx
			.update(transcripts)
			.set({ text: marker, redactedAt: now })
			.where(where)
			.returning({ id: transcripts.id });
		if (!rows.length) return 0;
		await tx
			.update(facts)
			.set({ evidenceQuote: marker })
			.where(
				and(
					eq(facts.incidentId, id),
					inArray(
						facts.transcriptId,
						rows.map((r) => r.id)
					)
				)
			);
		await addTimeline(tx, {
			incidentId: id,
			eventType: 'transcript_redacted',
			description: `${rows.length} transcript line(s) redacted by ${auth.userName}: ${input.reason}`,
			source: 'operator',
			actor: auth.userName,
			metadata: { transcriptIds: rows.map((r) => r.id) }
		});
		return rows.length;
	});
	return json({ ok: true, redacted: count });
};
