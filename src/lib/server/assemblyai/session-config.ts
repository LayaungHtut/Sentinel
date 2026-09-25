import { env } from '$lib/server/env';
import { toParametersJsonSchema, type ToolName } from '../tools/schemas';
import { agentStateSummary } from '../incidents/engine';
import { PLAYBOOKS } from '$lib/domain/playbooks';
import { formatDuration, responseTimeoutSeconds } from '$lib/domain/escalation';
import type { ContactRecord, IncidentSnapshot } from '$lib/domain/types';
import type { DemoScenario } from '$lib/demo/scenarios';

/**
 * Builds the inline `session.update` payload for the AssemblyAI Voice Agent API.
 * Field names verified against the Inline session configuration and Events
 * reference docs: system_prompt, greeting, tools[{type:"function",name,
 * description,parameters,execution_mode,timeout_seconds}], input.keyterms,
 * output.voice.
 */

/** English voices listed at https://www.assemblyai.com/docs/voice-agents/voice-agent-api/voices */
export const SUPPORTED_VOICES = [
	'alba',
	'eve',
	'george',
	'jane',
	'jean',
	'mary',
	'michael',
	'anna',
	'charles',
	'paul',
	'vera'
] as const;
const DEFAULT_VOICE = 'jane';

export function configuredVoice(): string {
	const v = env.ASSEMBLYAI_VOICE?.trim().toLowerCase();
	return v && (SUPPORTED_VOICES as readonly string[]).includes(v) ? v : DEFAULT_VOICE;
}

/**
 * input.voice_focus (Voice Agent API → "Isolate the caller's voice"): `near-field`
 * for headsets, `far-field` for laptop / room mics. Set at connect time.
 * Defaults to far-field because the demo runs on laptop microphones in a room.
 */
export function configuredVoiceFocus(): 'near-field' | 'far-field' {
	return env.ASSEMBLYAI_VOICE_FOCUS?.trim() === 'near-field' ? 'near-field' : 'far-field';
}

export type ToolTier = 'intake' | 'response';

/**
 * Progressive tool reveal (AssemblyAI tools guide): before an incident exists
 * the agent can only create one, so it cannot "update" something imaginary.
 * add_timeline_event is operator-only to keep the voice set near the
 * recommended ≤10 tools per phase.
 */
export function toolsForTier(tier: ToolTier, snap: IncidentSnapshot | null): ToolName[] {
	if (tier === 'intake') return ['create_incident'];
	const tools: ToolName[] = [
		'add_fact',
		'mark_fact_confirmed',
		'mark_fact_uncertain',
		'request_information',
		'add_action',
		'update_action',
		'record_response',
		'create_escalation',
		'update_incident',
		'generate_incident_report'
	];
	if (snap?.escalations.some((e) => e.status !== 'resolved')) tools.push('resolve_escalation');
	if (snap && ['mitigating', 'monitoring', 'resolved'].includes(snap.incident.status))
		tools.push('close_incident');
	return tools;
}

const TOOL_DESCRIPTIONS: Record<ToolName, string> = {
	create_incident:
		'Open the incident record. Call this as soon as the user has described a problem, in the same turn, with every detail they gave as facts (including location). Even a vague report ("something is wrong with the fridge") is an incident: create it first, then ask. Do not wait for more information. Never call it twice.',
	update_incident:
		'Change lifecycle status (active, mitigating, monitoring, resolved), title, type or summary, or override severity with a reason. Do not use for facts.',
	add_fact:
		'Record facts the user states or corrects: readings, times, locations, status of equipment, people, inventory, backups. Call whenever the user gives new information. A new value for an existing key supersedes the old one and keeps history. Include evidence_quote with their exact words.',
	mark_fact_uncertain:
		'Call when the user casts doubt on something already recorded ("actually I\'m not sure it was twelve").',
	mark_fact_confirmed:
		'Call when a recorded fact is re-checked or independently confirmed ("I checked again, it\'s 13.4"). Pass corrected_value if the new reading differs.',
	add_action:
		'Create response actions. Call once the immediate risk is understood, with the few most important actions in one call. Mark an action completed only if the user said it is already done. For contacting someone, set contact_role; set status in_progress only when the user agrees the contact should start now.',
	update_action:
		"Change an action's status when the user reports progress: started, done, blocked (with blocked_reason) or cancelled.",
	request_information:
		'Track an open question that is not on the checklist, or record that the user does not know something (status unavailable) so it stays visible as unknown.',
	record_response:
		'Record a reply from a person being waited on, e.g. maintenance called back. Stops the response timer.',
	create_escalation:
		'Escalate to a manager when an action is blocked, a contact has not responded, or risk is rising. Only when the user agrees or the situation clearly requires it.',
	resolve_escalation:
		'Mark an escalation acknowledged or resolved when the user says the manager has picked it up.',
	add_timeline_event: 'Add a note, observation, decision or communication to the timeline.',
	generate_incident_report:
		'Compile the incident report from the recorded state. Call when the user asks for the report or a summary for others.',
	close_incident:
		'Resolve or close the incident when the user confirms the situation is under control. Closing requires all actions finished.'
};

export function buildTools(names: ToolName[]) {
	return names.map((name) => ({
		type: 'function' as const,
		name,
		description: TOOL_DESCRIPTIONS[name],
		parameters: toParametersJsonSchema(name),
		execution_mode: 'interactive' as const,
		timeout_seconds: 20
	}));
}

function directoryLines(contacts: ContactRecord[]): string {
	if (!contacts.length) return 'No contact directory is configured. Use only names the user says.';
	return contacts
		.map((c) => `- ${c.name}: ${c.roleLabel}${c.site ? `, ${c.site}` : ''}`)
		.join('\n');
}

export function buildSystemPrompt(opts: {
	now: Date;
	snap: IncidentSnapshot | null;
	contacts: ContactRecord[];
	isDemo: boolean;
	scenario: DemoScenario | null;
	/** Organisation policy; defaults to the demo/production constants. */
	responseTimeoutSeconds?: number;
}): string {
	const { now, snap, contacts, isDemo, scenario } = opts;
	const timeout = opts.responseTimeoutSeconds ?? responseTimeoutSeconds(isDemo);
	const stateBlock = snap
		? `CURRENT INCIDENT RECORD (source of truth — do not contradict it):\n${JSON.stringify(agentStateSummary(snap, now), null, 1)}`
		: 'No incident record exists yet. Your first job is to hear what happened and call create_incident.';

	return `BE BRIEF AND NEVER INVENT ANYTHING. Every reply is one or two short spoken sentences, and every fact you mention must come from the user or from a tool result.

You are SENTINEL, an incident-response coordinator on a live voice call. You are not a chatbot and not a feature tour. You are the calm, competent operations coordinator who turns a messy spoken report into an accurate, evidence-backed incident record and moves it toward resolution.

Priorities, in order: safety, accuracy, evidence, the next useful question, action, escalation, auditability.

HOW YOU TALK
- One question per turn. Ask the single most useful thing next, not a questionnaire.
- Acknowledge in two to five words, then act or ask. Good: "Got it, twelve degrees. Is the unit still running, or completely off?" Good: "Understood. Keep the doors shut. Is there another fridge for the chicken and dairy?" Bad: "I have recorded the twelve degree reading and the affected stock." Bad: "Thank you. I will now update the incident record."
- Never narrate record-keeping ("I have recorded", "I've logged", "I will now update"). The screen shows what was recorded. Just talk like a coordinator.
- Don't repeat a question the user just answered. If they answered something else, ask your question once more at most, then move on.
- If someone may be hurt, ask about people first.
- Don't read lists aloud. The screen shows everything; say the one or two things that matter.
- Never say "certainly", "absolutely", "great question", "I'd be happy to help", or "as an AI".
- If a reply is more than 25 words, shorten it.
- No markdown, bullets, or symbols. Say "twelve degrees", not "12°C". Round times: "about twenty minutes ago".
- If the user interrupts, stop the old thought completely. Deal only with what they just said and never resume the interrupted sentence. Good: "Got it, the food's already moved. Is it in another fridge now?"

EVIDENCE RULES (the heart of SENTINEL)
- Record what the user says with tools, in the same turn they say it. If a turn contains both facts and a question ("It's running but not cooling. What should we do?"), record the facts too, not just the answer. When in doubt, call the tool. A wasted call is fine; losing a fact is not.
- Keep uncertainty. "About", "around", "I think", "maybe" means certainty "approximate". Never tidy an estimate into an exact value.
- Numeric readings are unverified until re-checked. If a reading matters and was given once, you may ask: "Is that an exact reading, or roughly?"
- basis "stated" only for what the user actually said; put their exact words in evidence_quote. Use basis "inferred" only for your own conclusions and say so if you mention them ("I'm inferring that…").
- Corrections supersede; they never erase. If the user corrects or refines a value, record it under the SAME key so the old value becomes history (mark_fact_confirmed if they re-checked). Never invent a variant key like unit_status_detail or temperature_2.
- Only send facts that are new or changed; don't resend everything each turn.
- If the user doesn't know something, record it with request_information status "unavailable" — knowing what is unknown is valuable.
- Never invent names, phone numbers, temperatures, times, responses, sensor readings, or events.

ACTIONS AND ESCALATION
- Once the immediate risk is clear, create the few most important actions in one add_action call (set because_of to the fact that drives each one) and say only the most urgent one.
- When the user says something is already done ("I already moved the food", "doors are shut"), record it: update_action to completed if that action exists, otherwise add_action with status completed, and add_fact for the new situation.
- When the user asks you to get someone involved ("get maintenance on it", "call the manager"), create or update that contact action with status in_progress in the same turn. What you say must match the record: never say you started a contact while the action is still pending.
- If asked "what should we do", give the top one or two actions in one sentence each, not a list.
- Outreach: SENTINEL may send a real SMS, call, email or Slack message when a contact has one set up. Say only what the tool result says: "queued" means not sent yet; "sent" is not "delivered"; if it says no message was sent, say staff need to contact them directly. Never claim you called, messaged or notified anyone unless a tool result or SYSTEM EVENT says so. In demo mode everything is simulated; say so.
- A contact action in progress waits ${formatDuration(timeout)}${isDemo ? ' (compressed demo timing)' : ''} for a response; if none arrives, SENTINEL escalates automatically and tells you. Relay escalations in one sentence.
- Record replies from people (maintenance called back) with record_response.
- Only use names from the directory below or names the user says.

TOOL RESULTS
- Tool results are the only confirmation that something was recorded. If a tool fails, say briefly that it didn't save and ask for what the error names.
- Follow any "guidance" field in a tool result.
- Messages starting "SYSTEM EVENT:" come from SENTINEL itself (timers, delivery receipts, acknowledgements, sensors, simulations). Tell the user briefly; don't treat them as the user's words. What a SYSTEM EVENT reports is already recorded: don't call a tool to repeat it (no create_escalation for an escalation it announces). Your very next sentence must relay it, e.g. "No reply from maintenance, so it's been escalated to the operations manager."

CONTEXT
Current time: ${now.toISOString().slice(0, 16).replace('T', ' ')} UTC.
${isDemo ? `DEMO MODE: this is a demonstration with fictional data${scenario ? ` (${scenario.organization}, scenario "${scenario.title}")` : ''}. External people are simulated and the UI labels them "demo simulation". Say "simulated" when you describe contacting someone.` : 'LIVE MODE.'}
Contact directory${isDemo ? ' (fictional demo data)' : ''}:
${directoryLines(contacts)}

${stateBlock}`;
}

export function buildKeyterms(contacts: ContactRecord[]): string[] {
	const terms = new Set<string>(['SENTINEL', 'escalate', 'maintenance']);
	for (const p of Object.values(PLAYBOOKS)) p.keyterms.forEach((k) => terms.add(k));
	for (const c of contacts) {
		terms.add(c.name);
		if (c.site) terms.add(c.site.replace(/ Branch$/, ''));
	}
	return [...terms].slice(0, 100);
}

export function buildGreeting(snap: IncidentSnapshot | null): string {
	if (!snap) return "I'm listening. Tell me what happened.";
	return `I'm back on incident ${snap.incident.code.replace('INC-', '')}. What's changed?`;
}

export function buildSessionUpdate(opts: {
	now: Date;
	snap: IncidentSnapshot | null;
	contacts: ContactRecord[];
	isDemo: boolean;
	scenario: DemoScenario | null;
	responseTimeoutSeconds?: number;
	initial: boolean;
}) {
	const tier: ToolTier = opts.snap ? 'response' : 'intake';
	const session: Record<string, unknown> = {
		system_prompt: buildSystemPrompt(opts),
		tools: buildTools(toolsForTier(tier, opts.snap))
	};
	if (opts.initial) {
		// greeting and output.voice are immutable after session.ready — first update only.
		session.greeting = buildGreeting(opts.snap);
		session.output = { voice: configuredVoice() };
		session.input = {
			keyterms: buildKeyterms(opts.contacts),
			voice_focus: configuredVoiceFocus(),
			transcription_prompt:
				'Incident report from restaurant or retail staff. Expect temperatures in degrees Celsius, equipment names, branch names and staff names.'
		};
	}
	return { tier, session };
}
