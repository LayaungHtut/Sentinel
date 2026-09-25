import { error } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import {
	findIncidentByIdOrCode,
	latestReport,
	listToolInvocations,
	loadSnapshot
} from '$lib/server/incidents/repository';
import { buildReplay } from '$lib/domain/replay';
import { serialize } from '$lib/domain/view';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ params, locals }) => {
	const db = await getDb();
	const incident = await findIncidentByIdOrCode(db, locals.auth!.orgId, params.id.slice(0, 64));
	if (!incident) error(404, 'Incident not found');
	const [snap, calls, report] = await Promise.all([
		loadSnapshot(db, incident.id),
		listToolInvocations(db, incident.id),
		latestReport(db, incident.id)
	]);
	const turns = buildReplay(
		snap.transcripts,
		calls.map((c) => ({
			id: c.id,
			toolName: c.toolName,
			ok: c.ok,
			error: c.error,
			origin: c.origin,
			at: c.createdAt
		})),
		snap.timeline
	);
	return {
		incidentId: incident.id,
		code: incident.code,
		title: incident.title,
		isDemo: incident.isDemo,
		turns: serialize(turns),
		report: report
			? { version: report.version, generatedAt: report.generatedAt.toISOString() }
			: null
	};
};
