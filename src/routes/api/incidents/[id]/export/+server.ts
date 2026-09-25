import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { notifications } from '$lib/server/db/schema';
import { idParam, rateLimit, requireRole } from '$lib/server/http';
import { verifyChain } from '$lib/server/incidents/audit';
import {
	getIncidentInOrg,
	listToolInvocations,
	loadSnapshot,
	NotFoundError
} from '$lib/server/incidents/repository';
import { log } from '$lib/server/observability';
import { serialize } from '$lib/domain/view';
import type { RequestHandler } from './$types';

/**
 * Full machine-readable record of one incident (data portability / legal
 * hold / insurer requests): facts with supersession history, transcripts,
 * actions, escalations, the hash-chained timeline with its verification
 * result, the tool-call audit log and notification outcomes.
 * Photo bytes are listed by hash; fetch them via /api/attachments/[id].
 */
export const GET: RequestHandler = async (event) => {
	const auth = requireRole(event, 'manager');
	await rateLimit(event, 'export', 20);
	const id = idParam.parse(event.params.id);
	const db = await getDb();
	await getIncidentInOrg(db, auth.orgId, id).catch((e) => {
		if (e instanceof NotFoundError) error(404, 'Incident not found');
		throw e;
	});
	const [snap, calls, notes, chain] = await Promise.all([
		loadSnapshot(db, id),
		listToolInvocations(db, id),
		db.select().from(notifications).where(eq(notifications.incidentId, id)),
		verifyChain(db, id)
	]);
	log.info('incident exported', { incidentId: id, userId: auth.userId });
	const body = serialize({
		format: 'sentinel.incident-export/v1',
		exportedAt: new Date(),
		exportedBy: { userId: auth.userId, name: auth.userName },
		organization: { id: auth.orgId, name: auth.orgName },
		incident: snap.incident,
		facts: snap.facts,
		infoRequests: snap.infoRequests,
		actions: snap.actions,
		escalations: snap.escalations,
		transcripts: snap.transcripts,
		timeline: snap.timeline,
		timelineVerification: chain,
		toolInvocations: calls,
		notifications: notes.map((n) => ({ ...n, ackTokenHash: undefined }))
	});
	return json(body, {
		headers: {
			'content-disposition': `attachment; filename="${snap.incident.code}-export.json"`,
			'cache-control': 'no-store'
		}
	});
};
