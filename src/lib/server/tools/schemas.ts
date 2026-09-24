import { z } from 'zod';
import {
	ACTION_PRIORITIES,
	CONTACT_ROLES,
	FACT_CATEGORIES,
	INCIDENT_STATUSES,
	INCIDENT_TYPES,
	INFO_PRIORITIES,
	SEVERITIES
} from '$lib/domain/types';

/**
 * Tool argument schemas. The same Zod schema:
 *  1. validates every call server-side (unknown keys are stripped), and
 *  2. is converted to the JSON Schema we register with the AssemblyAI agent.
 * Descriptions are written for the model: format first, then an example.
 */

const factKey = z
	.string()
	.min(1)
	.max(64)
	.describe(
		'snake_case key. Reuse checklist keys when they fit: location, incident_start, temperature, affected_inventory, unit_status, backup_storage, responsible_person, doors_closed, inventory_quantity, people_at_risk, impact.'
	)
	.meta({ examples: ['temperature', 'unit_status', 'backup_storage'] });

const evidenceQuote = z
	.string()
	.max(300)
	.describe("The user's own words that support this, copied verbatim from what they said.")
	.meta({ examples: ['the display says twelve degrees'] });

export const factInput = z.object({
	key: factKey,
	value: z
		.string()
		.min(1)
		.max(300)
		.describe('Value in plain words, as the user gave it.')
		.meta({ examples: ['12°C', 'running but not cooling', 'frozen chicken and dairy'] }),
	numeric_value: z
		.number()
		.optional()
		.describe('Only for numeric readings. Example: 12 for "twelve degrees".'),
	unit: z.string().max(16).optional().describe('Unit of numeric_value, e.g. "C", "F", "kg".'),
	minutes_ago: z
		.number()
		.min(0)
		.max(60 * 24 * 7)
		.optional()
		.describe('Only for key incident_start: how many minutes ago it started. Example: 20.'),
	certainty: z
		.enum(['exact', 'approximate'])
		.describe('"approximate" whenever the user hedged: about, around, roughly, I think, maybe.'),
	basis: z
		.enum(['stated', 'inferred'])
		.describe('"stated" if the user said it. "inferred" only if you concluded it yourself.'),
	evidence_quote: evidenceQuote.optional(),
	category: z.enum(FACT_CATEGORIES).optional(),
	label: z.string().max(80).optional().describe('Short human label, e.g. "Unit status".')
});
export type FactInput = z.infer<typeof factInput>;

/**
 * Server-side repair of recoverable omissions, applied BEFORE validation.
 * The model-facing schema stays strict (value is required, so the model keeps
 * sending it). Live testing showed a relaxed schema made the model omit values
 * more often. When a value is still missing, derive it from numeric_value/unit,
 * minutes_ago or the evidence quote instead of failing the whole call.
 */
export function repairToolArguments(
	name: string,
	args: unknown
): { args: unknown; repairs: string[] } {
	const repairs: string[] = [];
	if (!args || typeof args !== 'object') return { args, repairs };
	const a = structuredClone(args) as Record<string, unknown>;
	if ((name === 'create_incident' || name === 'add_fact') && Array.isArray(a.facts)) {
		a.facts = a.facts.map((f: unknown, i: number) => {
			if (!f || typeof f !== 'object') return f;
			const fact = { ...(f as Record<string, unknown>) };
			const v = typeof fact.value === 'string' ? fact.value.trim() : '';
			if (v) return fact;
			let derived: string | null = null;
			if (typeof fact.numeric_value === 'number') {
				const u = typeof fact.unit === 'string' ? fact.unit.trim() : '';
				derived = `${fact.numeric_value}${/^[cf]$/i.test(u) ? `°${u.toUpperCase()}` : u ? ` ${u}` : ''}`;
			} else if (typeof fact.minutes_ago === 'number') {
				derived = `about ${Math.round(fact.minutes_ago)} minutes before the report`;
			} else if (typeof fact.evidence_quote === 'string' && fact.evidence_quote.trim()) {
				derived = fact.evidence_quote.trim().slice(0, 300);
			}
			if (derived) {
				fact.value = derived;
				repairs.push(`facts.${i}.value derived as "${derived}"`);
			}
			return fact;
		});
	}
	return { args: a, repairs };
}

export const createIncidentSchema = z.object({
	title: z
		.string()
		.min(3)
		.max(120)
		.describe('Short incident title.')
		.meta({ examples: ['Walk-in freezer failure', 'All POS terminals down'] }),
	type: z.enum(INCIDENT_TYPES).describe('Closest incident type.'),
	summary: z
		.string()
		.max(600)
		.optional()
		.describe('One-sentence neutral summary of what was reported.'),
	facts: z
		.array(factInput)
		.max(12)
		.default([])
		.describe('Every detail the user has given so far, including location, one entry per fact.')
});

export const updateIncidentSchema = z.object({
	status: z
		.enum(INCIDENT_STATUSES)
		.optional()
		.describe('New lifecycle status, if it should change.'),
	severity: z
		.enum(SEVERITIES)
		.optional()
		.describe('Only to override the automatic severity assessment. Requires reason.'),
	title: z.string().min(3).max(120).optional(),
	summary: z.string().max(600).optional(),
	type: z.enum(INCIDENT_TYPES).optional(),
	reason: z.string().max(300).optional().describe('Why this change is being made.')
});

export const addFactSchema = z.object({
	facts: z
		.array(factInput)
		.min(1)
		.max(10)
		.describe(
			'New or updated facts. A new value for an existing key supersedes the old one and keeps it in history.'
		)
});

export const markFactUncertainSchema = z.object({
	key: factKey,
	reason: z.string().min(3).max(300).describe('Why the value is now in doubt.'),
	disputed: z
		.boolean()
		.optional()
		.describe('true if the user now believes the value may be wrong, not just imprecise.'),
	evidence_quote: evidenceQuote.optional()
});

export const markFactConfirmedSchema = z.object({
	key: factKey,
	method: z
		.enum(['user_rechecked', 'independent_source', 'action_outcome'])
		.describe('How it was confirmed.'),
	corrected_value: z
		.string()
		.max(300)
		.optional()
		.describe('Only if the re-check gave a different value, e.g. "13.4°C".'),
	corrected_numeric_value: z.number().optional(),
	unit: z.string().max(16).optional(),
	evidence_quote: evidenceQuote.optional()
});

const actionItem = z.object({
	title: z
		.string()
		.min(3)
		.max(120)
		.describe('Imperative action title.')
		.meta({ examples: ['Keep refrigeration doors closed', 'Contact maintenance'] }),
	description: z.string().max(400).optional(),
	priority: z.enum(ACTION_PRIORITIES).default('normal'),
	status: z
		.enum(['pending', 'in_progress', 'completed'])
		.default('pending')
		.describe('Use completed only if the user said it is already done.'),
	owner: z.string().max(80).optional().describe('Who carries it out, if known.'),
	contact_role: z
		.enum(CONTACT_ROLES)
		.optional()
		.describe('Role that must be contacted for this action, e.g. maintenance.'),
	contact_name: z
		.string()
		.max(80)
		.optional()
		.describe('Only a name the user said or the directory lists.'),
	because_of: factKey
		.optional()
		.describe(
			'Key of the recorded fact that makes this action necessary, e.g. temperature or affected_inventory.'
		),
	requires_response: z
		.boolean()
		.optional()
		.describe('true if we are waiting on a reply from the contact (enables timeout escalation).')
});

export const addActionSchema = z.object({
	actions: z.array(actionItem).min(1).max(8)
});

const actionRef = z.number().int().min(1).max(999).describe('Action number, e.g. 3 for A3.');

export const updateActionSchema = z.object({
	action: actionRef,
	status: z.enum(['pending', 'in_progress', 'completed', 'blocked', 'cancelled']),
	note: z.string().max(300).optional(),
	blocked_reason: z.string().max(300).optional().describe('Required when status is blocked.')
});

export const requestInformationSchema = z.object({
	key: factKey,
	question: z.string().min(3).max(200).describe('The question to ask, phrased naturally.'),
	priority: z.enum(INFO_PRIORITIES).default('important'),
	status: z
		.enum(['open', 'unavailable', 'not_applicable'])
		.default('open')
		.describe(
			'"unavailable" when the user says they do not know; "not_applicable" when it does not apply.'
		),
	note: z.string().max(200).optional()
});

export const recordResponseSchema = z.object({
	action: actionRef,
	responder: z.string().min(1).max(80).describe('Who responded, e.g. "Ko Min".'),
	response: z.string().min(1).max(400).describe('What they said, briefly.'),
	evidence_quote: evidenceQuote.optional()
});

export const createEscalationSchema = z.object({
	reason: z.string().min(3).max(300),
	target_role: z
		.enum(CONTACT_ROLES)
		.optional()
		.describe('Role to escalate to. Default: operations_manager.'),
	target_name: z.string().max(80).optional(),
	action: actionRef.optional()
});

export const resolveEscalationSchema = z.object({
	escalation: z.number().int().min(1).max(999).describe('Escalation number, e.g. 1 for E1.'),
	status: z.enum(['acknowledged', 'resolved']),
	note: z.string().min(1).max(300)
});

export const addTimelineEventSchema = z.object({
	event_type: z.enum(['note', 'observation', 'decision', 'communication']),
	description: z.string().min(3).max(400)
});

export const generateReportSchema = z.object({});

export const closeIncidentSchema = z.object({
	final_status: z.enum(['resolved', 'closed']),
	resolution_summary: z.string().min(3).max(600)
});

export const TOOL_SCHEMAS = {
	create_incident: createIncidentSchema,
	update_incident: updateIncidentSchema,
	add_fact: addFactSchema,
	mark_fact_uncertain: markFactUncertainSchema,
	mark_fact_confirmed: markFactConfirmedSchema,
	add_action: addActionSchema,
	update_action: updateActionSchema,
	request_information: requestInformationSchema,
	record_response: recordResponseSchema,
	create_escalation: createEscalationSchema,
	resolve_escalation: resolveEscalationSchema,
	add_timeline_event: addTimelineEventSchema,
	generate_incident_report: generateReportSchema,
	close_incident: closeIncidentSchema
} as const;

export type ToolName = keyof typeof TOOL_SCHEMAS;
export const TOOL_NAMES = Object.keys(TOOL_SCHEMAS) as ToolName[];
export type ToolArgs<N extends ToolName> = z.infer<(typeof TOOL_SCHEMAS)[N]>;

export function isToolName(name: string): name is ToolName {
	return Object.hasOwn(TOOL_SCHEMAS, name);
}

/** JSON Schema for the AssemblyAI `parameters` field. */
export function toParametersJsonSchema(name: ToolName): Record<string, unknown> {
	const schema = z.toJSONSchema(TOOL_SCHEMAS[name], {
		io: 'input',
		unrepresentable: 'any'
	}) as Record<string, unknown>;
	return stripKeys(schema, ['$schema', 'additionalProperties']) as Record<string, unknown>;
}

function stripKeys(value: unknown, keys: string[]): unknown {
	if (Array.isArray(value)) return value.map((v) => stripKeys(v, keys));
	if (value && typeof value === 'object') {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([k]) => !keys.includes(k))
				.map(([k, v]) => [k, stripKeys(v, keys)])
		);
	}
	return value;
}
