import { env } from '$lib/server/env';

/**
 * AssemblyAI Voice Agent API connection settings. Only the SENTINEL server
 * connects (see voice/relay.ts), authenticating with `Authorization: Bearer
 * <API key>`; the browser never receives the key or a temporary token.
 */
export const VOICE_AGENT_WS_URL = 'wss://agents.assemblyai.com/v1/ws';

/** Hard cap on a single voice session (billing guard). 30 minutes is ample for an incident call. */
export const MAX_SESSION_SECONDS = 30 * 60;

export function isAssemblyAIConfigured(): boolean {
	return !!env.ASSEMBLYAI_API_KEY?.trim();
}
