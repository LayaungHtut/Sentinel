import { classifyFact, formatFactValue, humanizeKey } from './evidence';
import { getPlaybook, INFO_PRIORITY_RANK } from './playbooks';
import type {
	EpistemicClass,
	FactRecord,
	IncidentRecord,
	InfoPriority,
	InfoRequestRecord
} from './types';

export type ChecklistState = 'known' | 'open' | 'unavailable' | 'not_applicable';

export interface ChecklistItem {
	key: string;
	label: string;
	question: string;
	priority: InfoPriority;
	state: ChecklistState;
	requestId: string | null;
	fact: { id: string; display: string; class: EpistemicClass } | null;
	note: string | null;
}

/**
 * What SENTINEL knows and — just as importantly — what it does not know yet.
 * Built from the incident's information requests (seeded from the playbook,
 * plus any the agent or operator added) joined with current facts.
 */
export function buildChecklist(
	incident: Pick<IncidentRecord, 'type'>,
	infoRequests: InfoRequestRecord[],
	facts: FactRecord[]
): ChecklistItem[] {
	const playbook = getPlaybook(incident.type);
	const labels = new Map(playbook.info.map((i) => [i.key, i.label]));
	const current = new Map(
		facts.filter((f) => f.status === 'current').map((f) => [f.key, f] as const)
	);

	const items = infoRequests.map<ChecklistItem>((r) => {
		const fact = current.get(r.key);
		let state: ChecklistState;
		if (fact) state = 'known';
		else if (r.status === 'unavailable') state = 'unavailable';
		else if (r.status === 'not_applicable') state = 'not_applicable';
		else state = 'open';
		return {
			key: r.key,
			label: labels.get(r.key) ?? fact?.label ?? humanizeKey(r.key),
			question: r.question,
			priority: r.priority,
			state,
			requestId: r.id,
			fact: fact
				? { id: fact.id, display: formatFactValue(fact), class: classifyFact(fact) }
				: null,
			note: r.note
		};
	});

	const stateRank: Record<ChecklistState, number> = {
		known: 0,
		open: 1,
		unavailable: 2,
		not_applicable: 3
	};
	return items.sort(
		(a, b) =>
			stateRank[a.state] - stateRank[b.state] ||
			INFO_PRIORITY_RANK[a.priority] - INFO_PRIORITY_RANK[b.priority]
	);
}

/** The next questions worth asking, most important first. */
export function nextQuestions(items: ChecklistItem[], limit = 2): ChecklistItem[] {
	return items
		.filter((i) => i.state === 'open' && i.priority !== 'optional')
		.sort((a, b) => INFO_PRIORITY_RANK[a.priority] - INFO_PRIORITY_RANK[b.priority])
		.slice(0, limit);
}
