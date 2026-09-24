import { env } from '$env/dynamic/private';

/**
 * Temporary token for the browser. Verified against
 * https://www.assemblyai.com/docs/voice-agents/voice-agent-api/browser-integration :
 *   GET https://agents.assemblyai.com/v1/token?expires_in_seconds=…&max_session_duration_seconds=…
 *   Authorization: Bearer <API key>   → { token, expires_in_seconds }
 * Tokens are single-use; the browser fetches a fresh one for every connect/resume.
 * The API key never leaves the server.
 */
export const VOICE_AGENT_WS_URL = 'wss://agents.assemblyai.com/v1/ws';
const TOKEN_URL = 'https://agents.assemblyai.com/v1/token';

/** Redemption window: the browser connects immediately after fetching. */
const TOKEN_TTL_SECONDS = 60;
/** Hard cap on a single voice session (billing guard). 30 minutes is ample for an incident call. */
export const MAX_SESSION_SECONDS = 30 * 60;

export function isAssemblyAIConfigured(): boolean {
	return !!env.ASSEMBLYAI_API_KEY?.trim();
}

export class TokenError extends Error {
	constructor(
		message: string,
		readonly status: number
	) {
		super(message);
	}
}

export async function mintVoiceAgentToken(fetchImpl: typeof fetch = fetch): Promise<string> {
	const key = env.ASSEMBLYAI_API_KEY?.trim();
	if (!key) throw new TokenError('ASSEMBLYAI_API_KEY is not configured on the server.', 503);
	const url = new URL(TOKEN_URL);
	url.searchParams.set('expires_in_seconds', String(TOKEN_TTL_SECONDS));
	url.searchParams.set('max_session_duration_seconds', String(MAX_SESSION_SECONDS));
	let res: Response;
	try {
		res = await fetchImpl(url, { headers: { Authorization: `Bearer ${key}` } });
	} catch {
		throw new TokenError('Could not reach AssemblyAI to create a voice session.', 502);
	}
	if (!res.ok) {
		// Never forward upstream bodies verbatim; they may echo request details.
		const reason =
			res.status === 401
				? 'AssemblyAI rejected the API key.'
				: res.status === 429
					? 'AssemblyAI rate limit reached. Try again shortly.'
					: `AssemblyAI token request failed (${res.status}).`;
		throw new TokenError(reason, res.status === 401 ? 502 : res.status === 429 ? 429 : 502);
	}
	const body = (await res.json()) as { token?: string };
	if (!body.token) throw new TokenError('AssemblyAI returned no token.', 502);
	return body.token;
}
