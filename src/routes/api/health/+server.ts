import { json } from '@sveltejs/kit';
import { getDbHandle } from '$lib/server/db';
import { isAssemblyAIConfigured } from '$lib/server/assemblyai/token';
import type { RequestHandler } from './$types';

export const GET: RequestHandler = async () => {
	let database: { ok: boolean; driver?: string; error?: string };
	try {
		const h = await getDbHandle();
		database = { ok: true, driver: h.driver };
	} catch (e) {
		console.error('[health] database unavailable', e);
		database = { ok: false, error: 'Database unavailable' };
	}
	return json({
		ok: database.ok,
		database,
		voice: { configured: isAssemblyAIConfigured(), provider: 'AssemblyAI Voice Agent API' },
		notifications: { configured: false, note: 'No outbound messaging integration is implemented.' }
	});
};
