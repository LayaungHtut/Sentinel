import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db';
import { actorOf, rateLimit, readJson, requireRole } from '$lib/server/http';
import { executeTool } from '$lib/server/tools/executor';
import { isToolName } from '$lib/server/tools/schemas';
import { voiceBus } from '$lib/server/voice/bus';
import type { RequestHandler } from './$types';

const body = z.object({
	incidentId: z.string().max(64).nullish(),
	arguments: z.record(z.string(), z.unknown()).default({})
});

/**
 * Operator tools: the dashboard's manual controls (and the degraded mode when
 * voice is unavailable). Voice tool calls never come through here — the
 * server-side relay executes them — so a browser cannot submit "voice" evidence.
 * Tenancy and the per-tool role check are enforced in executeTool.
 */
export const POST: RequestHandler = async (event) => {
	const auth = requireRole(event, 'reporter');
	await rateLimit(event, 'tools', 180);
	const name = event.params.name;
	if (!isToolName(name)) error(404, `Unknown tool "${name.slice(0, 40)}"`);
	const input = await readJson(event.request, body);
	if (!input.incidentId && name !== 'create_incident') error(400, 'incidentId is required.');
	const result = await executeTool(await getDb(), {
		name,
		arguments: input.arguments,
		origin: 'operator',
		orgId: auth.orgId,
		actor: actorOf(auth),
		incidentId: input.incidentId ?? null
	});
	// A caller on a live voice session hears about operator changes on their next turn.
	if (result.ok && result.incidentId) voiceBus.refresh(result.incidentId);
	return json(result, {
		status: result.ok ? 200 : result.error.includes('not allowed') ? 403 : 422
	});
};
