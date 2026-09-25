import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { idParam, rateLimit, requireRole } from '$lib/server/http';
import { verifyChain } from '$lib/server/incidents/audit';
import { getIncidentInOrg, NotFoundError } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

/** Re-verify the incident's timeline hash chain from the stored rows. */
export const GET: RequestHandler = async (event) => {
	const auth = requireRole(event, 'reporter');
	await rateLimit(event, 'audit-verify', 60);
	const id = idParam.parse(event.params.id);
	const db = await getDb();
	await getIncidentInOrg(db, auth.orgId, id).catch((e) => {
		if (e instanceof NotFoundError) error(404, 'Incident not found');
		throw e;
	});
	return json(await verifyChain(db, id));
};
