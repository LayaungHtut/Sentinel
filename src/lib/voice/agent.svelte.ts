import { AudioEngine } from './audio';

/**
 * Browser side of a SENTINEL voice session.
 *
 * The browser never talks to AssemblyAI. It streams microphone audio to the
 * SENTINEL voice relay (same-origin WebSocket, cookie-authenticated) and plays
 * the agent audio it receives. The server holds the AssemblyAI connection,
 * executes every tool call and persists every transcript, so nothing the
 * browser sends is trusted as evidence.
 *
 *   browser → relay:  { type: 'audio', audio } | { type: 'text', text } | { type: 'end' }
 *   relay → browser:  AssemblyAI UI events (input.speech.*, transcript.*, reply.*)
 *                     plus { type: 'status' | 'tool' | 'incident' | 'system' }
 */

export type VoiceStatus =
	| 'idle'
	| 'connecting'
	| 'listening'
	| 'processing'
	| 'speaking'
	| 'interrupted'
	| 'reconnecting'
	| 'ended'
	| 'error';

export interface ConversationItem {
	id: string;
	speaker: 'user' | 'agent' | 'system';
	text: string;
	channel: 'voice' | 'typed' | 'system';
	interrupted: boolean;
	at: number;
}

export interface ToolActivity {
	callId: string;
	name: string;
	state: 'running' | 'ok' | 'error';
	message: string;
	at: number;
}

interface StartOptions {
	incidentId?: string | null;
	scenario?: string | null;
	/** The user accepted the recording/transcription notice. */
	consent?: boolean;
}

interface SessionResponse {
	voiceSessionId: string;
	relayPath: string;
	isDemo: boolean;
}

const MAX_RECONNECT_ATTEMPTS = 3;

export class VoiceAgent {
	status = $state<VoiceStatus>('idle');
	errorMessage = $state<string | null>(null);
	/** Machine-readable error for tailored recovery UI. */
	errorKind = $state<VoiceErrorKind | null>(null);
	/** The server needs the recording/transcription consent before voice can start. */
	needsConsent = $state(false);
	/** Mute sends silence frames, so the session and turn detection stay healthy. */
	muted = $state(false);
	notice = $state<string | null>(null);
	micLevel = $state(0);
	userSpeaking = $state(false);
	partialUser = $state('');
	partialAgent = $state('');
	items = $state<ConversationItem[]>([]);
	toolActivity = $state<ToolActivity[]>([]);
	voiceSessionId = $state<string | null>(null);
	incidentId = $state<string | null>(null);
	connectedAt = $state<number | null>(null);
	reconnectAttempt = $state(0);

	/** Called after every tool execution so the dashboard can refresh. */
	onIncidentChanged: (incidentId: string | null) => void = () => {};
	/** SENTINEL events delivered to this session (escalations, receipts, sensors). */
	onSystemEvent: (text: string) => void = () => {};

	private audio = new AudioEngine();
	private ws: WebSocket | null = null;
	private ready = false;
	private everReady = false;
	private endingIntentionally = false;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private inflightTools = 0;
	private seq = 0;
	private scenario: string | null = null;

	get active(): boolean {
		return !['idle', 'ended', 'error'].includes(this.status);
	}

	/** Must be invoked directly from a click handler (audio needs a user gesture). */
	async start(opts: StartOptions = {}): Promise<void> {
		if (this.active) return;
		this.audio.prepare();
		this.reset();
		this.status = 'connecting';
		this.incidentId = opts.incidentId ?? null;
		this.scenario = opts.scenario ?? null;
		try {
			if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
				throw new VoiceError(
					'unsupported',
					'This browser cannot capture audio for voice. Use a recent Chrome, Edge, Safari or Firefox.'
				);
			}
			const session = await this.createSession(opts.consent);
			if (!session) return; // consent requested
			try {
				await this.audio.start();
			} catch (e) {
				throw new VoiceError(micErrorKind(e), micErrorMessage(e), { cause: e });
			}
			this.audio.onMicLost = () => {
				void this.fail(
					'The microphone was disconnected. Your incident data is safe. Reconnect a microphone and resume.',
					'mic_disconnected'
				);
			};
			this.audio.onChunk = (b64, level) => {
				this.micLevel = this.muted ? 0 : Math.min(1, level * 4);
				if (this.ready && this.ws?.readyState === WebSocket.OPEN) {
					this.ws.send(
						JSON.stringify({ type: 'audio', audio: this.muted ? silenceLike(b64) : b64 })
					);
				}
			};
			document.addEventListener('visibilitychange', this.onVisibility);
			this.openSocket(session);
		} catch (e) {
			await this.fail(
				e instanceof Error ? e.message : 'Could not start voice session.',
				e instanceof VoiceError ? e.kind : 'voice'
			);
		}
	}

	/** Register a voice session on the server. Returns null when consent is needed first. */
	private async createSession(consent?: boolean): Promise<SessionResponse | null> {
		const res = await fetch('/api/voice/session', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({
				incidentId: this.incidentId,
				scenario: this.scenario,
				consent: consent ?? undefined
			})
		});
		if (res.status === 428) {
			this.needsConsent = true;
			this.status = 'idle';
			return null;
		}
		if (!res.ok) {
			const kind: VoiceErrorKind =
				res.status === 503 ? 'not_configured' : res.status === 429 ? 'quota' : 'voice';
			throw new VoiceError(kind, await errorText(res));
		}
		this.needsConsent = false;
		const session = (await res.json()) as SessionResponse;
		this.voiceSessionId = session.voiceSessionId;
		return session;
	}

	private openSocket(session: SessionResponse) {
		const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
		const ws = new WebSocket(`${scheme}://${location.host}${session.relayPath}`);
		this.ws = ws;
		ws.onmessage = (ev) => {
			if (this.ws !== ws) return;
			let msg: Record<string, unknown>;
			try {
				msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
			} catch {
				return;
			}
			this.handle(msg);
		};
		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.ws = null;
			this.ready = false;
			void this.onSocketClosed();
		};
	}

	private handle(msg: Record<string, unknown>) {
		const type = msg.type as string;
		switch (type) {
			case 'status':
				this.onStatus(
					String(msg.state),
					msg.message as string | undefined,
					msg.kind as string | undefined
				);
				break;
			case 'incident':
				this.incidentId = String(msg.incidentId);
				this.onIncidentChanged(this.incidentId);
				break;
			case 'tool':
				this.onTool(msg);
				break;
			case 'system': {
				const text = String(msg.text ?? '');
				this.addSystemItem(text);
				this.onSystemEvent(text);
				break;
			}
			case 'input.speech.started':
				this.userSpeaking = true;
				if (this.status !== 'speaking') this.status = 'listening';
				break;
			case 'input.speech.stopped':
				this.userSpeaking = false;
				break;
			case 'transcript.user.delta':
				this.partialUser = String(msg.text ?? '');
				break;
			case 'transcript.user': {
				const text = String(msg.text ?? '').trim();
				this.partialUser = '';
				this.userSpeaking = false;
				if (text) {
					this.pushItem({ speaker: 'user', text, channel: 'voice', interrupted: false });
					this.status = 'processing';
				}
				break;
			}
			case 'reply.started':
				this.partialAgent = '';
				this.status = 'speaking';
				this.clearIdleTimer();
				break;
			case 'reply.audio':
				if (typeof msg.data === 'string') this.audio.play(msg.data);
				break;
			case 'transcript.agent.delta':
				this.partialAgent =
					`${this.partialAgent}${this.partialAgent ? ' ' : ''}${String(msg.delta ?? '').trim()}`.trim();
				break;
			case 'transcript.agent': {
				const text = String(msg.text ?? '').trim();
				this.partialAgent = '';
				if (text) {
					this.pushItem({
						speaker: 'agent',
						text,
						channel: 'voice',
						interrupted: !!msg.interrupted
					});
				}
				break;
			}
			case 'reply.done':
				if (msg.status === 'interrupted') {
					// Barge-in: stop stale audio immediately.
					this.audio.flush();
					this.status = 'interrupted';
					setTimeout(() => {
						if (this.status === 'interrupted') this.status = 'listening';
					}, 900);
				} else {
					this.settleAfterPlayback();
				}
				break;
		}
	}

	private onStatus(state: string, message?: string, kind?: string) {
		switch (state) {
			case 'ready':
			case 'restored': {
				const wasReconnecting = this.status === 'reconnecting' || this.reconnectAttempt > 0;
				this.ready = true;
				this.everReady = true;
				this.connectedAt = this.connectedAt ?? Date.now();
				this.status = 'listening';
				this.reconnectAttempt = 0;
				if (state === 'restored' || wasReconnecting) {
					this.notice = 'Voice connection restored.';
					setTimeout(() => (this.notice = null), 4000);
				}
				break;
			}
			case 'reconnecting':
				this.ready = false;
				this.audio.flush();
				this.status = 'reconnecting';
				break;
			case 'busy':
				this.notice = message ?? 'AssemblyAI is busy, retrying…';
				break;
			case 'error':
				void this.fail(message ?? 'Voice session error', (kind as VoiceErrorKind) ?? 'voice');
				break;
			case 'ended':
				this.endingIntentionally = true;
				void this.cleanup('ended');
				break;
		}
	}

	private onTool(msg: Record<string, unknown>) {
		const callId = String(msg.callId);
		const state = msg.state as ToolActivity['state'];
		if (state === 'running') {
			this.inflightTools++;
			this.status = 'processing';
			this.toolActivity = [
				{ callId, name: String(msg.name), state, message: 'Recording…', at: Date.now() },
				...this.toolActivity
			].slice(0, 12);
			return;
		}
		this.inflightTools = Math.max(0, this.inflightTools - 1);
		this.toolActivity = this.toolActivity.map((a) =>
			a.callId === callId
				? { ...a, state, message: String(msg.message ?? (state === 'ok' ? 'Saved' : 'Failed')) }
				: a
		);
		this.onIncidentChanged(this.incidentId);
	}

	private settleAfterPlayback() {
		this.clearIdleTimer();
		const wait = Math.max(0, this.audio.pendingPlayback * 1000) + 150;
		this.idleTimer = setTimeout(() => {
			if (this.status === 'speaking' || this.status === 'processing') {
				this.status = this.inflightTools > 0 ? 'processing' : 'listening';
			}
		}, wait);
	}

	private clearIdleTimer() {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	/** Typed fallback for noisy rooms: still handled by the AssemblyAI agent, via the server. */
	sendText(text: string) {
		const clean = text.trim().slice(0, 1000);
		if (!clean || !this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
		this.pushItem({ speaker: 'user', text: clean, channel: 'typed', interrupted: false });
		this.audio.flush();
		this.ws.send(JSON.stringify({ type: 'text', text: clean }));
		this.status = 'processing';
	}

	async end(): Promise<void> {
		if (!this.active && this.status !== 'error') return;
		this.endingIntentionally = true;
		if (this.ws?.readyState === WebSocket.OPEN) {
			// The relay sends session.end upstream (stops billing) and replies status: ended.
			this.ws.send(JSON.stringify({ type: 'end' }));
			const ws = this.ws;
			setTimeout(() => {
				if (this.ws === ws) void this.cleanup('ended');
			}, 2500);
		} else {
			await this.cleanup('ended');
		}
	}

	/** pagehide: must be synchronous. The relay also ends the session when the socket drops. */
	endOnPageHide() {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.endingIntentionally = true;
			this.ws.send(JSON.stringify({ type: 'end' }));
		}
	}

	private async onSocketClosed() {
		if (this.endingIntentionally || this.status === 'ended' || this.status === 'error') {
			await this.cleanup(this.status === 'error' ? 'error' : 'ended');
			return;
		}
		if (!this.everReady) {
			await this.fail(
				'Could not connect to the SENTINEL voice relay. Check your connection and try again.'
			);
			return;
		}
		// Our link to SENTINEL dropped (the server ends the old session). Start a new
		// session on the same incident; its prompt is rebuilt from the database.
		this.status = 'reconnecting';
		this.audio.flush();
		while (this.reconnectAttempt < MAX_RECONNECT_ATTEMPTS && !this.endingIntentionally) {
			this.reconnectAttempt++;
			await sleep(1000 * 2 ** (this.reconnectAttempt - 1));
			if (this.endingIntentionally) return;
			try {
				const session = await this.createSession(true);
				if (!session) break;
				this.openSocket(session);
				if (await this.waitReady(10_000)) {
					this.addSystemItem(
						'Voice reconnected with a new session. The incident record carried over.'
					);
					return;
				}
			} catch (e) {
				console.warn('[voice] reconnect attempt failed', e);
			}
		}
		if (!this.endingIntentionally) {
			await this.fail(
				'Voice unavailable. Your incident data has been preserved. You can continue manually.'
			);
		}
	}

	private async waitReady(ms: number): Promise<boolean> {
		const until = Date.now() + ms;
		while (Date.now() < until) {
			if (this.ready) return true;
			if (!this.ws || this.status === 'error') return false;
			await sleep(100);
		}
		return this.ready;
	}

	private onVisibility = () => {
		if (document.visibilityState === 'visible') this.audio.resume();
	};

	toggleMute() {
		this.muted = !this.muted;
	}

	private async fail(message: string, kind: VoiceErrorKind = 'voice') {
		this.errorMessage = message;
		this.errorKind = kind;
		this.endingIntentionally = true;
		await this.cleanup('error');
	}

	private async cleanup(final: 'ended' | 'error') {
		this.ready = false;
		const ws = this.ws;
		this.ws = null;
		try {
			ws?.close();
		} catch {
			/* ignore */
		}
		await this.audio.stop();
		document.removeEventListener('visibilitychange', this.onVisibility);
		this.muted = false;
		this.clearIdleTimer();
		this.micLevel = 0;
		this.userSpeaking = false;
		this.partialUser = '';
		this.partialAgent = '';
		this.status = final;
	}

	private reset() {
		this.errorMessage = null;
		this.errorKind = null;
		this.notice = null;
		this.items = [];
		this.toolActivity = [];
		this.partialAgent = '';
		this.partialUser = '';
		this.voiceSessionId = null;
		this.connectedAt = null;
		this.reconnectAttempt = 0;
		this.endingIntentionally = false;
		this.everReady = false;
		this.inflightTools = 0;
	}

	outputLevel(): number {
		return this.audio.outputLevel();
	}

	private pushItem(item: Omit<ConversationItem, 'id' | 'at'>) {
		this.items.push({ ...item, id: `c${++this.seq}`, at: Date.now() });
	}

	private addSystemItem(text: string) {
		this.pushItem({ speaker: 'system', text, channel: 'system', interrupted: false });
	}
}

async function errorText(res: Response): Promise<string> {
	try {
		const body = await res.json();
		return body?.message ?? body?.error ?? `Request failed (${res.status})`;
	} catch {
		return `Request failed (${res.status})`;
	}
}

export type VoiceErrorKind =
	| 'mic_denied'
	| 'mic_missing'
	| 'mic_disconnected'
	| 'insecure'
	| 'unsupported'
	| 'mic_failed'
	| 'not_configured'
	| 'quota'
	| 'voice';

class VoiceError extends Error {
	constructor(
		readonly kind: VoiceErrorKind,
		message: string,
		options?: { cause?: unknown }
	) {
		super(message, options);
	}
}

// Plain memo cache, not reactive state.
// eslint-disable-next-line svelte/prefer-svelte-reactivity
const silenceCache = new Map<number, string>();
/** Base64 PCM16 silence the same length as a captured chunk. */
function silenceLike(b64: string): string {
	const bytes = Math.floor((b64.length * 3) / 4);
	let s = silenceCache.get(bytes);
	if (!s) {
		s = btoa(String.fromCharCode(...new Uint8Array(bytes)));
		silenceCache.set(bytes, s);
	}
	return s;
}

function micErrorKind(e: unknown): VoiceErrorKind {
	const name = e instanceof DOMException ? e.name : '';
	if (name === 'NotAllowedError' || name === 'SecurityError')
		return window.isSecureContext ? 'mic_denied' : 'insecure';
	if (name === 'NotFoundError' || name === 'OverconstrainedError') return 'mic_missing';
	if (!window.isSecureContext) return 'insecure';
	return 'mic_failed';
}

function micErrorMessage(e: unknown): string {
	const name = e instanceof DOMException ? e.name : '';
	if (name === 'NotAllowedError')
		return 'Microphone permission was denied. Allow microphone access and try again.';
	if (name === 'NotFoundError') return 'No microphone was found.';
	if (!window.isSecureContext) return 'The microphone needs HTTPS or localhost.';
	console.warn('[voice] audio start failed', e);
	const detail = e instanceof Error ? e.message : '';
	return `Could not start the microphone${detail ? `: ${detail}` : '.'}`;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
