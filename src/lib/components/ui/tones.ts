import type { EpistemicClass, IncidentStatus, Severity, ActionStatus } from '$lib/domain/types';

/** Central colour semantics so every panel speaks the same visual language. */
export const SEVERITY_TONE: Record<Severity, string> = {
	critical: 'bg-crit/15 text-crit border-crit/50',
	high: 'bg-high/15 text-high border-high/50',
	medium: 'bg-med/10 text-med border-med/40',
	low: 'bg-ink-700/60 text-ink-300 border-ink-600'
};

export const SEVERITY_TEXT: Record<Severity, string> = {
	critical: 'text-crit',
	high: 'text-high',
	medium: 'text-med',
	low: 'text-ink-300'
};

export const STATUS_TONE: Record<IncidentStatus, string> = {
	new: 'text-ink-300 border-ink-600',
	assessing: 'text-info border-info/40',
	active: 'text-high border-high/40',
	mitigating: 'text-warn border-warn/40',
	monitoring: 'text-info border-info/40',
	escalated: 'text-crit border-crit/50',
	blocked: 'text-crit border-crit/50',
	resolved: 'text-ok border-ok/40',
	closed: 'text-ink-400 border-ink-600'
};

export const EPISTEMIC_TONE: Record<
	EpistemicClass,
	{ text: string; chip: string; symbol: string }
> = {
	confirmed: { text: 'text-ok', chip: 'bg-ok/10 text-ok border-ok/40', symbol: '✓' },
	reported: {
		text: 'text-ink-200',
		chip: 'bg-ink-700/50 text-ink-200 border-ink-600',
		symbol: '●'
	},
	unverified: { text: 'text-warn', chip: 'bg-warn/10 text-warn border-warn/40', symbol: '⚠' },
	approximate: { text: 'text-warn', chip: 'bg-warn/10 text-warn border-warn/40', symbol: '≈' },
	inferred: { text: 'text-info', chip: 'bg-info/10 text-info border-info/40', symbol: '◇' },
	disputed: { text: 'text-crit', chip: 'bg-crit/10 text-crit border-crit/40', symbol: '!' }
};

export const ACTION_TONE: Record<ActionStatus, string> = {
	pending: 'text-ink-300 border-ink-600',
	in_progress: 'text-info border-info/40',
	completed: 'text-ok border-ok/40',
	blocked: 'text-crit border-crit/50',
	escalated: 'text-high border-high/50',
	cancelled: 'text-ink-500 border-ink-700'
};
