import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db';
import { idParam, rateLimit, readJson } from '$lib/server/http';
import { saveTranscript } from '$lib/server/assemblyai/voice-sessions';
import { NotFoundError } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

const body = z.object({
	speaker: z.enum(['user', 'agent']),
	text: z.string().trim().min(1).max(4000),
	channel: z.enum(['voice', 'typed']).default('voice'),
	interrupted: z.boolean().optional(),
	offsetMs: z
		.number()
		.int()
		.min(0)
		.max(24 * 3600 * 1000)
		.optional(),
	itemId: z.string().max(128).optional()
});

/** Persist final transcripts — the evidence that facts are traced back to. */
export const POST: RequestHandler = async (event) => {
	rateLimit(event, 'voice-transcripts', 240);
	const id = idParam.parse(event.params.id);
	const input = await readJson(event.request, body);
	try {
		const row = await saveTranscript(await getDb(), id, input);
		return json({ id: row.id, incidentId: row.incidentId });
	} catch (e) {
		if (e instanceof NotFoundError) error(404, e.message);
		throw e;
	}
};
