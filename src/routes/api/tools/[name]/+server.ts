import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db';
import { rateLimit, readJson } from '$lib/server/http';
import { executeTool } from '$lib/server/tools/executor';
import { isToolName } from '$lib/server/tools/schemas';
import type { RequestHandler } from './$types';

const body = z.object({
	voiceSessionId: z.string().max(64).nullish(),
	incidentId: z.string().max(64).nullish(),
	callId: z.string().max(128).nullish(),
	arguments: z.record(z.string(), z.unknown()).default({})
});

/**
 * Executes a SENTINEL tool. Called by the browser when the AssemblyAI agent
 * emits tool.call (origin "voice", bound to a voice session), and by the
 * dashboard's manual controls (origin "operator", bound to an incident).
 * Argument validation happens in executeTool against the strict tool schema.
 */
export const POST: RequestHandler = async (event) => {
	rateLimit(event, 'tools', 180);
	const name = event.params.name;
	if (!isToolName(name)) error(404, `Unknown tool "${name.slice(0, 40)}"`);
	const input = await readJson(event.request, body);
	if (!input.voiceSessionId && !input.incidentId && name !== 'create_incident') {
		error(400, 'voiceSessionId or incidentId is required.');
	}
	const result = await executeTool(await getDb(), {
		name,
		arguments: input.arguments,
		origin: input.voiceSessionId ? 'voice' : 'operator',
		voiceSessionId: input.voiceSessionId ?? null,
		incidentId: input.voiceSessionId ? null : (input.incidentId ?? null),
		callId: input.callId ?? null
	});
	return json(result, { status: result.ok ? 200 : 422 });
};
