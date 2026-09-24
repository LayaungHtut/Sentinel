import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { idParam, rateLimit } from '$lib/server/http';
import { mintVoiceAgentToken, TokenError } from '$lib/server/assemblyai/token';
import { getVoiceSession } from '$lib/server/assemblyai/voice-sessions';
import { NotFoundError } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

/** Fresh single-use token for reconnecting with session.resume. */
export const POST: RequestHandler = async (event) => {
	rateLimit(event, 'voice-token', 20);
	const id = idParam.parse(event.params.id);
	const db = await getDb();
	try {
		const session = await getVoiceSession(db, id);
		if (session.status === 'ended' || session.status === 'error')
			error(409, 'Voice session has ended.');
		return json({ token: await mintVoiceAgentToken() });
	} catch (e) {
		if (e instanceof TokenError) error(e.status, e.message);
		if (e instanceof NotFoundError) error(404, e.message);
		throw e;
	}
};
