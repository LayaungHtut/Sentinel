import { error, json } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { rateLimit } from '$lib/server/http';
import { seedDatabase } from '$lib/server/demo/seed';
import type { RequestHandler } from './$types';

/**
 * Wipe all incidents and restore the demo seed. Destructive, so it is only
 * enabled when DEMO_RESET_ENABLED=true (set in .env for hackathon demos).
 */
export const POST: RequestHandler = async (event) => {
	rateLimit(event, 'demo-reset', 5);
	if (env.DEMO_RESET_ENABLED !== 'true')
		error(403, 'Demo reset is disabled. Set DEMO_RESET_ENABLED=true to enable.');
	await seedDatabase(await getDb(), { reset: true });
	return json({ ok: true });
};
