import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db';
import { idParam, rateLimit, readJson } from '$lib/server/http';
import { simulate, SimulationError } from '$lib/server/demo/simulator';
import { NotFoundError } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

const body = z.object({ kind: z.enum(['contact_responds', 'escalation_acknowledged']) });

/** DEMO SIMULATION of an external actor. Rejected for non-demo incidents. */
export const POST: RequestHandler = async (event) => {
	rateLimit(event, 'simulate', 30);
	const id = idParam.parse(event.params.id);
	const { kind } = await readJson(event.request, body);
	try {
		const result = await simulate(await getDb(), id, kind);
		return json(result, { status: result.ok ? 200 : 422 });
	} catch (e) {
		if (e instanceof SimulationError) error(409, e.message);
		if (e instanceof NotFoundError) error(404, e.message);
		throw e;
	}
};
