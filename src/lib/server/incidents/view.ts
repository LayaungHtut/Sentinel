import type { Tx } from './repository';
import { latestReport, loadSnapshot, voiceSessionStats } from './repository';
import { assessSeverity } from '$lib/domain/severity';
import { buildChecklist } from '$lib/domain/information';
import { buildOperationalState } from '$lib/domain/operational';
import { serialize, type IncidentView } from '$lib/domain/view';

export async function loadIncidentView(
	db: Tx,
	incidentId: string,
	now = new Date()
): Promise<IncidentView> {
	const snap = await loadSnapshot(db, incidentId);
	const report = await latestReport(db, incidentId);
	const sessions = await voiceSessionStats(db, incidentId);
	const severityAssessment = assessSeverity({ ...snap, now });
	return {
		...serialize(snap),
		severityAssessment,
		operational: buildOperationalState(snap, severityAssessment),
		checklist: buildChecklist(snap.incident, snap.infoRequests, snap.facts),
		latestReport: report
			? { version: report.version, generatedAt: report.generatedAt.toISOString() }
			: null,
		voiceSessions: serialize(sessions),
		serverTime: now.toISOString()
	};
}
