import {
	classifyFact,
	findPerishables,
	formatFactValue,
	isAffirmativeStatement,
	isNegativeStatement,
	toCelsius
} from './evidence';
import { getPlaybook, INFO_PRIORITY_RANK } from './playbooks';
import type { FactRecord, IncidentRecord, InfoRequestRecord, Severity } from './types';

/**
 * Transparent operational severity assessment.
 *
 * This is a rule-based triage aid, not an authoritative risk score: every
 * contributing rule is listed with the facts that triggered it, so a human
 * can see exactly why a level was assigned and disagree with it.
 */

export const SEVERITY_RANK: Record<Severity, number> = { low: 0, medium: 1, high: 2, critical: 3 };

export interface SeveritySignal {
	rule: string;
	level: Severity;
	reason: string;
	factIds: string[];
}

export interface SeverityAssessment {
	level: Severity;
	computedLevel: Severity;
	/** True while critical information is still unknown. */
	provisional: boolean;
	signals: SeveritySignal[];
	mitigations: { reason: string; factIds: string[] }[];
	override: { level: Severity; reason: string } | null;
	openCriticalUnknowns: string[];
	disclaimer: string;
}

export const SEVERITY_DISCLAIMER =
	'Rule-based operational assessment to support triage. Not a certified risk classification.';

/** Food-safety chill threshold commonly used for perishables. */
export const COLD_CHAIN_LIMIT_C = 5;

type AssessInput = {
	incident: Pick<
		IncidentRecord,
		'type' | 'startedAt' | 'severityOverride' | 'severityOverrideReason'
	>;
	facts: FactRecord[];
	infoRequests: Pick<InfoRequestRecord, 'key' | 'priority' | 'status'>[];
	now?: Date;
};

export function assessSeverity({
	incident,
	facts,
	infoRequests,
	now = new Date()
}: AssessInput): SeverityAssessment {
	const playbook = getPlaybook(incident.type);
	const current = facts.filter((f) => f.status === 'current' && f.verification !== 'disputed');
	const byKey = new Map(current.map((f) => [f.key, f]));
	const signals: SeveritySignal[] = [
		{
			rule: 'incident_type_baseline',
			level: playbook.baseSeverity,
			reason: `Baseline for ${playbook.label.toLowerCase()}`,
			factIds: []
		}
	];
	const mitigations: SeverityAssessment['mitigations'] = [];

	// People first.
	const people = byKey.get('people_at_risk') ?? byKey.get('injuries');
	if (people && !isNegativeStatement(people.value)) {
		signals.push({
			rule: 'people_at_risk',
			level: 'critical',
			reason: `People reported injured or at risk: ${people.value}`,
			factIds: [people.id]
		});
	}

	// Cold chain.
	const temp = byKey.get('temperature');
	const tempC = temp?.numericValue != null ? toCelsius(temp.numericValue, temp.unit) : null;
	const minutesSinceStart = incident.startedAt
		? Math.max(0, (now.getTime() - incident.startedAt.getTime()) / 60000)
		: null;
	if (temp && tempC !== null && tempC > COLD_CHAIN_LIMIT_C) {
		const cls = classifyFact(temp);
		const qualifier = cls === 'confirmed' ? '' : ` (${cls})`;
		if (minutesSinceStart !== null && minutesSinceStart >= 120) {
			signals.push({
				rule: 'cold_chain_breach_extended',
				level: 'critical',
				reason: `Stock above ${COLD_CHAIN_LIMIT_C} °C for 2 h or more (${formatFactValue(temp)}${qualifier})`,
				factIds: [temp.id]
			});
		} else {
			signals.push({
				rule: 'cold_chain_breach',
				level: 'high',
				reason: `Temperature above ${COLD_CHAIN_LIMIT_C} °C food-safety limit (${formatFactValue(temp)}${qualifier})`,
				factIds: [temp.id]
			});
		}
	}

	const inventory = byKey.get('affected_inventory');
	if (inventory) {
		const perishables = findPerishables(inventory.value);
		if (perishables.length) {
			signals.push({
				rule: 'perishables_affected',
				level: 'high',
				reason: `Perishable inventory affected (${perishables.join(', ')})`,
				factIds: [inventory.id]
			});
		}
	}

	const unit = byKey.get('unit_status');
	if (unit && /(off|not cooling|dead|stopped|broken|failed|warm)/i.test(unit.value)) {
		signals.push({
			rule: 'cooling_unavailable',
			level: 'medium',
			reason: `Refrigeration not cooling (${unit.value})`,
			factIds: [unit.id]
		});
	}

	// POS / revenue.
	const terminals = byKey.get('affected_terminals');
	const fallback = byKey.get('payment_fallback');
	if (terminals && /\ball\b|every|entire|whole/i.test(terminals.value)) {
		const noFallback = fallback && isNegativeStatement(fallback.value);
		signals.push({
			rule: 'sales_halted',
			level: noFallback ? 'critical' : 'high',
			reason: noFallback
				? 'All terminals down and no payment fallback — sales halted'
				: 'All payment terminals affected',
			factIds: [terminals.id, ...(noFallback && fallback ? [fallback.id] : [])]
		});
	}

	const impact = byKey.get('customer_impact') ?? byKey.get('impact');
	if (impact && !isNegativeStatement(impact.value)) {
		signals.push({
			rule: 'operational_impact',
			level: 'medium',
			reason: `Operational impact reported: ${impact.value}`,
			factIds: [impact.id]
		});
	}

	// Mitigating factors are shown, but never silently lower the level.
	const backup = byKey.get('backup_storage');
	if (backup && isAffirmativeStatement(backup.value)) {
		mitigations.push({
			reason: `Backup cold storage available: ${backup.value}`,
			factIds: [backup.id]
		});
	}
	if (fallback && isAffirmativeStatement(fallback.value)) {
		mitigations.push({
			reason: `Payment fallback available: ${fallback.value}`,
			factIds: [fallback.id]
		});
	}
	const doors = byKey.get('doors_closed');
	if (doors && isAffirmativeStatement(doors.value)) {
		mitigations.push({ reason: 'Doors kept closed', factIds: [doors.id] });
	}

	const computedLevel = signals.reduce<Severity>(
		(max, s) => (SEVERITY_RANK[s.level] > SEVERITY_RANK[max] ? s.level : max),
		'low'
	);

	const openCriticalUnknowns = infoRequests
		.filter((r) => r.status === 'open' && INFO_PRIORITY_RANK[r.priority] === 0)
		.map((r) => r.key);

	const override =
		incident.severityOverride && incident.severityOverrideReason
			? { level: incident.severityOverride, reason: incident.severityOverrideReason }
			: null;

	return {
		level: override?.level ?? computedLevel,
		computedLevel,
		provisional: openCriticalUnknowns.length > 0,
		signals: signals.sort((a, b) => SEVERITY_RANK[b.level] - SEVERITY_RANK[a.level]),
		mitigations,
		override,
		openCriticalUnknowns,
		disclaimer: SEVERITY_DISCLAIMER
	};
}
