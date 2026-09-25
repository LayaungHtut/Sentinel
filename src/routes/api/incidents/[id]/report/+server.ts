import { error, text } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { idParam, rateLimit, requireRole } from '$lib/server/http';
import { getIncidentInOrg, latestReport, NotFoundError } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

/** Latest stored report as Markdown (download). */
export const GET: RequestHandler = async (event) => {
	const auth = requireRole(event, 'reporter');
	await rateLimit(event, 'report', 60);
	const id = idParam.parse(event.params.id);
	const db = await getDb();
	try {
		const incident = await getIncidentInOrg(db, auth.orgId, id);
		const report = await latestReport(db, id);
		if (!report) error(404, 'No report generated yet.');
		return text(report.markdown, {
			headers: {
				'content-type': 'text/markdown; charset=utf-8',
				'content-disposition': `attachment; filename="${incident.code}-report-v${report.version}.md"`
			}
		});
	} catch (e) {
		if (e instanceof NotFoundError) error(404, 'Incident not found');
		throw e;
	}
};
