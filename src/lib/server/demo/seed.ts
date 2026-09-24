import { sql } from 'drizzle-orm';
import type { Database } from '../db';
import * as t from '../db/schema';
import { executeTool } from '../tools/executor';
import { CONTACT_ROLE_LABELS } from '$lib/domain/playbooks';
import { DEMO_ORGANIZATION } from '$lib/demo/scenarios';
import type { ContactRole } from '$lib/domain/types';

/**
 * Seed data — every person and business below is FICTIONAL demo data.
 * Contacts have notification_channel 'none': SENTINEL never messages them.
 */
const CONTACTS: { name: string; role: ContactRole; site: string | null }[] = [
	{ name: 'Maya Win', role: 'operations_manager', site: null },
	{ name: 'Ko Min', role: 'maintenance', site: null },
	{ name: 'Thandar Aye', role: 'branch_manager', site: 'Yangon Branch' },
	{ name: 'Aung Kyaw', role: 'branch_manager', site: 'Mandalay Branch' },
	{ name: 'Su Su Hlaing', role: 'it_support', site: null },
	{ name: 'Dr. Nilar Oo', role: 'food_safety', site: null }
];

export async function resetDatabase(db: Database) {
	await db.execute(
		sql`truncate table ${t.toolInvocations}, ${t.reports}, ${t.timelineEvents}, ${t.escalations}, ${t.actions}, ${t.infoRequests}, ${t.facts}, ${t.transcripts}, ${t.voiceSessions}, ${t.incidents}, ${t.contacts} cascade`
	);
}

export async function seedDatabase(db: Database, opts: { reset?: boolean; now?: Date } = {}) {
	if (opts.reset) await resetDatabase(db);
	const existing = await db.select({ id: t.contacts.id }).from(t.contacts).limit(1);
	if (existing.length) return { seeded: false };

	await db.insert(t.contacts).values(
		CONTACTS.map((c) => ({
			name: c.name,
			role: c.role,
			roleLabel: CONTACT_ROLE_LABELS[c.role],
			site: c.site,
			organization: DEMO_ORGANIZATION,
			isDemo: true,
			notificationChannel: 'none'
		}))
	);

	// Historical incidents built through the same tool pipeline as live ones.
	const now = opts.now ?? new Date();
	const at = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60000);
	const DAY = 60 * 24;

	await historical(db, at(9 * DAY), [
		[
			'create_incident',
			{
				title: 'Card terminals offline at lunch',
				type: 'pos_outage',
				summary: 'Two of four tills lost connection to the payment service.',
				facts: [
					{ key: 'location', value: 'Mandalay Branch', certainty: 'exact', basis: 'stated' },
					{
						key: 'affected_terminals',
						value: 'two of four tills',
						certainty: 'exact',
						basis: 'stated'
					},
					{
						key: 'payment_fallback',
						value: 'yes, cash and the spare card reader',
						certainty: 'exact',
						basis: 'stated'
					},
					{
						key: 'incident_start',
						value: 'about 10 minutes ago',
						minutes_ago: 10,
						certainty: 'approximate',
						basis: 'stated'
					}
				]
			}
		],
		[
			'add_action',
			{
				actions: [
					{
						title: 'Switch to fallback payment method',
						priority: 'immediate',
						status: 'completed'
					},
					{
						title: 'Contact IT support',
						priority: 'immediate',
						status: 'in_progress',
						contact_role: 'it_support'
					}
				]
			}
		],
		[
			'record_response',
			{
				action: 2,
				responder: 'Su Su Hlaing',
				response: 'Router firmware fault, remote reboot done.'
			}
		],
		['update_action', { action: 2, status: 'completed', note: 'Tills reconnected' }],
		['update_incident', { status: 'monitoring', reason: 'All tills back online' }],
		[
			'close_incident',
			{
				final_status: 'closed',
				resolution_summary: 'Router rebooted remotely; no lost sales recorded.'
			}
		]
	]);

	await historical(db, at(3 * DAY), [
		[
			'create_incident',
			{
				title: 'Water leak under dish station',
				type: 'water_leak',
				facts: [
					{ key: 'location', value: 'Yangon Branch', certainty: 'exact', basis: 'stated' },
					{ key: 'people_at_risk', value: 'no one hurt', certainty: 'exact', basis: 'stated' },
					{
						key: 'impact',
						value: 'dish station closed, floor wet',
						certainty: 'exact',
						basis: 'stated'
					}
				]
			}
		],
		[
			'add_action',
			{
				actions: [
					{
						title: 'Shut off dish station water valve',
						priority: 'immediate',
						status: 'completed'
					},
					{ title: 'Place wet-floor signs', priority: 'immediate', status: 'completed' },
					{
						title: 'Contact maintenance',
						priority: 'high',
						status: 'in_progress',
						contact_role: 'maintenance'
					}
				]
			}
		],
		['record_response', { action: 3, responder: 'Ko Min', response: 'Replaced a split hose.' }],
		['update_action', { action: 3, status: 'completed' }],
		[
			'close_incident',
			{ final_status: 'resolved', resolution_summary: 'Hose replaced; station reopened.' }
		]
	]);

	return { seeded: true };
}

type Step = [string, Record<string, unknown>];

async function historical(db: Database, start: Date, steps: Step[]) {
	let incidentId: string | null = null;
	let minute = 0;
	for (const [name, args] of steps) {
		const res = await executeTool(db, {
			name,
			arguments: args,
			origin: 'operator',
			incidentId,
			isDemo: true,
			now: new Date(start.getTime() + minute * 60000)
		});
		if (!res.ok) throw new Error(`Seed step ${name} failed: ${res.error}`);
		incidentId = res.incidentId;
		minute += 4;
	}
}
