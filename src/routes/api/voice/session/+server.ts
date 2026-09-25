import { error, json } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '$lib/server/db';
import { users } from '$lib/server/db/schema';
import { rateLimit, readJson, requireRole } from '$lib/server/http';
import { isAssemblyAIConfigured } from '$lib/server/assemblyai/token';
import { createVoiceSession, QuotaError } from '$lib/server/assemblyai/voice-sessions';
import { NotFoundError } from '$lib/server/incidents/repository';
import { RELAY_PATH } from '$lib/server/voice/relay-server';
import type { RequestHandler } from './$types';

const body = z.object({
	incidentId: z.string().max(64).nullish(),
	scenario: z.string().max(32).nullish(),
	/** The user accepted the recording/transcription notice (stored once per user). */
	consent: z.boolean().optional()
});

/**
 * Register a voice session. The browser then opens the relay WebSocket
 * (same origin, cookie-authenticated); SENTINEL itself connects to
 * AssemblyAI. No AssemblyAI credential or token is ever sent to the browser.
 */
export const POST: RequestHandler = async (event) => {
	const auth = requireRole(event, 'reporter');
	await rateLimit(event, 'voice-session', 10);
	if (!isAssemblyAIConfigured()) {
		error(503, 'Voice is not configured on the server. You can continue manually.');
	}
	const input = await readJson(event.request, body);
	const db = await getDb();
	let consentAt = auth.voiceConsentAt;
	if (!consentAt) {
		if (!input.consent)
			error(428, 'Consent to recording and transcription is required before voice can start.');
		consentAt = new Date();
		await db.update(users).set({ voiceConsentAt: consentAt }).where(eq(users.id, auth.userId));
	}
	try {
		const session = await createVoiceSession(db, {
			orgId: auth.orgId,
			userId: auth.userId,
			incidentId: input.incidentId ?? null,
			scenario: input.scenario ?? null,
			consentAt
		});
		return json({
			voiceSessionId: session.id,
			relayPath: `${RELAY_PATH}?session=${encodeURIComponent(session.id)}`,
			isDemo: session.isDemo
		});
	} catch (e) {
		if (e instanceof QuotaError) error(429, e.message);
		if (e instanceof NotFoundError) error(404, e.message);
		throw e;
	}
};
