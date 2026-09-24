import { json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { rateLimit } from '$lib/server/http';
import { listIncidents } from '$lib/server/incidents/repository';
import { serialize } from '$lib/domain/view';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async (event) => {
	rateLimit(event, 'incidents-list', 120);
	return json(serialize(await listIncidents(await getDb())));
};
