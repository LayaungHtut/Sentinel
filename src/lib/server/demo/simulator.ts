import type { Database } from '../db';
import { loadSnapshot } from '../incidents/repository';
import { executeTool, type ExecuteResult } from '../tools/executor';
import { isAwaitingResponse } from '$lib/domain/escalation';
import { CONTACT_ROLE_LABELS } from '$lib/domain/playbooks';

/**
 * DEMO SIMULATION of external actors (maintenance, managers).
 * Only allowed on demo incidents; every write is tagged origin
 * 'demo_simulation', which the UI and report label explicitly.
 */
export type SimulationKind = 'contact_responds' | 'escalation_acknowledged';

const SCRIPTED_RESPONSES: Record<string, string> = {
	maintenance: 'On my way — about 25 minutes. Keep the doors shut.',
	it_support: 'Looking at it remotely now. Try restarting one till.',
	branch_manager: 'Noted. I am heading to the kitchen.',
	food_safety: 'Log temperatures every 15 minutes; I will review at the 2-hour mark.',
	operations_manager: 'Acknowledged. I authorise hiring a cold-storage van if needed.'
};

export class SimulationError extends Error {}

export async function simulate(
	db: Database,
	incidentId: string,
	kind: SimulationKind
): Promise<ExecuteResult> {
	const snap = await loadSnapshot(db, incidentId);
	if (!snap.incident.isDemo) {
		throw new SimulationError('Simulations are only available on demo incidents.');
	}

	if (kind === 'contact_responds') {
		const target =
			snap.actions.find(isAwaitingResponse) ??
			snap.actions.find((a) => a.status === 'escalated' && a.contactName && !a.responseReceivedAt);
		if (!target) throw new SimulationError('No action is waiting for a response.');
		return executeTool(db, {
			name: 'record_response',
			origin: 'demo_simulation',
			incidentId,
			arguments: {
				action: target.seq,
				responder: target.contactName ?? 'Contact',
				response: SCRIPTED_RESPONSES[target.contactRole ?? ''] ?? 'Acknowledged, on it.'
			}
		});
	}

	const esc = snap.escalations.find((e) => e.status === 'open');
	if (!esc) throw new SimulationError('No open escalation to acknowledge.');
	return executeTool(db, {
		name: 'resolve_escalation',
		origin: 'demo_simulation',
		incidentId,
		arguments: {
			escalation: esc.seq,
			status: 'acknowledged',
			note: `${esc.targetName} (${esc.targetRole ? CONTACT_ROLE_LABELS[esc.targetRole] : 'manager'}): ${SCRIPTED_RESPONSES[esc.targetRole ?? 'operations_manager'] ?? 'Acknowledged.'}`
		}
	});
}
