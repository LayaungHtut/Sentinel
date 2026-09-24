import { AudioEngine } from './audio';

/**
 * Browser client for the AssemblyAI Voice Agent API WebSocket.
 * Protocol verified against the current Events reference:
 *   client → session.update | session.resume | input.audio | tool.result |
 *            reply.create | conversation.message | session.end
 *   server → session.ready | session.updated | session.error | session.ended |
 *            input.speech.started/stopped | transcript.user(.delta) |
 *            reply.started | reply.audio | transcript.agent(.delta) | reply.done | tool.call
 *
 * Tools run on the SENTINEL server (/api/tools/:name); this class only bridges
 * tool.call → HTTP → tool.result, holding results until reply.done as the
 * docs require, and dropping them if the reply was interrupted.
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

export interface ToolResultPayload {
	ok: boolean;
	tool: string;
	incidentId: string | null;
	message?: string;
	guidance?: string;
	error?: string;
	data?: Record<string, unknown>;
}

interface StartOptions {
	incidentId?: string | null;
	scenario?: string | null;
}

interface SessionResponse {
	voiceSessionId: string;
	token: string;
	wsUrl: string;
	sessionUpdate: Record<string, unknown>;
	tier: string;
	maxSessionSeconds: number;
}

const RETRYABLE_CODES = new Set([
	'at_capacity',
	'concurrency_exceeded',
	'internal_error',
	'server_error'
]);
const RESUME_WINDOW_MS = 30_000;
const MAX_RECONNECT_ATTEMPTS = 3;

export class VoiceAgent {
	status = $state<VoiceStatus>('idle');
	errorMessage = $state<string | null>(null);
	/** Machine-readable error for tailored recovery UI. */
	errorKind = $state<VoiceErrorKind | null>(null);
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
	providerSessionId = $state<string | null>(null);
	incidentId = $state<string | null>(null);
	tier = $state<string>('intake');
	connectedAt = $state<number | null>(null);
	reconnectAttempt = $state(0);

	/** Called after every tool execution so the dashboard can refresh. */
	onIncidentChanged: (incidentId: string | null, result: ToolResultPayload | null) => void =
		() => {};

	private audio = new AudioEngine();
	private ws: WebSocket | null = null;
	private ready = false;
	private lastEvent: string | null = null;
	private pendingResults: { callId: string; payload: ToolResultPayload }[] = [];
	private inflightTools = 0;
	private postChain: Promise<unknown> = Promise.resolve();
	private systemEvents: string[] = [];
	private endingIntentionally = false;
	private resuming = false;
	private disconnectedAt = 0;
	private configRefreshTimer: ReturnType<typeof setTimeout> | null = null;
	private idleTimer: ReturnType<typeof setTimeout> | null = null;
	private sessionCapTimer: ReturnType<typeof setTimeout> | null = null;
	private readyAt = 0;
	private seq = 0;
	private wsUrl = '';
	private scenario: string | null = null;
	private resumeRejected = false;
	private restarting = false;

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
			const res = await fetch('/api/voice/session', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					incidentId: opts.incidentId ?? null,
					scenario: opts.scenario ?? null
				})
			});
			if (!res.ok) throw new Error(await errorText(res));
			const session = (await res.json()) as SessionResponse;
			this.voiceSessionId = session.voiceSessionId;
			this.tier = session.tier;
			this.wsUrl = session.wsUrl;

			if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
				throw new VoiceError(
					'unsupported',
					'This browser cannot capture audio for voice. Use a recent Chrome or Edge.'
				);
			}
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
						JSON.stringify({ type: 'input.audio', audio: this.muted ? silenceLike(b64) : b64 })
					);
				}
			};
			document.addEventListener('visibilitychange', this.onVisibility);
			this.openSocket(session.wsUrl, session.token, {
				type: 'session.update',
				session: session.sessionUpdate
			});
			// Client-side guard for the server's max session duration (no warning event exists).
			this.sessionCapTimer = setTimeout(
				() => {
					this.addSystemItem(
						'Voice session reached its maximum length. Start a new session to continue.'
					);
					void this.end();
				},
				(session.maxSessionSeconds - 5) * 1000
			);
		} catch (e) {
			await this.fail(
				e instanceof Error ? e.message : 'Could not start voice session.',
				e instanceof VoiceError
					? e.kind
					: /not configured/i.test(String(e))
						? 'not_configured'
						: 'voice'
			);
		}
	}

	private openSocket(wsUrl: string, token: string, firstMessage: Record<string, unknown>) {
		// Browser auth for the Voice Agent API: single-use temp token as a query param.
		const url = `${wsUrl}${wsUrl.includes('?') ? '&' : '?'}token=${encodeURIComponent(token)}`;
		const ws = new WebSocket(url);
		this.ws = ws;
		ws.onopen = () => ws.send(JSON.stringify(firstMessage));
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
		ws.onclose = (ev) => {
			if (this.ws !== ws) return;
			this.ws = null;
			this.ready = false;
			void this.onSocketClosed(ev.code, ev.reason);
		};
	}

	private handle(msg: Record<string, unknown>) {
		const type = msg.type as string;
		switch (type) {
			case 'session.ready': {
				this.ready = true;
				this.providerSessionId = (msg.session_id as string) ?? this.providerSessionId;
				this.readyAt = this.readyAt || Date.now();
				this.connectedAt = this.connectedAt ?? Date.now();
				const wasResuming = this.resuming;
				this.resuming = false;
				this.reconnectAttempt = 0;
				this.notice = wasResuming
					? 'Voice connection restored.'
					: this.restarting
						? 'Voice connection restored with a new session.'
						: null;
				if (this.restarting) {
					this.lastEvent = null;
					this.pendingResults = [];
				}
				this.status = 'listening';
				void this.lifecycle(wasResuming ? 'resumed' : 'ready', {
					providerSessionId: this.providerSessionId ?? undefined
				});
				if (wasResuming || this.restarting) setTimeout(() => (this.notice = null), 4000);
				break;
			}
			case 'input.speech.started':
				this.userSpeaking = true;
				this.lastEvent = type;
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
					this.persistTranscript('user', text, 'voice', false, msg.item_id as string | undefined);
					this.status = 'processing';
				}
				break;
			}
			case 'reply.started':
				this.lastEvent = type;
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
				const interrupted = !!msg.interrupted;
				this.partialAgent = '';
				if (text) {
					this.pushItem({ speaker: 'agent', text, channel: 'voice', interrupted });
					this.persistTranscript('agent', text, 'voice', interrupted);
				}
				break;
			}
			case 'reply.done':
				this.lastEvent = type;
				if (msg.status === 'interrupted') {
					// Barge-in: stop stale audio now and drop results for the abandoned reply.
					this.audio.flush();
					this.pendingResults = [];
					this.status = 'interrupted';
					setTimeout(() => {
						if (this.status === 'interrupted') this.status = 'listening';
					}, 900);
				} else {
					this.flushResultsIfIdle();
					this.settleAfterPlayback();
				}
				break;
			case 'tool.call':
				void this.runTool(
					String(msg.call_id),
					String(msg.name),
					(msg.arguments ?? {}) as Record<string, unknown>
				);
				break;
			case 'session.error':
				this.onSessionError(String(msg.code ?? ''), String(msg.message ?? 'Voice session error'));
				break;
			case 'session.ended':
				this.endingIntentionally = true;
				void this.cleanup('ended');
				break;
			default:
				break;
		}
	}

	private settleAfterPlayback() {
		this.clearIdleTimer();
		const wait = Math.max(0, this.audio.pendingPlayback * 1000) + 150;
		this.idleTimer = setTimeout(() => {
			if (this.status === 'speaking' || this.status === 'processing') {
				this.status = this.inflightTools > 0 ? 'processing' : 'listening';
			}
			this.flushSystemEvents();
		}, wait);
	}

	private clearIdleTimer() {
		if (this.idleTimer) clearTimeout(this.idleTimer);
		this.idleTimer = null;
	}

	private async runTool(callId: string, name: string, args: Record<string, unknown>) {
		this.inflightTools++;
		this.status = 'processing';
		const activity: ToolActivity = {
			callId,
			name,
			state: 'running',
			message: 'Recording…',
			at: Date.now()
		};
		this.toolActivity = [activity, ...this.toolActivity].slice(0, 12);
		let payload: ToolResultPayload;
		try {
			payload = await this.enqueue(async () => {
				const res = await fetch(`/api/tools/${encodeURIComponent(name)}`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ voiceSessionId: this.voiceSessionId, callId, arguments: args })
				});
				if (res.status === 404)
					return {
						ok: false,
						tool: name,
						incidentId: this.incidentId,
						error: `Unknown tool ${name}.`
					};
				if (!res.ok && res.status !== 422) {
					return {
						ok: false,
						tool: name,
						incidentId: this.incidentId,
						error: await errorText(res)
					};
				}
				return (await res.json()) as ToolResultPayload;
			});
		} catch {
			payload = {
				ok: false,
				tool: name,
				incidentId: this.incidentId,
				error: 'Could not reach the SENTINEL server. Nothing was saved. Tell the user.'
			};
		}
		this.inflightTools--;
		this.toolActivity = this.toolActivity.map((a) =>
			a.callId === callId
				? {
						...a,
						state: payload.ok ? 'ok' : 'error',
						message: payload.ok ? (payload.message ?? 'Saved') : (payload.error ?? 'Failed')
					}
				: a
		);
		if (payload.incidentId && payload.incidentId !== this.incidentId)
			this.incidentId = payload.incidentId;

		this.pendingResults.push({ callId, payload });
		this.flushResultsIfIdle();
		this.onIncidentChanged(this.incidentId, payload);
		this.scheduleConfigRefresh(name === 'create_incident' && payload.ok ? 0 : 1200);
	}

	/** Send tool results only when reply.done is the latest event (per AssemblyAI docs). */
	private flushResultsIfIdle() {
		if (this.lastEvent !== 'reply.done' || !this.pendingResults.length) return;
		if (this.ws?.readyState !== WebSocket.OPEN) return;
		for (const { callId, payload } of this.pendingResults) {
			const forAgent = payload.ok
				? {
						ok: true,
						message: payload.message,
						guidance: payload.guidance,
						...(payload.data ?? {})
					}
				: { ok: false, error: payload.error };
			this.ws.send(
				JSON.stringify({
					type: 'tool.result',
					call_id: callId,
					result: JSON.stringify(forAgent),
					is_error: !payload.ok
				})
			);
		}
		this.pendingResults = [];
	}

	/** Refresh the prompt's incident snapshot and tool tier after state changes. */
	private scheduleConfigRefresh(delayMs: number) {
		if (this.configRefreshTimer) clearTimeout(this.configRefreshTimer);
		this.configRefreshTimer = setTimeout(async () => {
			this.configRefreshTimer = null;
			if (!this.voiceSessionId || this.ws?.readyState !== WebSocket.OPEN) return;
			try {
				const res = await fetch(`/api/voice/session/${this.voiceSessionId}/config`);
				if (!res.ok) return;
				const { tier, sessionUpdate } = (await res.json()) as {
					tier: string;
					sessionUpdate: Record<string, unknown>;
				};
				this.tier = tier;
				this.ws?.send(JSON.stringify({ type: 'session.update', session: sessionUpdate }));
			} catch {
				/* next refresh will retry */
			}
		}, delayMs);
	}

	/** Push the latest incident record into the agent's prompt (e.g. after operator edits). */
	refreshContext() {
		if (this.ready) this.scheduleConfigRefresh(200);
	}

	/** SENTINEL-originated events (timers, simulations) the agent should relay. */
	notifySystemEvent(text: string) {
		this.addSystemItem(text);
		this.systemEvents.push(text);
		this.flushSystemEvents();
	}

	private flushSystemEvents() {
		if (!this.systemEvents.length || !this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
		const idle =
			(this.lastEvent === 'reply.done' || this.lastEvent === null) &&
			!this.userSpeaking &&
			this.inflightTools === 0 &&
			this.pendingResults.length === 0 &&
			this.audio.pendingPlayback < 0.05;
		if (!idle) return;
		const text = this.systemEvents.join(' ');
		this.systemEvents = [];
		this.ws.send(
			JSON.stringify({
				type: 'conversation.message',
				role: 'system',
				content: `SYSTEM EVENT: ${text}`
			})
		);
		this.ws.send(
			JSON.stringify({
				type: 'reply.create',
				instructions: `Briefly tell the user this SENTINEL update in one or two short sentences, then ask if they want to do anything about it: ${text}`
			})
		);
		this.lastEvent = 'reply.create';
		this.scheduleConfigRefresh(300);
	}

	/** Typed fallback for noisy rooms — still processed by the AssemblyAI agent. */
	sendText(text: string) {
		const clean = text.trim().slice(0, 1000);
		if (!clean || !this.ready || this.ws?.readyState !== WebSocket.OPEN) return;
		this.pushItem({ speaker: 'user', text: clean, channel: 'typed', interrupted: false });
		this.persistTranscript('user', clean, 'typed', false);
		// Ensure the transcript is stored before the agent can call tools that quote it.
		void this.postChain.then(() => {
			this.audio.flush();
			// Live-tested: a user-role conversation.message is not seen by the agent's
			// model, but reply.create instructions are. Carry the typed words there.
			this.ws?.send(
				JSON.stringify({
					type: 'reply.create',
					instructions: `The user typed (instead of speaking): "${clean.replace(/"/g, "'")}". Treat this exactly as the user's latest turn: record what it states with tools, then respond.`
				})
			);
			this.lastEvent = 'reply.create';
			this.status = 'processing';
		});
	}

	async end(): Promise<void> {
		if (!this.active && this.status !== 'error') return;
		this.endingIntentionally = true;
		if (this.ws?.readyState === WebSocket.OPEN) {
			// session.end stops billing immediately; the server replies session.ended and closes.
			this.ws.send(JSON.stringify({ type: 'session.end' }));
			const ws = this.ws;
			setTimeout(() => {
				if (this.ws === ws) void this.cleanup('ended');
			}, 2500);
		} else {
			await this.cleanup('ended');
		}
	}

	/** pagehide: must be synchronous — no awaits (per AssemblyAI browser guide). */
	endOnPageHide() {
		if (this.ws?.readyState === WebSocket.OPEN) {
			this.endingIntentionally = true;
			this.ws.send(JSON.stringify({ type: 'session.end' }));
		}
		if (this.voiceSessionId && this.active) {
			navigator.sendBeacon?.(
				`/api/voice/session/${this.voiceSessionId}/lifecycle`,
				new Blob([JSON.stringify({ event: 'ended', reason: 'page closed' })], {
					type: 'application/json'
				})
			);
		}
	}

	private onSessionError(code: string, message: string) {
		console.warn('[voice] session.error', code, message);
		if (
			code === 'session_not_found' ||
			code === 'session_forbidden' ||
			code === 'session_expired'
		) {
			// Live-tested: session.resume is often rejected even inside the documented
			// grace window. Fall back to a fresh session bound to the same incident.
			if (this.resuming) this.resumeRejected = true;
			return;
		}
		if (
			[
				'invalid_value',
				'invalid_config',
				'immutable_field',
				'invalid_format',
				'invalid_audio',
				'audio_rate_violation'
			].includes(code)
		) {
			// Non-fatal: session stays alive.
			return;
		}
		if (RETRYABLE_CODES.has(code)) {
			this.notice = 'AssemblyAI is busy — retrying…';
			return;
		}
		void this.fail(message || 'Voice session error');
	}

	private async onSocketClosed(code: number, reason: string) {
		if (this.endingIntentionally || this.status === 'ended' || this.status === 'error') {
			await this.cleanup('ended');
			return;
		}
		// A failed resume attempt closing its socket is handled by the running reconnect loop.
		if (this.status === 'reconnecting') return;
		// Never became ready → handshake failure (bad/expired token surfaces as 1006 in browsers).
		if (!this.providerSessionId) {
			await this.fail(
				`Could not connect to AssemblyAI (code ${code}${reason ? `: ${reason}` : ''}).`
			);
			return;
		}
		await this.reconnect();
	}

	private async reconnect() {
		this.status = 'reconnecting';
		this.audio.flush();
		this.pendingResults = [];
		if (!this.disconnectedAt) this.disconnectedAt = Date.now();
		void this.lifecycle('disconnected', {});
		while (this.reconnectAttempt < MAX_RECONNECT_ATTEMPTS) {
			this.reconnectAttempt++;
			await sleep(1000 * 2 ** (this.reconnectAttempt - 1));
			if (this.endingIntentionally) return;
			if (Date.now() - this.disconnectedAt > RESUME_WINDOW_MS - 2000) break;
			try {
				const res = await fetch(`/api/voice/session/${this.voiceSessionId}/token`, {
					method: 'POST'
				});
				if (!res.ok) throw new Error(await errorText(res));
				const { token } = (await res.json()) as { token: string };
				this.resuming = true;
				await new Promise<void>((resolve, reject) => {
					this.openSocket(this.wsUrl, token, {
						type: 'session.resume',
						session_id: this.providerSessionId
					});
					const ws = this.ws!;
					const timer = setTimeout(() => reject(new Error('resume timeout')), 8000);
					const check = setInterval(() => {
						if (this.ready) {
							clearTimeout(timer);
							clearInterval(check);
							resolve();
						} else if (this.ws !== ws || this.status === 'error') {
							clearTimeout(timer);
							clearInterval(check);
							reject(new Error('resume failed'));
						}
					}, 100);
				});
				this.disconnectedAt = 0;
				return;
			} catch (e) {
				console.warn('[voice] reconnect attempt failed', e);
				if (this.resumeRejected) break;
			}
		}
		// Resume impossible: start a new AssemblyAI session on the same incident. The
		// incident record (facts, unknowns, actions) is rebuilt into the new session's
		// prompt, so the conversation continues with full context from the database.
		if (!this.endingIntentionally && (await this.startFreshSession())) return;
		await this.fail(
			'Voice unavailable. Your incident data has been preserved — you can continue manually.'
		);
	}

	private async startFreshSession(): Promise<boolean> {
		try {
			this.resuming = false;
			this.resumeRejected = false;
			const previous = this.voiceSessionId;
			const res = await fetch('/api/voice/session', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ incidentId: this.incidentId, scenario: this.scenario })
			});
			if (!res.ok) return false;
			const session = (await res.json()) as SessionResponse;
			if (previous) {
				void fetch(`/api/voice/session/${previous}/lifecycle`, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({
						event: 'ended',
						reason: 'connection lost; replaced by a new session'
					})
				}).catch(() => null);
			}
			this.voiceSessionId = session.voiceSessionId;
			this.providerSessionId = null;
			this.tier = session.tier;
			this.restarting = true;
			await new Promise<void>((resolve, reject) => {
				this.openSocket(session.wsUrl, session.token, {
					type: 'session.update',
					session: session.sessionUpdate
				});
				const ws = this.ws!;
				const timer = setTimeout(() => reject(new Error('new session timeout')), 10000);
				const check = setInterval(() => {
					if (this.ready) {
						clearTimeout(timer);
						clearInterval(check);
						resolve();
					} else if (this.ws !== ws || this.status === 'error') {
						clearTimeout(timer);
						clearInterval(check);
						reject(new Error('new session failed'));
					}
				}, 100);
			});
			this.disconnectedAt = 0;
			this.addSystemItem('Voice reconnected with a new session. The incident record carried over.');
			return true;
		} catch (e) {
			console.warn('[voice] fresh session failed', e);
			return false;
		} finally {
			this.restarting = false;
		}
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
		if (this.voiceSessionId) void this.lifecycle('error', { reason: message });
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
		if (this.configRefreshTimer) clearTimeout(this.configRefreshTimer);
		if (this.sessionCapTimer) clearTimeout(this.sessionCapTimer);
		this.configRefreshTimer = null;
		this.sessionCapTimer = null;
		this.micLevel = 0;
		this.userSpeaking = false;
		this.partialUser = '';
		this.partialAgent = '';
		const wasActive = this.status !== 'ended' && this.status !== 'error';
		this.status = final;
		if (final === 'ended' && wasActive && this.voiceSessionId) void this.lifecycle('ended', {});
	}

	private reset() {
		this.errorMessage = null;
		this.errorKind = null;
		this.notice = null;
		this.items = [];
		this.toolActivity = [];
		this.partialAgent = '';
		this.partialUser = '';
		this.providerSessionId = null;
		this.voiceSessionId = null;
		this.connectedAt = null;
		this.reconnectAttempt = 0;
		this.endingIntentionally = false;
		this.resuming = false;
		this.disconnectedAt = 0;
		this.lastEvent = null;
		this.pendingResults = [];
		this.systemEvents = [];
		this.readyAt = 0;
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

	private persistTranscript(
		speaker: 'user' | 'agent',
		text: string,
		channel: 'voice' | 'typed',
		interrupted: boolean,
		itemId?: string
	) {
		if (!this.voiceSessionId) return;
		const id = this.voiceSessionId;
		const offsetMs = this.readyAt ? Date.now() - this.readyAt : undefined;
		void this.enqueue(() =>
			fetch(`/api/voice/session/${id}/transcripts`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ speaker, text, channel, interrupted, offsetMs, itemId })
			}).catch(() => null)
		);
	}

	/** Serialise transcript + tool requests so a tool call always sees the utterance before it. */
	private enqueue<T>(fn: () => Promise<T>): Promise<T> {
		const next = this.postChain.then(fn, fn);
		this.postChain = next.catch(() => undefined);
		return next;
	}

	private async lifecycle(event: string, detail: { providerSessionId?: string; reason?: string }) {
		if (!this.voiceSessionId) return;
		try {
			await fetch(`/api/voice/session/${this.voiceSessionId}/lifecycle`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ event, ...detail })
			});
		} catch {
			/* best effort */
		}
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
