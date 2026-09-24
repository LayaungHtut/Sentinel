import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { findIncidentByIdOrCode, latestReport } from '$lib/server/incidents/repository';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params }) => {
	const db = await getDb();
	const incident = await findIncidentByIdOrCode(db, params.id.slice(0, 64));
	if (!incident) error(404, 'Incident not found');
	const report = await latestReport(db, incident.id);
	return {
		incidentId: incident.id,
		code: incident.code,
		report: report
			? {
					version: report.version,
					generatedAt: report.generatedAt.toISOString(),
					generatedBy: report.generatedBy,
					content: report.content
				}
			: null
	};
};
