import type { ChecklistItem } from './information';
import type { OperationalState } from './operational';
import type { SeverityAssessment } from './severity';
import type { IncidentSnapshot, VoiceSessionStats } from './types';

/** JSON-over-the-wire shape: Dates become ISO strings. */
export type Serialized<T> = T extends Date
	? string
	: T extends (infer U)[]
		? Serialized<U>[]
		: T extends object
			? { [K in keyof T]: Serialized<T[K]> }
			: T;

export type IncidentView = Serialized<IncidentSnapshot> & {
	severityAssessment: SeverityAssessment;
	operational: OperationalState;
	checklist: ChecklistItem[];
	latestReport: { version: number; generatedAt: string } | null;
	voiceSessions: Serialized<VoiceSessionStats>[];
	serverTime: string;
};

export type FactView = IncidentView['facts'][number];
export type ActionView = IncidentView['actions'][number];
export type EscalationView = IncidentView['escalations'][number];
export type TimelineView = IncidentView['timeline'][number];
export type TranscriptView = IncidentView['transcripts'][number];

export function serialize<T>(value: T): Serialized<T> {
	return JSON.parse(JSON.stringify(value));
}
