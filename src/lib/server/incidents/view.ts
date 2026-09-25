import { desc, eq } from 'drizzle-orm';
import * as t from '../db/schema';
import { verifyChain } from './audit';
import { maskAddress } from '../notifications/outbox';
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
	const [sessions, attachments, notes, audit] = await Promise.all([
		voiceSessionStats(db, incidentId),
		db
			.select({
				id: t.attachments.id,
				mime: t.attachments.mime,
				sizeBytes: t.attachments.sizeBytes,
				sha256: t.attachments.sha256,
				caption: t.attachments.caption,
				uploadedBy: t.attachments.uploadedBy,
				createdAt: t.attachments.createdAt
			})
			.from(t.attachments)
			.where(eq(t.attachments.incidentId, incidentId))
			.orderBy(desc(t.attachments.createdAt)),
		db
			.select()
			.from(t.notifications)
			.where(eq(t.notifications.incidentId, incidentId))
			.orderBy(desc(t.notifications.createdAt)),
		verifyChain(db, incidentId)
	]);
	const contactNames = new Map(snap.contacts.map((c) => [c.id, c.name]));
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
		attachments: serialize(attachments),
		notifications: notes.map((n) => ({
			id: n.id,
			channel: n.channel,
			status: n.status,
			to: n.toAddress ? maskAddress(n.toAddress) : null,
			contactName: n.contactId ? (contactNames.get(n.contactId) ?? null) : null,
			error: n.error,
			createdAt: n.createdAt.toISOString(),
			updatedAt: n.updatedAt.toISOString(),
			acknowledgedAt: n.acknowledgedAt?.toISOString() ?? null
		})),
		audit: {
			ok: audit.ok,
			events: audit.events,
			verified: audit.verified,
			legacy: audit.legacy,
			reason: audit.reason,
			headHash: audit.headHash
		},
		serverTime: now.toISOString()
	};
}
