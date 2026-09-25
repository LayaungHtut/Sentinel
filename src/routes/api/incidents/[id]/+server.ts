import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { idParam, rateLimit, requireRole } from '$lib/server/http';
import { getIncidentInOrg, NotFoundError } from '$lib/server/incidents/repository';
import { loadIncidentView } from '$lib/server/incidents/view';
import type { RequestHandler } from './$types';

/** Full incident view: record + evidence + actions + timeline + derived state (org-scoped). */
export const GET: RequestHandler = async (event) => {
	const auth = requireRole(event, 'reporter');
	await rateLimit(event, 'incident-view', 300);
	const id = idParam.parse(event.params.id);
	const db = await getDb();
	try {
		await getIncidentInOrg(db, auth.orgId, id);
		return json(await loadIncidentView(db, id), { headers: { 'cache-control': 'no-store' } });
	} catch (e) {
		if (e instanceof NotFoundError) error(404, 'Incident not found');
		throw e;
	}
};
