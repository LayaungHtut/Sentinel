import { isAwaitingResponse } from './escalation';
import { classifyFact, formatFactValue } from './evidence';
import { buildChecklist } from './information';
import { getPlaybook, INFO_PRIORITY_RANK } from './playbooks';
import { recommendNextSteps } from './report';
import type { SeverityAssessment } from './severity';
import type { EpistemicClass, IncidentSnapshot, InfoPriority, Severity } from './types';

/**
 * Operational state: a structured summary derived ONLY from the incident
 * record and the rule engine. It is not model reasoning. Facts and system
 * assessments are kept in separate lists so they are never confused.
 */
export interface OperationalState {
	situation: string;
	known: { key: string; label: string; display: string; class: EpistemicClass; factId: string }[];
	unknown: { key: string; label: string; priority: InfoPriority; reporterDoesNotKnow: boolean }[];
	/** System assessments (rule outputs), each tied to the facts/records that triggered it. */
	risks: { text: string; level: Severity | 'watch'; basis: string }[];
	priority: string | null;
}

export function buildOperationalState(
	snap: IncidentSnapshot,
	severity: SeverityAssessment
): OperationalState {
	const { incident, facts, actions, escalations, infoRequests } = snap;
	const checklist = buildChecklist(incident, infoRequests, facts);
	const order = new Map(checklist.map((c, i) => [c.key, i]));
	const current = facts
		.filter((f) => f.status === 'current')
		.sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));

	const risks: OperationalState['risks'] = severity.signals
		.filter((s) => s.rule !== 'incident_type_baseline')
		.map((s) => ({
			text: s.reason,
			level: s.level,
			basis: `Rule “${s.rule.replace(/_/g, ' ')}” on ${s.factIds.length} recorded fact${s.factIds.length === 1 ? '' : 's'}`
		}));
	for (const a of actions) {
		if (isAwaitingResponse(a)) {
			risks.push({
				text: `${a.contactName ?? 'Contact'} has not yet responded (A${a.seq})`,
				level: 'watch',
				basis: `Action A${a.seq} awaiting response`
			});
		} else if (a.status === 'escalated' && !a.responseReceivedAt) {
			risks.push({
				text: `No response from ${a.contactName ?? 'contact'}: escalated`,
				level: 'high',
				basis: `Action A${a.seq} escalated`
			});
		} else if (a.status === 'blocked') {
			risks.push({
				text: `A${a.seq} blocked: ${a.blockedReason ?? 'reason not given'}`,
				level: 'high',
				basis: `Action A${a.seq}`
			});
		}
	}
	for (const e of escalations.filter((x) => x.status === 'open')) {
		risks.push({
			text: `Escalation E${e.seq} to ${e.targetName} not yet acknowledged`,
			level: 'watch',
			basis: `Escalation E${e.seq}`
		});
	}

	return {
		situation: `${getPlaybook(incident.type).label}${incident.location ? `, ${incident.location}` : ''}`,
		known: current.map((f) => ({
			key: f.key,
			label: f.label,
			display: formatFactValue(f),
			class: classifyFact(f),
			factId: f.id
		})),
		unknown: checklist
			.filter((c) => c.state === 'open' || c.state === 'unavailable')
			.sort((a, b) => INFO_PRIORITY_RANK[a.priority] - INFO_PRIORITY_RANK[b.priority])
			.map((c) => ({
				key: c.key,
				label: c.label,
				priority: c.priority,
				reporterDoesNotKnow: c.state === 'unavailable'
			})),
		risks,
		priority: recommendNextSteps(snap, severity, checklist)[0] ?? null
	};
}
