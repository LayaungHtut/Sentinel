import { describe, expect, it } from 'vitest';
import {
	assertActionTransition,
	assertIncidentTransition,
	autoProgression,
	canTransitionIncident,
	TransitionError
} from './state-machine';
import {
	classifyFact,
	findPerishables,
	formatFactValue,
	isAffirmativeStatement,
	isNegativeStatement,
	matchEvidenceQuote,
	normalizeFactKey,
	normalizeText,
	sameClaim,
	toCelsius
} from './evidence';
import { assessSeverity } from './severity';
import { buildChecklist, nextQuestions } from './information';
import { evaluateResponseTimeouts, formatDuration, resolveEscalationTarget } from './escalation';
import { buildReport, renderReportMarkdown } from './report';
import type {
	ActionRecord,
	ContactRecord,
	FactRecord,
	IncidentRecord,
	IncidentSnapshot,
	InfoRequestRecord
} from './types';

const NOW = new Date('2026-09-24T14:32:00Z');

let n = 0;
function fact(p: Partial<FactRecord>): FactRecord {
	return {
		id: `f${++n}`,
		incidentId: 'i1',
		category: 'other',
		key: 'k',
		label: 'Label',
		value: 'v',
		numericValue: null,
		unit: null,
		certainty: 'exact',
		basis: 'stated',
		needsVerification: false,
		verification: 'unverified',
		status: 'current',
		supersedesId: null,
		supersededById: null,
		sourceType: 'voice_transcript',
		transcriptId: null,
		evidenceQuote: null,
		quoteMatched: null,
		sourceRef: null,
		speaker: 'Reporter',
		observedAt: NOW,
		confirmedAt: null,
		confirmationNote: null,
		note: null,
		createdAt: NOW,
		...p
	};
}

function incident(p: Partial<IncidentRecord> = {}): IncidentRecord {
	return {
		id: 'i1',
		orgId: 'org1',
		code: 'INC-0042',
		title: 'Refrigeration failure',
		type: 'refrigeration_failure',
		location: 'Yangon Branch',
		summary: null,
		status: 'assessing',
		severity: null,
		severityOverride: null,
		severityOverrideReason: null,
		reportedAt: NOW,
		startedAt: new Date(NOW.getTime() - 20 * 60000),
		startedAtPrecision: 'approximate',
		resolvedAt: null,
		closedAt: null,
		resolutionSummary: null,
		isDemo: true,
		scenario: null,
		createdAt: NOW,
		updatedAt: NOW,
		...p
	};
}

function action(p: Partial<ActionRecord>): ActionRecord {
	return {
		id: `a${++n}`,
		incidentId: 'i1',
		seq: 1,
		title: 'Contact maintenance',
		description: null,
		priority: 'immediate',
		status: 'in_progress',
		owner: null,
		contactName: 'Ko Min',
		contactRole: 'maintenance',
		requiresResponse: true,
		responseDueAt: new Date(NOW.getTime() - 1000),
		responseReceivedAt: null,
		responseSummary: null,
		notificationStatus: 'simulated',
		origin: 'agent',
		blockedReason: null,
		reasonFactId: null,
		note: null,
		createdAt: new Date(NOW.getTime() - 31000),
		startedAt: new Date(NOW.getTime() - 31000),
		completedAt: null,
		...p
	};
}

const contacts: ContactRecord[] = [
	{
		id: 'c1',
		name: 'Maya Win',
		role: 'operations_manager',
		roleLabel: 'Operations manager',
		site: null,
		organization: 'x',
		isDemo: true,
		notificationChannel: 'none',
		orgId: 'org1',
		phone: null,
		email: null,
		onCall: false
	},
	{
		id: 'c2',
		name: 'Thandar Aye',
		role: 'branch_manager',
		roleLabel: 'Branch manager',
		site: 'Yangon Branch',
		organization: 'x',
		isDemo: true,
		notificationChannel: 'none',
		orgId: 'org1',
		phone: null,
		email: null,
		onCall: false
	},
	{
		id: 'c3',
		name: 'Aung Kyaw',
		role: 'branch_manager',
		roleLabel: 'Branch manager',
		site: 'Mandalay Branch',
		organization: 'x',
		isDemo: true,
		notificationChannel: 'none',
		orgId: 'org1',
		phone: null,
		email: null,
		onCall: false
	}
];

describe('incident state machine', () => {
	it('follows the documented lifecycle', () => {
		const path = [
			'new',
			'assessing',
			'active',
			'mitigating',
			'monitoring',
			'resolved',
			'closed'
		] as const;
		for (let i = 0; i < path.length - 1; i++)
			expect(canTransitionIncident(path[i], path[i + 1])).toBe(true);
	});
	it('supports escalation and blocking branches', () => {
		expect(canTransitionIncident('active', 'escalated')).toBe(true);
		expect(canTransitionIncident('escalated', 'mitigating')).toBe(true);
		expect(canTransitionIncident('mitigating', 'blocked')).toBe(true);
		expect(canTransitionIncident('blocked', 'escalated')).toBe(true);
	});
	it('rejects nonsensical transitions with an explanatory error', () => {
		expect(() => assertIncidentTransition('new', 'resolved')).toThrow(TransitionError);
		expect(() => assertIncidentTransition('closed', 'active')).toThrow(/closed/);
		expect(() => assertIncidentTransition('assessing', 'monitoring')).toThrow(
			/Allowed next states: ACTIVE/
		);
	});
	it('treats a same-state transition as a no-op', () => {
		expect(() => assertIncidentTransition('active', 'active')).not.toThrow();
	});
	it('applies explainable automatic progressions only where valid', () => {
		expect(autoProgression('assessing', 'first_action_added')?.to).toBe('active');
		expect(autoProgression('active', 'first_action_added')).toBeNull();
		expect(autoProgression('active', 'action_started')?.to).toBe('mitigating');
		expect(autoProgression('mitigating', 'escalation_opened')?.to).toBe('escalated');
		expect(autoProgression('resolved', 'escalation_opened')).toBeNull();
	});
});

describe('action transitions', () => {
	it('allows the normal flow and blocks re-opening finished work', () => {
		expect(() => assertActionTransition('pending', 'in_progress')).not.toThrow();
		expect(() => assertActionTransition('in_progress', 'completed')).not.toThrow();
		expect(() => assertActionTransition('blocked', 'escalated')).not.toThrow();
		expect(() => assertActionTransition('completed', 'in_progress')).toThrow(/already finished/);
		expect(() => assertActionTransition('cancelled', 'pending')).toThrow();
	});
});

describe('fact certainty and evidence', () => {
	it('classifies with the correct precedence', () => {
		expect(classifyFact(fact({ verification: 'confirmed', certainty: 'approximate' }))).toBe(
			'confirmed'
		);
		expect(classifyFact(fact({ verification: 'disputed' }))).toBe('disputed');
		expect(classifyFact(fact({ basis: 'inferred' }))).toBe('inferred');
		expect(classifyFact(fact({ certainty: 'approximate' }))).toBe('approximate');
		expect(classifyFact(fact({ needsVerification: true }))).toBe('unverified');
		expect(classifyFact(fact({}))).toBe('reported');
	});
	it('never presents an inferred value as confirmed unless actually confirmed', () => {
		expect(classifyFact(fact({ basis: 'inferred', needsVerification: false }))).not.toBe(
			'reported'
		);
	});
	it('formats values without inventing precision', () => {
		expect(formatFactValue(fact({ value: '12 degrees', numericValue: 12, unit: 'C' }))).toBe(
			'12°C'
		);
		expect(formatFactValue(fact({ value: 'x', numericValue: 13.4, unit: 'c' }))).toBe('13.4°C');
		expect(
			formatFactValue(
				fact({ value: '12°C', certainty: 'approximate', numericValue: 12, unit: 'C' })
			)
		).toBe('~12°C');
		expect(formatFactValue(fact({ value: 'about 20 minutes ago', certainty: 'approximate' }))).toBe(
			'about 20 minutes ago'
		);
	});
	it('detects identical claims for idempotency', () => {
		expect(
			sameClaim(fact({ value: 'Running, not cooling' }), fact({ value: 'running not cooling' }))
		).toBe(true);
		expect(
			sameClaim(fact({ numericValue: 12, unit: 'C' }), fact({ numericValue: 13.4, unit: 'C' }))
		).toBe(false);
		expect(sameClaim(fact({ value: 'a' }), fact({ value: 'a', certainty: 'approximate' }))).toBe(
			false
		);
	});
	it('normalises spoken numbers and keys', () => {
		expect(normalizeText('The display says TWELVE degrees.')).toBe('the display says 12 degrees');
		expect(normalizeFactKey('Backup Storage ')).toBe('backup_storage');
		expect(toCelsius(53.6, 'F')).toBeCloseTo(12);
	});
	it('traces an evidence quote to the right utterance', () => {
		const transcripts = [
			{ id: 't1', speaker: 'user' as const, text: 'The display says twelve degrees.' },
			{ id: 't2', speaker: 'agent' as const, text: 'Is it at twelve degrees?' },
			{ id: 't3', speaker: 'user' as const, text: 'Actually I checked again, it is 13.4 degrees' }
		];
		expect(matchEvidenceQuote('display says 12 degrees', transcripts)).toMatchObject({
			transcriptId: 't1',
			exact: true
		});
		expect(matchEvidenceQuote('checked again it is 13.4', transcripts)?.transcriptId).toBe('t3');
		expect(matchEvidenceQuote('the freezer is on fire', transcripts)).toBeNull();
		// Agent speech is never evidence for a user fact.
		expect(matchEvidenceQuote('Is it at twelve degrees', transcripts)?.transcriptId).not.toBe('t2');
	});
	it('reads simple yes/no semantics and perishables', () => {
		expect(isNegativeStatement("no, we don't have another freezer")).toBe(true);
		expect(isAffirmativeStatement('yes, there is a spare chest freezer')).toBe(true);
		expect(findPerishables('Frozen chicken and dairy')).toEqual(['chicken', 'dairy']);
	});
});

describe('severity assessment', () => {
	const openReqs: InfoRequestRecord[] = [
		{
			id: 'r1',
			incidentId: 'i1',
			key: 'backup_storage',
			question: '?',
			priority: 'critical',
			status: 'open',
			origin: 'playbook',
			answeredFactId: null,
			note: null,
			createdAt: NOW,
			resolvedAt: null
		}
	];
	it('explains a HIGH refrigeration incident with its facts', () => {
		const temp = fact({
			key: 'temperature',
			numericValue: 12,
			unit: 'C',
			category: 'measurement',
			needsVerification: true
		});
		const inv = fact({ key: 'affected_inventory', value: 'frozen chicken and dairy' });
		const s = assessSeverity({
			incident: incident(),
			facts: [temp, inv],
			infoRequests: openReqs,
			now: NOW
		});
		expect(s.level).toBe('high');
		expect(s.provisional).toBe(true);
		expect(s.openCriticalUnknowns).toEqual(['backup_storage']);
		const breach = s.signals.find((x) => x.rule === 'cold_chain_breach')!;
		expect(breach.factIds).toEqual([temp.id]);
		expect(breach.reason).toMatch(/unverified/);
		expect(s.disclaimer).toMatch(/Not a certified/);
	});
	it('escalates to CRITICAL after 2 h above the limit', () => {
		const temp = fact({ key: 'temperature', numericValue: 9, unit: 'C' });
		const s = assessSeverity({
			incident: incident({ startedAt: new Date(NOW.getTime() - 125 * 60000) }),
			facts: [temp],
			infoRequests: [],
			now: NOW
		});
		expect(s.level).toBe('critical');
	});
	it('puts people first', () => {
		const s = assessSeverity({
			incident: incident({ type: 'water_leak' }),
			facts: [fact({ key: 'people_at_risk', value: 'a guest slipped and hurt her wrist' })],
			infoRequests: [],
			now: NOW
		});
		expect(s.level).toBe('critical');
		const none = assessSeverity({
			incident: incident({ type: 'water_leak' }),
			facts: [fact({ key: 'people_at_risk', value: 'no one hurt' })],
			infoRequests: [],
			now: NOW
		});
		expect(none.level).toBe('medium');
	});
	it('ignores superseded and disputed facts', () => {
		const s = assessSeverity({
			incident: incident({ type: 'other' }),
			facts: [
				fact({ key: 'temperature', numericValue: 12, unit: 'C', status: 'superseded' }),
				fact({ key: 'affected_inventory', value: 'chicken', verification: 'disputed' })
			],
			infoRequests: [],
			now: NOW
		});
		expect(s.level).toBe('low');
	});
	it('lists mitigations without silently lowering the level', () => {
		const s = assessSeverity({
			incident: incident(),
			facts: [
				fact({ key: 'affected_inventory', value: 'dairy' }),
				fact({ key: 'backup_storage', value: 'yes, spare freezer next door' })
			],
			infoRequests: [],
			now: NOW
		});
		expect(s.level).toBe('high');
		expect(s.mitigations).toHaveLength(1);
	});
	it('honours an explicit override with its reason', () => {
		const s = assessSeverity({
			incident: incident({
				severityOverride: 'critical',
				severityOverrideReason: 'Health inspection today'
			}),
			facts: [],
			infoRequests: [],
			now: NOW
		});
		expect(s.level).toBe('critical');
		expect(s.computedLevel).toBe('medium');
	});
});

describe('information checklist', () => {
	it('makes unknowns first-class and orders next questions by priority', () => {
		const reqs: InfoRequestRecord[] = [
			'temperature',
			'backup_storage',
			'doors_closed',
			'inventory_quantity',
			'responsible_person'
		].map((key, i) => ({
			id: `r${i}`,
			incidentId: 'i1',
			key,
			question: `${key}?`,
			priority:
				key === 'backup_storage'
					? 'critical'
					: key === 'inventory_quantity'
						? 'optional'
						: 'important',
			status: key === 'responsible_person' ? 'unavailable' : 'open',
			origin: 'playbook',
			answeredFactId: null,
			note: null,
			createdAt: NOW,
			resolvedAt: null
		}));
		const items = buildChecklist(incident(), reqs, [fact({ key: 'temperature', value: '12°C' })]);
		expect(items.find((i) => i.key === 'temperature')?.state).toBe('known');
		expect(items.find((i) => i.key === 'responsible_person')?.state).toBe('unavailable');
		expect(nextQuestions(items).map((i) => i.key)).toEqual(['backup_storage', 'doors_closed']);
	});
});

describe('escalation rules', () => {
	it('escalates overdue, unanswered actions to the next role in the chain', () => {
		const due = evaluateResponseTimeouts(incident(), [action({})], [], contacts, NOW);
		expect(due).toHaveLength(1);
		expect(due[0].target).toEqual({ name: 'Maya Win', role: 'operations_manager' });
		expect(due[0].reason).toMatch(/No response from Ko Min after 31s/);
	});
	it('does not escalate answered, not-yet-due, already escalated or resolved cases', () => {
		expect(
			evaluateResponseTimeouts(incident(), [action({ responseReceivedAt: NOW })], [], contacts, NOW)
		).toHaveLength(0);
		expect(
			evaluateResponseTimeouts(
				incident(),
				[action({ responseDueAt: new Date(NOW.getTime() + 5000) })],
				[],
				contacts,
				NOW
			)
		).toHaveLength(0);
		const a = action({});
		expect(
			evaluateResponseTimeouts(incident(), [a], [{ actionId: a.id } as never], contacts, NOW)
		).toHaveLength(0);
		expect(
			evaluateResponseTimeouts(incident({ status: 'resolved' }), [action({})], [], contacts, NOW)
		).toHaveLength(0);
	});
	it('prefers a contact at the incident site', () => {
		expect(
			resolveEscalationTarget(incident({ location: 'Mandalay Branch' }), null, contacts).role
		).toBe('operations_manager');
		expect(formatDuration(95)).toBe('1m 35s');
	});
});

describe('report generation', () => {
	it('is compiled from structured state, with history, unknowns and honest notification labels', () => {
		const old = fact({
			id: 'old',
			key: 'temperature',
			label: 'Temperature',
			numericValue: 12,
			unit: 'C',
			status: 'superseded',
			supersededById: 'new',
			category: 'measurement',
			needsVerification: true
		});
		const cur = fact({
			id: 'new',
			key: 'temperature',
			label: 'Temperature',
			numericValue: 13.4,
			unit: 'C',
			verification: 'confirmed',
			supersedesId: 'old',
			category: 'measurement',
			evidenceQuote: 'checked again',
			quoteMatched: true
		});
		const approx = fact({
			key: 'incident_start',
			label: 'Incident start',
			value: 'about 20 minutes ago',
			certainty: 'approximate'
		});
		const snap: IncidentSnapshot = {
			incident: incident(),
			facts: [old, cur, approx],
			infoRequests: [
				{
					id: 'r',
					incidentId: 'i1',
					key: 'backup_storage',
					question: 'Backup?',
					priority: 'critical',
					status: 'open',
					origin: 'playbook',
					answeredFactId: null,
					note: null,
					createdAt: NOW,
					resolvedAt: null
				}
			],
			actions: [
				action({
					seq: 1,
					status: 'completed',
					title: 'Keep doors closed',
					requiresResponse: false
				}),
				action({ seq: 2, status: 'escalated' })
			],
			escalations: [
				{
					id: 'e',
					incidentId: 'i1',
					seq: 1,
					actionId: null,
					level: 1,
					targetName: 'Maya Win',
					targetRole: 'operations_manager',
					reason: 'No response',
					trigger: 'response_timeout',
					status: 'open',
					simulated: true,
					notificationStatus: 'simulated',
					resolutionNote: null,
					createdAt: NOW,
					acknowledgedAt: null,
					resolvedAt: null
				}
			],
			timeline: [],
			transcripts: [],
			contacts
		};
		const r = buildReport(snap, NOW);
		expect(r.confirmedFacts.map((f) => f.value)).toEqual(['13.4°C']);
		expect(r.confirmedFacts[0].history.map((h) => h.value)).toEqual(['12°C']);
		expect(r.approximateFacts.map((f) => f.key)).toEqual(['incident_start']);
		expect(r.unverifiedFacts).toEqual([]);
		expect(r.unknowns.map((u) => u.label)).toEqual(['Backup cold storage']);
		expect(r.actionsTaken.map((a) => a.ref)).toEqual(['A1']);
		expect(r.outstandingActions.map((a) => a.ref)).toEqual(['A2']);
		expect(r.escalations[0].notification).toMatch(/no real message sent/);
		expect(r.recommendedNextSteps.join(' ')).toMatch(/Maya Win/);
		expect(r.recommendedNextSteps.join(' ')).toMatch(/backup cold storage/i);
		const md = renderReportMarkdown(r);
		expect(md).toContain('## Unknown Information');
		expect(md).toContain('DEMO DATA');
		expect(md).not.toMatch(/\bsent to\b/i);
	});
});

describe('incident replay', () => {
	it('groups tool calls, record changes and replies under the utterance that caused them', async () => {
		const { buildReplay } = await import('./replay');
		const at = (s: number) => new Date(NOW.getTime() + s * 1000);
		const turns = buildReplay(
			[
				{
					speaker: 'user',
					text: 'Freezer at 12 degrees',
					channel: 'voice',
					interrupted: false,
					receivedAt: at(1)
				},
				{
					speaker: 'agent',
					text: 'Got it. Is it running?',
					channel: 'voice',
					interrupted: false,
					receivedAt: at(4)
				},
				{
					speaker: 'user',
					text: 'Running, not cooling',
					channel: 'voice',
					interrupted: false,
					receivedAt: at(8)
				}
			],
			[
				{
					id: 'c1',
					toolName: 'create_incident',
					ok: true,
					error: null,
					origin: 'voice',
					at: at(2)
				},
				{ id: 'c2', toolName: 'add_fact', ok: true, error: null, origin: 'voice', at: at(9) }
			],
			[
				{
					eventType: 'incident_created',
					description: 'Incident opened',
					source: 'agent_tool',
					occurredAt: at(2)
				},
				{ eventType: 'voice_ready', description: 'connected', source: 'system', occurredAt: at(0) },
				{
					eventType: 'fact_recorded',
					description: 'Unit status recorded',
					source: 'agent_tool',
					occurredAt: at(9)
				}
			]
		);
		expect(turns.map((t) => t.utterance?.text)).toEqual([
			'Freezer at 12 degrees',
			'Running, not cooling'
		]);
		expect(turns[0].toolCalls.map((c) => c.toolName)).toEqual(['create_incident']);
		expect(turns[0].replies.map((r) => r.text)).toEqual(['Got it. Is it running?']);
		expect(turns[1].changes.map((c) => c.description)).toEqual(['Unit status recorded']);
	});
});
