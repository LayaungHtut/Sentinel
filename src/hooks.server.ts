import type { Handle, ServerInit } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDbHandle } from '$lib/server/db';
import { seedDatabase } from '$lib/server/demo/seed';

export const init: ServerInit = async () => {
	try {
		const { db, driver } = await getDbHandle();
		if (env.SEED_DEMO_DATA !== 'false') {
			const { seeded } = await seedDatabase(db);
			if (seeded) console.log('[sentinel] seeded demo data (fictional)');
		}
		console.log(`[sentinel] database ready (${driver})`);
	} catch (e) {
		// Keep serving: pages show a clear database error instead of crashing the process.
		console.error('[sentinel] database initialisation failed', e);
	}
};

export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Permissions-Policy', 'microphone=(self), camera=(), geolocation=()');
	return response;
};
