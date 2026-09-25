import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { findIncidentByIdOrCode } from '$lib/server/incidents/repository';
import { loadIncidentView } from '$lib/server/incidents/view';
import { isAssemblyAIConfigured } from '$lib/server/assemblyai/token';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const db = await getDb();
	const incident = await findIncidentByIdOrCode(db, locals.auth!.orgId, params.id.slice(0, 64));
	if (!incident) error(404, 'Incident not found');
	return {
		view: await loadIncidentView(db, incident.id),
		voiceConfigured: isAssemblyAIConfigured()
	};
};
