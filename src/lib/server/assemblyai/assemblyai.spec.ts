import { afterEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$lib/server/env', () => envMock);

import { isAssemblyAIConfigured, VOICE_AGENT_WS_URL } from './token';
import {
	buildSessionUpdate,
	buildTools,
	configuredVoice,
	SUPPORTED_VOICES,
	toolsForTier
} from './session-config';
import { repairToolArguments, TOOL_NAMES, TOOL_SCHEMAS } from '../tools/schemas';

afterEach(() => {
	envMock.env = {};
});

describe('AssemblyAI configuration', () => {
	it('is configured only by a non-blank server-side key and uses the documented endpoint', () => {
		expect(isAssemblyAIConfigured()).toBe(false);
		envMock.env.ASSEMBLYAI_API_KEY = '   ';
		expect(isAssemblyAIConfigured()).toBe(false);
		envMock.env.ASSEMBLYAI_API_KEY = 'test-key';
		expect(isAssemblyAIConfigured()).toBe(true);
		expect(VOICE_AGENT_WS_URL).toBe('wss://agents.assemblyai.com/v1/ws');
	});
});

describe('voice agent session configuration', () => {
	it('only accepts documented voice ids', () => {
		envMock.env.ASSEMBLYAI_VOICE = 'claire'; // legacy, rejected by the API
		expect(configuredVoice()).toBe('jane');
		envMock.env.ASSEMBLYAI_VOICE = 'Anna';
		expect(configuredVoice()).toBe('anna');
		expect(SUPPORTED_VOICES).toContain('alba');
	});
	it('uses the flat function-tool schema with valid JSON Schema parameters', () => {
		for (const tool of buildTools(TOOL_NAMES)) {
			expect(tool.type).toBe('function');
			expect(tool.description.length).toBeGreaterThan(20);
			expect(tool.parameters.type).toBe('object');
			expect(tool.parameters).not.toHaveProperty('$schema');
			expect(JSON.stringify(tool.parameters)).not.toContain('additionalProperties');
			expect(tool.timeout_seconds).toBeGreaterThanOrEqual(1);
		}
		const create = buildTools(['create_incident'])[0].parameters as {
			required: string[];
			properties: Record<string, { enum?: string[] }>;
		};
		expect(create.required).toEqual(expect.arrayContaining(['title', 'type']));
		expect(create.properties.type.enum).toContain('refrigeration_failure');
	});
	it('keeps fact.value REQUIRED for the model (a relaxed schema caused omissions live)', () => {
		const create = buildTools(['create_incident'])[0].parameters as {
			properties: { facts: { items: { required: string[] } } };
		};
		expect(create.properties.facts.items.required).toEqual(
			expect.arrayContaining(['key', 'value', 'certainty', 'basis'])
		);
	});
	it('reveals tools progressively and keeps the set small', () => {
		expect(toolsForTier('intake', null)).toEqual(['create_incident']);
		const response = toolsForTier('response', null);
		expect(response).not.toContain('create_incident');
		expect(response.length).toBeLessThanOrEqual(12);
	});
	it('sets immutable fields only on the first update and bakes in honesty rules', () => {
		const first = buildSessionUpdate({
			now: new Date(),
			snap: null,
			contacts: [],
			isDemo: true,
			scenario: null,
			initial: true
		});
		expect(first.tier).toBe('intake');
		expect(first.session).toHaveProperty('greeting', "I'm listening. Tell me what happened.");
		expect(first.session).toHaveProperty('output.voice');
		const prompt = String(first.session.system_prompt);
		expect(prompt).toMatch(/NEVER INVENT/);
		expect(prompt).toMatch(
			/Never claim you called, messaged or notified anyone unless a tool result or SYSTEM EVENT says so/
		);
		expect(prompt).toMatch(/"sent" is not "delivered"/);
		expect(prompt).toMatch(/DEMO MODE/);
		const later = buildSessionUpdate({
			now: new Date(),
			snap: null,
			contacts: [],
			isDemo: false,
			scenario: null,
			initial: false
		});
		expect(later.session).not.toHaveProperty('greeting');
		expect(later.session).not.toHaveProperty('output');
	});
});

describe('tool argument repair (observed live)', () => {
	it('drops an invented fact category instead of rejecting the call, and keeps valid ones', () => {
		const { args, repairs } = repairToolArguments('create_incident', {
			title: 'Freezer failure',
			type: 'refrigeration_failure',
			facts: [
				{
					key: 'temperature',
					value: '12°C',
					certainty: 'exact',
					basis: 'stated',
					category: 'temperature'
				},
				{
					key: 'location',
					value: 'Yangon',
					certainty: 'exact',
					basis: 'stated',
					category: 'location'
				}
			]
		});
		expect(repairs).toEqual(['facts.0.category "temperature" dropped']);
		const parsed = TOOL_SCHEMAS.create_incident.safeParse(args);
		expect(parsed.success).toBe(true);
		if (parsed.success) expect(parsed.data.facts[1].category).toBe('location');
	});
});
