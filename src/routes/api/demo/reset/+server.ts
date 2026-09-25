import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { rateLimit, requireRole } from '$lib/server/http';
import { DEMO_ORG_ID, seedDatabase } from '$lib/server/demo/seed';
import type { RequestHandler } from './$types';

/**
 * Reset the fictional demo organisation's incidents and restore its seed.
 * Only when DEMO_RESET_ENABLED=true, only by an admin, only inside the demo org.
 */
export const POST: RequestHandler = async (event) => {
	const auth = requireRole(event, 'admin');
	await rateLimit(event, 'demo-reset', 5);
	if (env.DEMO_RESET_ENABLED !== 'true')
		error(403, 'Demo reset is disabled. Set DEMO_RESET_ENABLED=true to enable.');
	if (auth.orgId !== DEMO_ORG_ID) error(403, 'Demo reset only applies to the demo organisation.');
	await seedDatabase(await getDb(), { reset: true });
	return json({ ok: true });
};
