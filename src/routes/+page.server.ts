import { env } from '$env/dynamic/private';
import { getDbHandle } from '$lib/server/db';
import { listIncidents } from '$lib/server/incidents/repository';
import { isAssemblyAIConfigured } from '$lib/server/assemblyai/token';
import { serialize } from '$lib/domain/view';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	try {
		const { db, driver } = await getDbHandle();
		return {
			incidents: serialize(await listIncidents(db, 20)),
			voiceConfigured: isAssemblyAIConfigured(),
			dbDriver: driver,
			dbError: null as string | null,
			demoResetEnabled: env.DEMO_RESET_ENABLED === 'true'
		};
	} catch (e) {
		console.error('[home] database unavailable', e);
		return {
			incidents: [],
			voiceConfigured: isAssemblyAIConfigured(),
			dbDriver: null,
			dbError: 'Database unavailable — check DATABASE_URL or the PGlite data directory.',
			demoResetEnabled: false
		};
	}
};
