import { afterEach, describe, expect, it, vi } from 'vitest';

const envMock = vi.hoisted(() => ({ env: {} as Record<string, string | undefined> }));
vi.mock('$env/dynamic/private', () => envMock);

import { mintVoiceAgentToken, TokenError, VOICE_AGENT_WS_URL } from './token';
import {
	buildSessionUpdate,
	buildTools,
	configuredVoice,
	SUPPORTED_VOICES,
	toolsForTier
} from './session-config';
import { TOOL_NAMES } from '../tools/schemas';

afterEach(() => {
	envMock.env = {};
});

describe('temporary token minting (mocked AssemblyAI)', () => {
	it('calls the documented token endpoint with a Bearer key and bounded TTLs', async () => {
		envMock.env.ASSEMBLYAI_API_KEY = 'test-key';
		const fetchMock = vi.fn(
			async () => new Response(JSON.stringify({ token: 'tmp-123', expires_in_seconds: 60 }))
		);
		const token = await mintVoiceAgentToken(fetchMock as unknown as typeof fetch);
		expect(token).toBe('tmp-123');
		const [url, init] = fetchMock.mock.calls[0] as unknown as [URL, RequestInit];
		expect(url.origin + url.pathname).toBe('https://agents.assemblyai.com/v1/token');
		expect(Number(url.searchParams.get('expires_in_seconds'))).toBeLessThanOrEqual(600);
		expect(Number(url.searchParams.get('max_session_duration_seconds'))).toBeGreaterThanOrEqual(60);
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer test-key');
		expect(VOICE_AGENT_WS_URL).toBe('wss://agents.assemblyai.com/v1/ws');
	});
	it('fails clearly without a key and never echoes upstream bodies', async () => {
		await expect(mintVoiceAgentToken(vi.fn() as never)).rejects.toThrow(/not configured/);
		envMock.env.ASSEMBLYAI_API_KEY = 'bad';
		const fetchMock = vi.fn(async () => new Response('{"error":"secret detail"}', { status: 401 }));
		const err = await mintVoiceAgentToken(fetchMock as unknown as typeof fetch).catch((e) => e);
		expect(err).toBeInstanceOf(TokenError);
		expect(err.message).not.toContain('secret detail');
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
		expect(prompt).toMatch(/Never say you sent, called, messaged or notified anyone/);
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
