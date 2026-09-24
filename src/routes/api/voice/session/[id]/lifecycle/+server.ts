import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db';
import { idParam, rateLimit, readJson } from '$lib/server/http';
import { recordLifecycle } from '$lib/server/assemblyai/voice-sessions';
import { NotFoundError } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

const body = z.object({
	event: z.enum(['ready', 'resumed', 'disconnected', 'ended', 'error']),
	providerSessionId: z.string().max(128).optional(),
	reason: z.string().max(300).optional()
});

export const POST: RequestHandler = async (event) => {
	rateLimit(event, 'voice-lifecycle', 60);
	const id = idParam.parse(event.params.id);
	const input = await readJson(event.request, body);
	try {
		await recordLifecycle(await getDb(), id, input.event, input);
	} catch (e) {
		if (e instanceof NotFoundError) error(404, e.message);
		throw e;
	}
	return json({ ok: true });
};
