import { isAwaitingResponse } from './escalation';
import { classifyFact, EPISTEMIC_LABELS, formatFactValue } from './evidence';
import { buildChecklist } from './information';
import { getPlaybook } from './playbooks';
import { assessSeverity, type SeverityAssessment } from './severity';
import type {
	EpistemicClass,
	FactRecord,
	IncidentSnapshot,
	SourceType,
	TranscriptRecord
} from './types';

/**
 * Incident reports are compiled deterministically from structured state.
 * No LLM is asked to "remember" the incident — every line traces back to a
 * database record, so the report cannot contain anything the record doesn't.
 */

export interface ReportFact {
	key: string;
	label: string;
	value: string;
	class: EpistemicClass;
	classLabel: string;
	source: string;
	quote: string | null;
	quoteMatched: boolean | null;
	recordedAt: string;
	history: { value: string; recordedAt: string }[];
}

export interface IncidentReport {
	code: string;
	title: string;
	typeLabel: string;
	location: string | null;
	status: string;
	severity: {
		level: string;
		provisional: boolean;
		reasons: string[];
		mitigations: string[];
		override: string | null;
		disclaimer: string;
	};
	reportedAt: string;
	startedAt: string | null;
	startedAtPrecision: string;
	resolvedAt: string | null;
	generatedAt: string;
	isDemo: boolean;
	executiveSummary: string;
	confirmedFacts: ReportFact[];
	reportedFacts: ReportFact[];
	approximateFacts: ReportFact[];
	/** Stated but not independently verified, or disputed. */
	unverifiedFacts: ReportFact[];
	inferredFacts: ReportFact[];
	unknowns: { label: string; question: string; state: string; note: string | null }[];
	actionsTaken: ReportAction[];
	outstandingActions: ReportAction[];
	escalations: {
		ref: string;
		target: string;
		reason: string;
		status: string;
		simulated: boolean;
		notification: string;
		createdAt: string;
		resolvedAt: string | null;
		resolutionNote: string | null;
	}[];
	timeline: { at: string; description: string; source: string }[];
	recommendedNextSteps: string[];
	evidenceStats: {
		facts: number;
		factsWithTracedQuote: number;
		supersededValues: number;
		userUtterances: number;
	};
}

export interface ReportAction {
	ref: string;
	title: string;
	status: string;
	owner: string | null;
	contact: string | null;
	startedAt: string | null;
	completedAt: string | null;
	response: string | null;
	note: string | null;
	/** Evidence → action: the fact that made this action necessary. */
	because: string | null;
}

const SOURCE_LABELS: Record<SourceType, string> = {
	voice_transcript: 'Voice report',
	typed_message: 'Typed message',
	operator_entry: 'Operator entry',
	agent_inference: 'SENTINEL inference',
	system: 'System',
	demo_simulation: 'Demo simulation'
};

export function sourceLabel(source: SourceType): string {
	return SOURCE_LABELS[source] ?? source;
}

const iso = (d: Date | null) => (d ? d.toISOString() : null);

export function buildReport(snapshot: IncidentSnapshot, now: Date = new Date()): IncidentReport {
	const { incident, facts, infoRequests, actions, escalations, timeline, transcripts } = snapshot;
	const severity = assessSeverity({ incident, facts, infoRequests, now });
	const playbook = getPlaybook(incident.type);

	const current = facts.filter((f) => f.status === 'current');
	const toReportFact = (f: FactRecord): ReportFact => {
		const cls = classifyFact(f);
		return {
			key: f.key,
			label: f.label,
			value: formatFactValue(f),
			class: cls,
			classLabel: EPISTEMIC_LABELS[cls],
			source: sourceLabel(f.sourceType),
			quote: f.evidenceQuote,
			quoteMatched: f.quoteMatched,
			recordedAt: f.observedAt.toISOString(),
			history: supersededChain(f, facts).map((h) => ({
				value: formatFactValue(h),
				recordedAt: h.observedAt.toISOString()
			}))
		};
	};
	const bucket = (classes: EpistemicClass[]) =>
		current.filter((f) => classes.includes(classifyFact(f))).map(toReportFact);

	const checklist = buildChecklist(incident, infoRequests, facts);
	const unknowns = checklist
		.filter((c) => c.state === 'open' || c.state === 'unavailable')
		.map((c) => ({
			label: c.label,
			question: c.question,
			state:
				c.state === 'unavailable' ? 'Unavailable (reporter does not know)' : 'Not yet established',
			note: c.note
		}));

	const toReportAction = (a: (typeof actions)[number]): ReportAction => ({
		ref: `A${a.seq}`,
		title: a.title,
		status: a.status,
		owner: a.owner,
		contact: a.contactName,
		startedAt: iso(a.startedAt),
		completedAt: iso(a.completedAt),
		response: a.responseSummary,
		note: a.blockedReason ?? a.note,
		because: (() => {
			const f = a.reasonFactId ? facts.find((x) => x.id === a.reasonFactId) : undefined;
			return f ? `${f.label}: ${formatFactValue(f)}` : null;
		})()
	});
	const actionsTaken = actions.filter((a) => a.status === 'completed').map(toReportAction);
	const outstandingActions = actions
		.filter((a) => !['completed', 'cancelled'].includes(a.status))
		.map(toReportAction);

	const report: IncidentReport = {
		code: incident.code,
		title: incident.title,
		typeLabel: playbook.label,
		location: incident.location,
		status: incident.status,
		severity: {
			level: severity.level,
			provisional: severity.provisional,
			reasons: severity.signals
				.filter((s) => s.rule !== 'incident_type_baseline')
				.map((s) => s.reason),
			mitigations: severity.mitigations.map((m) => m.reason),
			override: severity.override
				? `${severity.override.level.toUpperCase()} — ${severity.override.reason}`
				: null,
			disclaimer: severity.disclaimer
		},
		reportedAt: incident.reportedAt.toISOString(),
		startedAt: iso(incident.startedAt),
		startedAtPrecision: incident.startedAtPrecision,
		resolvedAt: iso(incident.resolvedAt),
		generatedAt: now.toISOString(),
		isDemo: incident.isDemo,
		executiveSummary: '',
		confirmedFacts: bucket(['confirmed']),
		reportedFacts: bucket(['reported']),
		approximateFacts: bucket(['approximate']),
		unverifiedFacts: bucket(['unverified', 'disputed']),
		inferredFacts: bucket(['inferred']),
		unknowns,
		actionsTaken,
		outstandingActions,
		escalations: escalations.map((e) => ({
			ref: `E${e.seq}`,
			target: e.targetName,
			reason: e.reason,
			status: e.status,
			simulated: e.simulated,
			notification:
				e.notificationStatus === 'simulated'
					? 'Demo simulation — no real message sent'
					: 'Not sent — no notification channel configured',
			createdAt: e.createdAt.toISOString(),
			resolvedAt: iso(e.resolvedAt),
			resolutionNote: e.resolutionNote
		})),
		timeline: timeline.map((t) => ({
			at: t.occurredAt.toISOString(),
			description: t.description,
			source: t.source
		})),
		recommendedNextSteps: recommendNextSteps(snapshot, severity, checklist),
		evidenceStats: {
			facts: current.length,
			factsWithTracedQuote: current.filter((f) => f.quoteMatched).length,
			supersededValues: facts.filter((f) => f.status === 'superseded').length,
			userUtterances: transcripts.filter((t: TranscriptRecord) => t.speaker === 'user').length
		}
	};
	report.executiveSummary = executiveSummary(report);
	return report;
}

function supersededChain(fact: FactRecord, all: FactRecord[]): FactRecord[] {
	const byId = new Map(all.map((f) => [f.id, f]));
	const chain: FactRecord[] = [];
	let cursor = fact.supersedesId ? byId.get(fact.supersedesId) : undefined;
	while (cursor && chain.length < 20) {
		chain.push(cursor);
		cursor = cursor.supersedesId ? byId.get(cursor.supersedesId) : undefined;
	}
	return chain;
}

function executiveSummary(r: IncidentReport): string {
	const parts: string[] = [];
	parts.push(
		`${r.typeLabel}${r.location ? ` at ${r.location}` : ''}, reported ${fmtTime(r.reportedAt)}.`
	);
	parts.push(
		`Current status ${r.status.toUpperCase()}, severity ${r.severity.level.toUpperCase()}${r.severity.provisional ? ' (provisional — critical information outstanding)' : ''}.`
	);
	if (r.severity.reasons.length)
		parts.push(`Key drivers: ${r.severity.reasons.slice(0, 3).join('; ')}.`);
	const factCount = r.confirmedFacts.length + r.reportedFacts.length;
	const uncertain = r.approximateFacts.length + r.unverifiedFacts.length + r.inferredFacts.length;
	parts.push(
		`${factCount} fact${factCount === 1 ? '' : 's'} established, ${uncertain} approximate/unverified/inferred, ${r.unknowns.length} still unknown.`
	);
	parts.push(
		`${r.actionsTaken.length} action${r.actionsTaken.length === 1 ? '' : 's'} completed, ${r.outstandingActions.length} outstanding.`
	);
	const openEsc = r.escalations.filter((e) => e.status !== 'resolved').length;
	if (r.escalations.length)
		parts.push(
			`${r.escalations.length} escalation${r.escalations.length === 1 ? '' : 's'} (${openEsc} open).`
		);
	return parts.join(' ');
}

function fmtTime(isoString: string): string {
	const d = new Date(isoString);
	return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`;
}

export function recommendNextSteps(
	snapshot: IncidentSnapshot,
	severity: SeverityAssessment,
	checklist: ReturnType<typeof buildChecklist>
): string[] {
	const steps: string[] = [];
	const { incident, actions, escalations, facts } = snapshot;
	if (incident.status === 'closed') return ['No further action — incident closed.'];

	for (const e of escalations.filter((x) => x.status === 'open')) {
		steps.push(
			`Confirm ${e.targetName} has picked up escalation E${e.seq}${e.simulated ? ' (demo simulation)' : ''}.`
		);
	}
	for (const a of actions.filter((x) => x.status === 'blocked')) {
		steps.push(`Unblock A${a.seq} “${a.title}”${a.blockedReason ? ` — ${a.blockedReason}` : ''}.`);
	}
	for (const a of actions.filter(isAwaitingResponse)) {
		steps.push(`Chase response from ${a.contactName ?? 'contact'} on A${a.seq} “${a.title}”.`);
	}
	for (const a of actions.filter((x) => x.status === 'pending' && x.priority === 'immediate')) {
		steps.push(`Start immediate action A${a.seq} “${a.title}”.`);
	}
	for (const c of checklist.filter((i) => i.state === 'open' && i.priority === 'critical')) {
		steps.push(`Establish ${c.label.toLowerCase()}: “${c.question}”`);
	}
	for (const f of facts.filter(
		(x) =>
			x.status === 'current' &&
			['unverified', 'approximate'].includes(classifyFact(x)) &&
			x.category === 'measurement'
	)) {
		steps.push(
			`Verify ${f.label.toLowerCase()} (currently ${formatFactValue(f)}, ${classifyFact(f)}).`
		);
	}
	const open = actions.filter((a) => !['completed', 'cancelled'].includes(a.status));
	if (actions.length > 0 && open.length === 0 && incident.status !== 'resolved') {
		steps.push(
			'All actions complete — confirm the situation is stable and move the incident to MONITORING or RESOLVED.'
		);
	}
	if (actions.length === 0) steps.push('Agree immediate response actions.');
	if (severity.provisional)
		steps.push('Severity is provisional until critical unknowns are established.');
	return steps.slice(0, 10);
}

export function renderReportMarkdown(r: IncidentReport): string {
	const lines: string[] = [];
	const factLine = (f: ReportFact) =>
		`- **${f.label}:** ${f.value} — _${f.classLabel}_ · ${f.source}${f.quote ? ` · “${f.quote}”${f.quoteMatched === false ? ' (quote not traced to transcript)' : ''}` : ''}${f.history.length ? ` · previously ${f.history.map((h) => h.value).join(' → ')}` : ''}`;
	const actionLine = (a: ReportAction) =>
		`- ${a.ref} ${a.title} — ${a.status.replace('_', ' ').toUpperCase()}${a.contact ? ` · contact: ${a.contact}` : ''}${a.response ? ` · response: ${a.response}` : ''}${a.note ? ` · ${a.note}` : ''}${a.because ? ` · because ${a.because}` : ''}`;

	lines.push(`# Incident Report — ${r.code}`);
	if (r.isDemo)
		lines.push('', '> DEMO DATA — fictional organisation; external responses are simulated.');
	lines.push('', '## Executive Summary', '', r.executiveSummary);
	lines.push(
		'',
		'## Incident Details',
		'',
		`- **Incident:** ${r.title} (${r.typeLabel})`,
		`- **Location:** ${r.location ?? 'Unknown'}`,
		`- **Reported:** ${r.reportedAt}`,
		`- **Started:** ${r.startedAt ? `${r.startedAt} (${r.startedAtPrecision})` : 'Unknown'}`,
		`- **Status:** ${r.status.toUpperCase()}`,
		`- **Severity:** ${r.severity.level.toUpperCase()}${r.severity.provisional ? ' (provisional)' : ''}`
	);
	for (const reason of r.severity.reasons) lines.push(`  - ${reason}`);
	if (r.severity.override) lines.push(`  - Override: ${r.severity.override}`);
	lines.push(`  - _${r.severity.disclaimer}_`);

	const section = (title: string, items: string[], empty: string) => {
		lines.push('', `## ${title}`, '');
		lines.push(...(items.length ? items : [`_${empty}_`]));
	};
	section('Confirmed Facts', r.confirmedFacts.map(factLine), 'None confirmed yet.');
	section('Reported Facts', r.reportedFacts.map(factLine), 'None.');
	section('Approximate Facts', r.approximateFacts.map(factLine), 'None.');
	section('Unverified Facts', r.unverifiedFacts.map(factLine), 'None.');
	section('Inferred (not stated by anyone)', r.inferredFacts.map(factLine), 'None.');
	section(
		'Unknown Information',
		r.unknowns.map((u) => `- **${u.label}:** ${u.state}${u.note ? ` — ${u.note}` : ''}`),
		'Nothing outstanding.'
	);
	section('Actions Taken', r.actionsTaken.map(actionLine), 'None completed.');
	section('Outstanding Actions', r.outstandingActions.map(actionLine), 'None.');
	section(
		'Escalations',
		r.escalations.map(
			(e) =>
				`- ${e.ref} → ${e.target} — ${e.status.toUpperCase()}${e.simulated ? ' · DEMO SIMULATION' : ''} · ${e.reason} · ${e.notification}${e.resolutionNote ? ` · ${e.resolutionNote}` : ''}`
		),
		'None.'
	);
	section(
		'Evidence Timeline',
		r.timeline.map((t) => `- ${t.at.slice(11, 19)} — ${t.description} _(${t.source})_`),
		'No events.'
	);
	lines.push(
		'',
		'## Incident Status',
		'',
		`${r.status.toUpperCase()}${r.resolvedAt ? ` (resolved ${r.resolvedAt})` : ''}`
	);
	section(
		'Recommended Next Steps',
		r.recommendedNextSteps.map((s) => `- ${s}`),
		'None.'
	);
	lines.push(
		'',
		'---',
		`Generated ${r.generatedAt} by SENTINEL from ${r.evidenceStats.facts} current facts (${r.evidenceStats.factsWithTracedQuote} traced to transcript), ${r.evidenceStats.supersededValues} superseded values and ${r.evidenceStats.userUtterances} reporter utterances.`
	);
	return lines.join('\n');
}
