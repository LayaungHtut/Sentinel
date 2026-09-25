import { and, eq, inArray, isNull, lt, sql } from 'drizzle-orm';
import type { Database } from '../db';
import * as t from '../db/schema';
import { addTimeline, getOrgSettings } from '../incidents/repository';
import { deleteProviderSession } from '../assemblyai/reconcile';
import { log } from '../observability';

export const REDACTED = '[redacted: retention policy]';

/**
 * Retention: per organisation policy, redact transcript text and evidence
 * quotes older than `retentionDays`. Structured facts, actions and the audit
 * chain are kept (they are the incident record); the raw words are not.
 * Optionally also deletes AssemblyAI's stored recording/timeline.
 */
export async function runRetention(db: Database, now = new Date()) {
	const orgs = await db.select({ id: t.organizations.id }).from(t.organizations);
	let redacted = 0;
	for (const org of orgs) {
		const settings = await getOrgSettings(db, org.id);
		if (!settings.retentionDays) continue;
		const cutoff = new Date(now.getTime() - settings.retentionDays * 86400_000);
		const affected = await db
			.selectDistinct({ incidentId: t.transcripts.incidentId })
			.from(t.transcripts)
			.innerJoin(t.incidents, eq(t.incidents.id, t.transcripts.incidentId))
			.where(
				and(
					eq(t.incidents.orgId, org.id),
					lt(t.transcripts.receivedAt, cutoff),
					isNull(t.transcripts.redactedAt)
				)
			);
		for (const { incidentId } of affected) {
			if (!incidentId) continue;
			await db.transaction(async (tx) => {
				const rows = await tx
					.update(t.transcripts)
					.set({ text: REDACTED, redactedAt: now })
					.where(
						and(
							eq(t.transcripts.incidentId, incidentId),
							lt(t.transcripts.receivedAt, cutoff),
							isNull(t.transcripts.redactedAt)
						)
					)
					.returning({ id: t.transcripts.id });
				await tx
					.update(t.facts)
					.set({ evidenceQuote: REDACTED })
					.where(
						and(
							eq(t.facts.incidentId, incidentId),
							lt(t.facts.createdAt, cutoff),
							sql`${t.facts.evidenceQuote} is not null`
						)
					);
				redacted += rows.length;
				await addTimeline(tx, {
					incidentId,
					eventType: 'retention_redaction',
					description: `${rows.length} transcript line(s) and their evidence quotes redacted under the ${settings.retentionDays}-day retention policy. Structured facts and the audit chain are kept.`,
					source: 'system'
				});
			});
		}
		if (settings.deleteProviderRecordings) {
			const old = await db
				.select({ id: t.voiceSessions.id, providerSessionId: t.voiceSessions.providerSessionId })
				.from(t.voiceSessions)
				.where(
					and(
						eq(t.voiceSessions.orgId, org.id),
						lt(t.voiceSessions.startedAt, cutoff),
						isNull(t.voiceSessions.providerDeletedAt),
						sql`${t.voiceSessions.providerSessionId} is not null`
					)
				)
				.limit(50);
			const done: string[] = [];
			for (const s of old) if (await deleteProviderSession(s.providerSessionId!)) done.push(s.id);
			if (done.length) {
				await db
					.update(t.voiceSessions)
					.set({ providerDeletedAt: now })
					.where(inArray(t.voiceSessions.id, done));
			}
		}
	}
	if (redacted) log.info('retention redaction', { transcripts: redacted });
	return redacted;
}
