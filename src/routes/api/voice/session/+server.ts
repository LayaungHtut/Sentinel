import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db';
import { rateLimit, readJson } from '$lib/server/http';
import {
	isAssemblyAIConfigured,
	MAX_SESSION_SECONDS,
	mintVoiceAgentToken,
	TokenError,
	VOICE_AGENT_WS_URL
} from '$lib/server/assemblyai/token';
import { createVoiceSession, sessionConfigFor } from '$lib/server/assemblyai/voice-sessions';
import { NotFoundError } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

const body = z.object({
	incidentId: z.string().max(64).nullish(),
	scenario: z.string().max(32).nullish()
});

/**
 * Start a voice session: mint a single-use AssemblyAI token server-side and
 * return it with the inline session configuration. The API key stays here.
 */
export const POST: RequestHandler = async (event) => {
	rateLimit(event, 'voice-session', 10);
	if (!isAssemblyAIConfigured()) {
		error(
			503,
			'Voice is not configured: set ASSEMBLYAI_API_KEY on the server. You can continue manually.'
		);
	}
	const input = await readJson(event.request, body);
	const db = await getDb();
	try {
		const token = await mintVoiceAgentToken();
		const session = await createVoiceSession(db, input);
		const config = await sessionConfigFor(db, session.id, true);
		return json({
			voiceSessionId: session.id,
			token,
			wsUrl: VOICE_AGENT_WS_URL,
			sessionUpdate: config.session,
			tier: config.tier,
			maxSessionSeconds: MAX_SESSION_SECONDS,
			isDemo: session.isDemo
		});
	} catch (e) {
		if (e instanceof TokenError) error(e.status, e.message);
		if (e instanceof NotFoundError) error(404, e.message);
		throw e;
	}
};
