import { error, text } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { idParam, rateLimit } from '$lib/server/http';
import { getIncident, latestReport, NotFoundError } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

/** Latest stored report as Markdown (download). */
export const GET: RequestHandler = async (event) => {
	rateLimit(event, 'report', 60);
	const id = idParam.parse(event.params.id);
	const db = await getDb();
	try {
		const incident = await getIncident(db, id);
		const report = await latestReport(db, id);
		if (!report) error(404, 'No report generated yet.');
		return text(report.markdown, {
			headers: {
				'content-type': 'text/markdown; charset=utf-8',
				'content-disposition': `attachment; filename="${incident.code}-report-v${report.version}.md"`
			}
		});
	} catch (e) {
		if (e instanceof NotFoundError) error(404, e.message);
		throw e;
	}
};
