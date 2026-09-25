import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { idParam, rateLimit, requireRole } from '$lib/server/http';
import { getIncidentInOrg, NotFoundError } from '$lib/server/incidents/repository';
import { escalationSweep } from '$lib/server/jobs/scheduler';
import type { RequestHandler } from './$types';

/**
 * Manual "check now". The scheduler evaluates response timeouts every few
 * seconds on its own; this only lets a coordinator trigger it immediately.
 */
export const POST: RequestHandler = async (event) => {
	const auth = requireRole(event, 'coordinator');
	await rateLimit(event, 'escalation-check', 30);
	const id = idParam.parse(event.params.id);
	const db = await getDb();
	try {
		await getIncidentInOrg(db, auth.orgId, id);
	} catch (e) {
		if (e instanceof NotFoundError) error(404, 'Incident not found');
		throw e;
	}
	const announced = await escalationSweep(db);
	return json({ created: announced.filter((a) => a.incidentId === id) });
};
