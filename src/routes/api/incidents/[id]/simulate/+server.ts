import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db';
import { idParam, rateLimit, readJson, requireRole } from '$lib/server/http';
import { simulate, SimulationError } from '$lib/server/demo/simulator';
import { getIncidentInOrg, NotFoundError } from '$lib/server/incidents/repository';
import { voiceBus } from '$lib/server/voice/bus';
import type { RequestHandler } from './$types';

const body = z.object({ kind: z.enum(['contact_responds', 'escalation_acknowledged']) });

/** DEMO SIMULATION of an external actor. Rejected for non-demo incidents. */
export const POST: RequestHandler = async (event) => {
	const auth = requireRole(event, 'coordinator');
	await rateLimit(event, 'simulate', 30);
	const id = idParam.parse(event.params.id);
	const { kind } = await readJson(event.request, body);
	const db = await getDb();
	try {
		await getIncidentInOrg(db, auth.orgId, id);
		const result = await simulate(db, id, kind);
		// Tell any live caller, just as a real reply would be announced.
		if (result.ok) voiceBus.notify(id, `${result.message} (demo simulation)`);
		return json(result, { status: result.ok ? 200 : 422 });
	} catch (e) {
		if (e instanceof SimulationError) error(409, e.message);
		if (e instanceof NotFoundError) error(404, 'Incident not found');
		throw e;
	}
};
