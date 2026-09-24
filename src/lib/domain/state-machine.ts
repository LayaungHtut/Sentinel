import type { ActionStatus, IncidentStatus } from './types';

/**
 * Incident lifecycle. Every status change goes through `assertIncidentTransition`
 * on the server, so the agent (or a UI bug) cannot jump NEW → RESOLVED.
 */
export const INCIDENT_TRANSITIONS: Record<IncidentStatus, readonly IncidentStatus[]> = {
	new: ['assessing'],
	// A report can turn out to be a false alarm while still being assessed.
	assessing: ['active', 'escalated', 'resolved'],
	active: ['mitigating', 'escalated', 'blocked', 'resolved'],
	mitigating: ['monitoring', 'blocked', 'escalated', 'resolved'],
	blocked: ['escalated', 'mitigating'],
	escalated: ['mitigating', 'active'],
	monitoring: ['resolved', 'mitigating', 'escalated'],
	resolved: ['closed', 'active'],
	closed: []
};

export const OPEN_INCIDENT_STATUSES: readonly IncidentStatus[] = [
	'new',
	'assessing',
	'active',
	'mitigating',
	'monitoring',
	'escalated',
	'blocked'
];

export function canTransitionIncident(from: IncidentStatus, to: IncidentStatus): boolean {
	return INCIDENT_TRANSITIONS[from].includes(to);
}

export class TransitionError extends Error {
	constructor(
		message: string,
		readonly from: string,
		readonly to: string,
		readonly allowed: readonly string[]
	) {
		super(message);
		this.name = 'TransitionError';
	}
}

export function assertIncidentTransition(from: IncidentStatus, to: IncidentStatus): void {
	if (from === to) return;
	if (!canTransitionIncident(from, to)) {
		const allowed = INCIDENT_TRANSITIONS[from];
		throw new TransitionError(
			`Incident cannot move from ${from.toUpperCase()} to ${to.toUpperCase()}. ` +
				(allowed.length
					? `Allowed next states: ${allowed.map((s) => s.toUpperCase()).join(', ')}.`
					: 'This incident is closed.'),
			from,
			to,
			allowed
		);
	}
}

export const ACTION_TRANSITIONS: Record<ActionStatus, readonly ActionStatus[]> = {
	pending: ['in_progress', 'completed', 'blocked', 'cancelled'],
	in_progress: ['completed', 'blocked', 'escalated', 'cancelled'],
	blocked: ['in_progress', 'escalated', 'cancelled', 'completed'],
	escalated: ['in_progress', 'completed', 'cancelled'],
	completed: [],
	cancelled: []
};

export function canTransitionAction(from: ActionStatus, to: ActionStatus): boolean {
	return ACTION_TRANSITIONS[from].includes(to);
}

export function assertActionTransition(from: ActionStatus, to: ActionStatus): void {
	if (from === to) return;
	if (!canTransitionAction(from, to)) {
		const allowed = ACTION_TRANSITIONS[from];
		throw new TransitionError(
			`Action cannot move from ${from} to ${to}. ` +
				(allowed.length ? `Allowed: ${allowed.join(', ')}.` : 'It is already finished.'),
			from,
			to,
			allowed
		);
	}
}

/**
 * Automatic, explainable progressions the server applies after real events.
 * Returns the next status and the reason, or null when nothing should change.
 */
export function autoProgression(
	status: IncidentStatus,
	event: 'first_action_added' | 'action_started' | 'escalation_opened' | 'action_blocked'
): { to: IncidentStatus; reason: string } | null {
	switch (event) {
		case 'first_action_added':
			return status === 'assessing'
				? { to: 'active', reason: 'Response actions created — incident confirmed active' }
				: null;
		case 'action_started':
			return status === 'active' || status === 'escalated'
				? { to: 'mitigating', reason: 'Mitigation action in progress' }
				: null;
		case 'escalation_opened':
			return canTransitionIncident(status, 'escalated')
				? { to: 'escalated', reason: 'Escalation opened' }
				: null;
		case 'action_blocked':
			return status === 'mitigating' || status === 'active'
				? { to: 'blocked', reason: 'A response action is blocked' }
				: null;
	}
}
