import { CONTACT_ROLE_LABELS, getPlaybook, RESPONSE_TIMEOUT_SECONDS } from './playbooks';
import type {
	ActionRecord,
	ContactRecord,
	ContactRole,
	EscalationRecord,
	IncidentRecord
} from './types';

export function responseTimeoutSeconds(isDemo: boolean): number {
	return isDemo ? RESPONSE_TIMEOUT_SECONDS.demo : RESPONSE_TIMEOUT_SECONDS.production;
}

export function responseDueAt(from: Date, isDemo: boolean): Date {
	return new Date(from.getTime() + responseTimeoutSeconds(isDemo) * 1000);
}

/** Is this action currently waiting on someone outside the conversation? */
export function isAwaitingResponse(action: ActionRecord): boolean {
	return (
		action.requiresResponse &&
		action.status === 'in_progress' &&
		action.responseDueAt !== null &&
		action.responseReceivedAt === null
	);
}

export interface EscalationTarget {
	name: string;
	role: ContactRole | null;
}

/**
 * Resolve who an action escalates to: next role in the playbook chain,
 * matched to a directory contact at the incident site when possible.
 */
export function resolveEscalationTarget(
	incident: Pick<IncidentRecord, 'type' | 'location'>,
	fromRole: ContactRole | null,
	contacts: ContactRecord[]
): EscalationTarget {
	const chain = getPlaybook(incident.type).escalationChain;
	const role: ContactRole = (fromRole && chain[fromRole]) || 'operations_manager';
	return { name: findContactName(role, incident.location, contacts), role };
}

export function findContactName(
	role: ContactRole,
	location: string | null,
	contacts: ContactRecord[]
): string {
	const byRole = contacts.filter((c) => c.role === role);
	const loc = location?.toLowerCase() ?? '';
	const atSite = byRole.find((c) => c.site && loc.includes(c.site.toLowerCase().split(' ')[0]));
	const contact = atSite ?? byRole.find((c) => !c.site) ?? byRole[0];
	return contact ? contact.name : CONTACT_ROLE_LABELS[role];
}

export interface TimeoutEscalation {
	action: ActionRecord;
	target: EscalationTarget;
	reason: string;
}

/**
 * Response-timeout rule: an action that needs a reply, is in progress, is past
 * its due time, has no response, and has not already been escalated.
 */
export function evaluateResponseTimeouts(
	incident: Pick<IncidentRecord, 'type' | 'location' | 'status'>,
	actions: ActionRecord[],
	escalations: EscalationRecord[],
	contacts: ContactRecord[],
	now: Date = new Date()
): TimeoutEscalation[] {
	if (incident.status === 'resolved' || incident.status === 'closed') return [];
	const escalatedActionIds = new Set(escalations.map((e) => e.actionId).filter(Boolean));
	return actions
		.filter(
			(a) =>
				isAwaitingResponse(a) &&
				a.responseDueAt!.getTime() <= now.getTime() &&
				!escalatedActionIds.has(a.id)
		)
		.map((action) => {
			const waitedSec = Math.round(
				(now.getTime() - (action.startedAt ?? action.createdAt).getTime()) / 1000
			);
			const who =
				action.contactName ??
				(action.contactRole ? CONTACT_ROLE_LABELS[action.contactRole] : 'contact');
			return {
				action,
				target: resolveEscalationTarget(incident, action.contactRole, contacts),
				reason: `No response from ${who} after ${formatDuration(waitedSec)} on “${action.title}”`
			};
		});
}

export function formatDuration(totalSeconds: number): string {
	const s = Math.max(0, Math.round(totalSeconds));
	if (s < 60) return `${s}s`;
	const m = Math.floor(s / 60);
	const rem = s % 60;
	if (m < 60) return rem ? `${m}m ${rem}s` : `${m}m`;
	const h = Math.floor(m / 60);
	return `${h}h ${m % 60}m`;
}
