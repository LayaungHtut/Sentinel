import { env } from '$env/dynamic/private';
import { getDbHandle } from '$lib/server/db';
import { listIncidents } from '$lib/server/incidents/repository';
import { isAssemblyAIConfigured } from '$lib/server/assemblyai/token';
import { serialize } from '$lib/domain/view';
import { log } from '$lib/server/observability';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ locals }) => {
	const auth = locals.auth!;
	try {
		const { db, driver } = await getDbHandle();
		return {
			incidents: serialize(await listIncidents(db, auth.orgId, 20)),
			voiceConfigured: isAssemblyAIConfigured(),
			dbDriver: driver,
			dbError: null as string | null,
			demoResetEnabled: env.DEMO_RESET_ENABLED === 'true' && auth.orgIsDemo && auth.role === 'admin'
		};
	} catch (e) {
		log.error('home: database unavailable', { err: e });
		return {
			incidents: [],
			voiceConfigured: isAssemblyAIConfigured(),
			dbDriver: null,
			dbError: 'Database unavailable — check DATABASE_URL or the PGlite data directory.',
			demoResetEnabled: false
		};
	}
};
