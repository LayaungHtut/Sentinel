import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type DbHandle } from '../db';
import * as t from '../db/schema';
import { executeTool } from './executor';
import { seedDatabase } from '../demo/seed';
import { loadSnapshot } from '../incidents/repository';
import { runEscalationCheck } from '../incidents/engine';
import { simulate } from '../demo/simulator';
import { classifyFact } from '$lib/domain/evidence';
import { buildChecklist } from '$lib/domain/information';

let h: DbHandle;

beforeAll(async () => {
	h = await createDb({ pgliteDataDir: 'memory://' });
	await seedDatabase(h.db);
});
afterAll(async () => h?.close());

async function newVoiceSession(isDemo = true) {
	const [s] = await h.db
		.insert(t.voiceSessions)
		.values({ isDemo, status: 'active', startedAt: new Date() })
		.returning();
	return s.id;
}

async function say(voiceSessionId: string, text: string) {
	await h.db
		.insert(t.transcripts)
		.values({ voiceSessionId, speaker: 'user', text, channel: 'voice' });
}

const T0 = new Date('2026-09-24T14:32:00Z');
const at = (sec: number) => new Date(T0.getTime() + sec * 1000);

describe('seed data', () => {
	it('creates demo contacts and historical incidents INC-0040/41', async () => {
		const incidents = await h.db.select().from(t.incidents);
		expect(incidents.map((i) => i.code).sort()).toEqual(['INC-0040', 'INC-0041']);
		expect(incidents.every((i) => i.isDemo)).toBe(true);
		const contacts = await h.db.select().from(t.contacts);
		expect(contacts.find((c) => c.name === 'Maya Win')?.role).toBe('operations_manager');
		expect(contacts.every((c) => c.notificationChannel === 'none')).toBe(true);
	});
});

describe('refrigeration scenario through the tool pipeline', () => {
	let vs: string;
	let incidentId: string;

	it('create_incident records facts with provenance and uncertainty', async () => {
		vs = await newVoiceSession(true);
		await say(
			vs,
			'The refrigeration unit at our Yangon branch stopped working about twenty minutes ago. The display says twelve degrees. We have frozen chicken and dairy inside.'
		);
		const res = await executeTool(h.db, {
			name: 'create_incident',
			origin: 'voice',
			voiceSessionId: vs,
			now: at(10),
			arguments: {
				title: 'Refrigeration failure',
				type: 'refrigeration_failure',
				facts: [
					{
						key: 'location',
						value: 'Yangon Branch',
						certainty: 'exact',
						basis: 'stated',
						evidence_quote: 'at our Yangon branch'
					},
					{
						key: 'incident_start',
						value: 'about twenty minutes ago',
						minutes_ago: 20,
						certainty: 'approximate',
						basis: 'stated',
						evidence_quote: 'stopped working about twenty minutes ago'
					},
					{
						key: 'temperature',
						value: '12°C',
						numeric_value: 12,
						unit: 'C',
						certainty: 'exact',
						basis: 'stated',
						evidence_quote: 'the display says twelve degrees'
					},
					{
						key: 'affected_inventory',
						value: 'frozen chicken and dairy',
						certainty: 'exact',
						basis: 'stated',
						evidence_quote: 'We have frozen chicken and dairy inside'
					}
				]
			}
		});
		expect(res.ok).toBe(true);
		incidentId = res.incidentId!;
		const snap = await loadSnapshot(h.db, incidentId);
		expect(snap.incident.code).toBe('INC-0042');
		expect(snap.incident.status).toBe('assessing');
		expect(snap.incident.location).toBe('Yangon Branch');
		expect(snap.incident.severity).toBe('high');
		expect(snap.incident.startedAtPrecision).toBe('approximate');
		expect(snap.incident.startedAt?.toISOString()).toBe(
			new Date(at(10).getTime() - 20 * 60000).toISOString()
		);

		const temp = snap.facts.find((f) => f.key === 'temperature')!;
		expect(classifyFact(temp)).toBe('unverified');
		expect(temp.quoteMatched).toBe(true);
		expect(temp.transcriptId).toBe(snap.transcripts[0].id);
		expect(temp.sourceType).toBe('voice_transcript');
		expect(classifyFact(snap.facts.find((f) => f.key === 'incident_start')!)).toBe('approximate');
		expect(classifyFact(snap.facts.find((f) => f.key === 'location')!)).toBe('reported');

		// Transcript was linked to the new incident.
		expect(snap.transcripts).toHaveLength(1);

		const checklist = buildChecklist(snap.incident, snap.infoRequests, snap.facts);
		const open = checklist.filter((c) => c.state === 'open').map((c) => c.key);
		expect(open).toEqual(
			expect.arrayContaining(['unit_status', 'backup_storage', 'responsible_person'])
		);
		expect(open).not.toContain('temperature');
	});

	it('refuses a second create_incident in the same session', async () => {
		const res = await executeTool(h.db, {
			name: 'create_incident',
			origin: 'voice',
			voiceSessionId: vs,
			arguments: { title: 'Duplicate', type: 'other', facts: [] }
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/already open/);
	});

	it('flags a quote that cannot be traced to the transcript', async () => {
		const res = await executeTool(h.db, {
			name: 'add_fact',
			origin: 'voice',
			voiceSessionId: vs,
			now: at(20),
			arguments: {
				facts: [
					{
						key: 'doors_closed',
						value: 'yes',
						certainty: 'exact',
						basis: 'stated',
						evidence_quote: 'we kept the doors shut the whole time'
					}
				]
			}
		});
		expect(res.ok).toBe(true);
		const [f] = await h.db.select().from(t.facts).where(eq(t.facts.key, 'doors_closed'));
		expect(f.quoteMatched).toBe(false);
		expect(f.transcriptId).toBeNull();
	});

	it('derives a missing value from numeric_value + unit (live-observed omission)', async () => {
		const ok = await executeTool(h.db, {
			name: 'add_fact',
			origin: 'voice',
			voiceSessionId: vs,
			now: at(25),
			arguments: {
				facts: [
					{
						key: 'probe_reading',
						numeric_value: 11,
						unit: 'C',
						certainty: 'exact',
						basis: 'stated'
					}
				]
			}
		});
		expect(ok.ok).toBe(true);
		const [f] = await h.db.select().from(t.facts).where(eq(t.facts.key, 'probe_reading'));
		expect(f.value).toBe('11°C');
		const bad = await executeTool(h.db, {
			name: 'add_fact',
			origin: 'voice',
			voiceSessionId: vs,
			arguments: { facts: [{ key: 'nothing', certainty: 'exact', basis: 'stated' }] }
		});
		expect(bad.ok).toBe(false);
	});

	it('add_fact is idempotent for an identical value', async () => {
		const args = {
			facts: [
				{
					key: 'unit_status',
					value: 'running but not cooling',
					certainty: 'exact' as const,
					basis: 'stated' as const
				}
			]
		};
		await executeTool(h.db, {
			name: 'add_fact',
			origin: 'voice',
			voiceSessionId: vs,
			now: at(30),
			arguments: args
		});
		const again = await executeTool(h.db, {
			name: 'add_fact',
			origin: 'voice',
			voiceSessionId: vs,
			now: at(31),
			arguments: args
		});
		expect(again.ok && again.message).toMatch(/already recorded/);
		const rows = await h.db.select().from(t.facts).where(eq(t.facts.key, 'unit_status'));
		expect(rows).toHaveLength(1);
	});

	it('supersedes a corrected reading and keeps history', async () => {
		await say(vs, 'Actually, I checked again. It says thirteen point four degrees.');
		const res = await executeTool(h.db, {
			name: 'mark_fact_confirmed',
			origin: 'voice',
			voiceSessionId: vs,
			now: at(40),
			arguments: {
				key: 'temperature',
				method: 'user_rechecked',
				corrected_value: '13.4°C',
				corrected_numeric_value: 13.4,
				unit: 'C',
				evidence_quote: 'I checked again. It says thirteen point four degrees'
			}
		});
		expect(res.ok).toBe(true);
		const rows = await h.db.select().from(t.facts).where(eq(t.facts.key, 'temperature'));
		const current = rows.find((r) => r.status === 'current')!;
		const old = rows.find((r) => r.status === 'superseded')!;
		expect(current.numericValue).toBe(13.4);
		expect(current.verification).toBe('confirmed');
		expect(current.supersedesId).toBe(old.id);
		expect(old.supersededById).toBe(current.id);
		expect(old.numericValue).toBe(12);
		expect(current.quoteMatched).toBe(true);
	});

	it('refuses to confirm a value contradicted by the quote, and accepts a number-only correction (live regressions)', async () => {
		await h.db.insert(t.transcripts).values({
			voiceSessionId: vs,
			speaker: 'user',
			text: 'It says 14.1 degrees now',
			channel: 'voice'
		});
		const contradicted = await executeTool(h.db, {
			name: 'mark_fact_confirmed',
			origin: 'voice',
			voiceSessionId: vs,
			arguments: {
				key: 'temperature',
				method: 'user_rechecked',
				evidence_quote: 'It says 14.1 degrees now'
			}
		});
		expect(contradicted.ok).toBe(false);
		if (!contradicted.ok) expect(contradicted.error).toMatch(/mention 14.1/);

		// Exactly the live argument shape: corrected_numeric_value without corrected_value.
		const numberOnly = await executeTool(h.db, {
			name: 'mark_fact_confirmed',
			origin: 'voice',
			voiceSessionId: vs,
			now: at(45),
			arguments: {
				key: 'temperature',
				method: 'user_rechecked',
				corrected_numeric_value: 14.1,
				unit: 'C',
				evidence_quote: 'It says 14.1 degrees now'
			}
		});
		expect(numberOnly.ok).toBe(true);
		const current = (await h.db.select().from(t.facts).where(eq(t.facts.key, 'temperature'))).find(
			(f) => f.status === 'current'
		)!;
		expect(current.numericValue).toBe(14.1);
		expect(current.value).toBe('14.1°C');
		expect(current.verification).toBe('confirmed');
	});

	it('actions advance the incident and contact actions await a response', async () => {
		const res = await executeTool(h.db, {
			name: 'add_action',
			origin: 'voice',
			voiceSessionId: vs,
			now: at(50),
			arguments: {
				actions: [
					{ title: 'Keep refrigeration doors closed', priority: 'immediate', status: 'completed' },
					{
						title: 'Contact maintenance',
						priority: 'immediate',
						status: 'in_progress',
						contact_role: 'maintenance'
					},
					{ title: 'Notify branch manager', priority: 'high', contact_role: 'branch_manager' }
				]
			}
		});
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.guidance).toMatch(/DEMO SIMULATION/);
		const snap = await loadSnapshot(h.db, incidentId);
		expect(snap.incident.status).toBe('mitigating');
		const maint = snap.actions.find((a) => a.seq === 2)!;
		expect(maint.contactName).toBe('Ko Min');
		expect(maint.requiresResponse).toBe(true);
		expect(maint.notificationStatus).toBe('simulated');
		expect(maint.responseDueAt?.getTime()).toBe(at(80).getTime());
		// Branch manager resolved to the site contact.
		expect(snap.actions.find((a) => a.seq === 3)!.contactName).toBe('Thandar Aye');
	});

	it('retried tool calls after a barge-in do not duplicate actions', async () => {
		const retry = await executeTool(h.db, {
			name: 'add_action',
			origin: 'voice',
			voiceSessionId: vs,
			now: at(55),
			arguments: {
				actions: [
					{ title: 'Contact Maintenance', priority: 'immediate', contact_role: 'maintenance' }
				]
			}
		});
		expect(retry.ok && retry.message).toMatch(/already exists/);
		const rows = await h.db.select().from(t.actions).where(eq(t.actions.incidentId, incidentId));
		expect(rows).toHaveLength(3);
		const same = await executeTool(h.db, {
			name: 'update_action',
			origin: 'voice',
			voiceSessionId: vs,
			arguments: { action: 2, status: 'in_progress' }
		});
		expect(same.ok && same.message).toMatch(/already in progress/);
	});

	it('a repeated action with a more advanced status advances the record (live regression)', async () => {
		await executeTool(h.db, {
			name: 'add_action',
			origin: 'voice',
			voiceSessionId: vs,
			arguments: { actions: [{ title: 'Check door seals', priority: 'normal', status: 'pending' }] }
		});
		const again = await executeTool(h.db, {
			name: 'add_action',
			origin: 'voice',
			voiceSessionId: vs,
			arguments: {
				actions: [{ title: 'Check door seals', priority: 'normal', status: 'in_progress' }]
			}
		});
		expect(again.ok && again.message).toMatch(/existing action now in progress/);
		const [row] = await h.db
			.select()
			.from(t.actions)
			.where(eq(t.actions.title, 'Check door seals'));
		expect(row.status).toBe('in_progress');
		await executeTool(h.db, {
			name: 'update_action',
			origin: 'voice',
			voiceSessionId: vs,
			arguments: { action: row.seq, status: 'cancelled' }
		});
	});

	it('rejects an invalid action transition', async () => {
		const res = await executeTool(h.db, {
			name: 'update_action',
			origin: 'voice',
			voiceSessionId: vs,
			arguments: { action: 1, status: 'in_progress' }
		});
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.error).toMatch(/already finished/);
	});

	it('escalates on response timeout exactly once', async () => {
		const ctx = { origin: 'system' as const, voiceSessionId: null, now: at(79) };
		expect(await h.db.transaction((tx) => runEscalationCheck(tx, incidentId, ctx))).toHaveLength(0);
		const created = await h.db.transaction((tx) =>
			runEscalationCheck(tx, incidentId, { ...ctx, now: at(81) })
		);
		expect(created).toHaveLength(1);
		expect(created[0].target).toBe('Maya Win');
		expect(created[0].simulated).toBe(true);
		const again = await h.db.transaction((tx) =>
			runEscalationCheck(tx, incidentId, { ...ctx, now: at(90) })
		);
		expect(again).toHaveLength(0);
		const snap = await loadSnapshot(h.db, incidentId);
		expect(snap.incident.status).toBe('escalated');
		expect(snap.actions.find((a) => a.seq === 2)!.status).toBe('escalated');
		expect(snap.escalations[0].notificationStatus).toBe('simulated');
	});

	it('does not open a duplicate escalation to the same target', async () => {
		const dup = await executeTool(h.db, {
			name: 'create_escalation',
			origin: 'voice',
			voiceSessionId: vs,
			arguments: { reason: 'Maintenance silent', target_role: 'operations_manager', action: 2 }
		});
		expect(dup.ok && dup.message).toMatch(/already open/);
		const rows = await h.db
			.select()
			.from(t.escalations)
			.where(eq(t.escalations.incidentId, incidentId));
		expect(rows).toHaveLength(1);
	});

	it('demo simulator records responses and acknowledges escalation', async () => {
		const r1 = await simulate(h.db, incidentId, 'contact_responds');
		expect(r1.ok).toBe(true);
		const r2 = await simulate(h.db, incidentId, 'escalation_acknowledged');
		expect(r2.ok).toBe(true);
		const snap = await loadSnapshot(h.db, incidentId);
		expect(snap.escalations[0].status).toBe('acknowledged');
		expect(snap.incident.status).toBe('mitigating');
		expect(snap.timeline.some((e) => e.source === 'demo_simulation')).toBe(true);
	});

	it('generates a report from structured state', async () => {
		const res = await executeTool(h.db, {
			name: 'generate_incident_report',
			origin: 'voice',
			voiceSessionId: vs,
			arguments: {}
		});
		expect(res.ok).toBe(true);
		const [report] = await h.db
			.select()
			.from(t.reports)
			.where(eq(t.reports.incidentId, incidentId));
		expect(report.version).toBe(1);
		expect(report.markdown).toContain('INC-0042');
		expect(report.markdown).toContain('14.1°C');
		expect(report.markdown).toContain('previously 13.4°C → 12°C');
		expect(report.markdown).toContain('Backup cold storage');
	});

	it('rejects invalid arguments and unknown tools, and audits them', async () => {
		const bad = await executeTool(h.db, {
			name: 'update_action',
			origin: 'voice',
			voiceSessionId: vs,
			arguments: { action: 'two', status: 'done' }
		});
		expect(bad.ok).toBe(false);
		const unknown = await executeTool(h.db, {
			name: 'send_sms',
			origin: 'voice',
			voiceSessionId: vs,
			arguments: {}
		});
		expect(unknown.ok).toBe(false);
		const audits = await h.db
			.select()
			.from(t.toolInvocations)
			.where(eq(t.toolInvocations.ok, false));
		expect(audits.map((a) => a.toolName)).toEqual(
			expect.arrayContaining(['update_action', 'send_sms'])
		);
	});

	it('refuses to close with open actions, but can resolve', async () => {
		const close = await executeTool(h.db, {
			name: 'close_incident',
			origin: 'voice',
			voiceSessionId: vs,
			arguments: { final_status: 'closed', resolution_summary: 'Done' }
		});
		expect(close.ok).toBe(false);
		const resolve = await executeTool(h.db, {
			name: 'close_incident',
			origin: 'voice',
			voiceSessionId: vs,
			arguments: { final_status: 'resolved', resolution_summary: 'Unit repaired, stock moved' }
		});
		expect(resolve.ok).toBe(true);
		const snap = await loadSnapshot(h.db, incidentId);
		expect(snap.incident.status).toBe('resolved');
		expect(snap.incident.resolvedAt).not.toBeNull();
	});
});
