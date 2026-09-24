import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { idParam, rateLimit } from '$lib/server/http';
import { NotFoundError } from '$lib/server/incidents/repository';
import { loadIncidentView } from '$lib/server/incidents/view';
import type { RequestHandler } from './$types';

/** Full incident view: record + facts + evidence + actions + timeline + derived severity/checklist. */
export const GET: RequestHandler = async (event) => {
	rateLimit(event, 'incident-view', 300);
	const id = idParam.parse(event.params.id);
	try {
		return json(await loadIncidentView(await getDb(), id), {
			headers: { 'cache-control': 'no-store' }
		});
	} catch (e) {
		if (e instanceof NotFoundError) error(404, e.message);
		throw e;
	}
};
