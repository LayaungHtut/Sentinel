import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { idParam, rateLimit } from '$lib/server/http';
import { sessionConfigFor } from '$lib/server/assemblyai/voice-sessions';
import { NotFoundError } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

/** Mid-session session.update: current tool tier + refreshed incident state in the prompt. */
export const GET: RequestHandler = async (event) => {
	rateLimit(event, 'voice-config', 120);
	const id = idParam.parse(event.params.id);
	try {
		const config = await sessionConfigFor(await getDb(), id, false);
		return json({ tier: config.tier, sessionUpdate: config.session });
	} catch (e) {
		if (e instanceof NotFoundError) error(404, e.message);
		throw e;
	}
};
