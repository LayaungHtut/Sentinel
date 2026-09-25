import WebSocket from 'ws';
import { env } from '$lib/server/env';
import type { Database } from '../db';
import { executeTool, type Actor } from '../tools/executor';
import {
	getVoiceSession,
	recordLifecycle,
	saveTranscript,
	sessionConfigFor
} from '../assemblyai/voice-sessions';
import { voiceBus, type RelayHandle } from './bus';
import { log, metrics } from '../observability';
import { MAX_SESSION_SECONDS, VOICE_AGENT_WS_URL } from '../assemblyai/token';

/**
 * Server-side voice relay: browser ⇄ SENTINEL ⇄ AssemblyAI Voice Agent API.
 *
 * The browser only streams microphone audio and plays agent audio. This
 * server holds the AssemblyAI WebSocket (API key never leaves it), executes
 * every tool call, and persists every transcript itself — so nothing a
 * browser sends can masquerade as evidence.
 *
 * Browser → server frames:  { type: 'audio', audio } | { type: 'text', text } | { type: 'end' }
 * Server → browser frames:  AssemblyAI events the UI renders (speech/transcript/reply/audio)
 *                           plus { type: 'status' | 'tool' | 'incident' | 'system' }.
 */

const RETRYABLE = new Set([
	'at_capacity',
	'concurrency_exceeded',
	'internal_error',
	'server_error'
]);
const FORWARD = new Set([
	'input.speech.started',
	'input.speech.stopped',
	'transcript.user.delta',
	'transcript.user',
	'reply.started',
	'reply.audio',
	'transcript.agent.delta',
	'transcript.agent',
	'reply.done'
]);

export interface RelayOptions {
	db: Database;
	browser: WebSocket;
	voiceSessionId: string;
	orgId: string;
	actor: Actor;
}

export class VoiceRelay implements RelayHandle {
	readonly voiceSessionId: string;
	incidentId: string | null = null;

	private db: Database;
	private browser: WebSocket;
	private orgId: string;
	private actor: Actor;
	private upstream: WebSocket | null = null;
	private providerSessionId: string | null = null;
	private ready = false;
	private ended = false;
	private lastEvent: string | null = null;
	private pending: { callId: string; ok: boolean; forAgent: unknown }[] = [];
	private inflight = 0;
	private systemQueue: string[] = [];
	private readyAt = 0;
	private lastUserTurnAt = 0;
	private awaitingFirstAudio = false;
	private configTimer: ReturnType<typeof setTimeout> | null = null;
	private capTimer: ReturnType<typeof setTimeout> | null = null;
	private chain: Promise<unknown> = Promise.resolve();
	private reconnecting = false;
	private recovering = false;

	constructor(opts: RelayOptions) {
		this.db = opts.db;
		this.browser = opts.browser;
		this.voiceSessionId = opts.voiceSessionId;
		this.orgId = opts.orgId;
		this.actor = opts.actor;
	}

	async start() {
		const session = await getVoiceSession(this.db, this.voiceSessionId);
		this.incidentId = session.incidentId;
		voiceBus.register(this);
		this.browser.on('message', (raw) => this.onBrowser(raw));
		this.browser.on('close', () => void this.end('browser disconnected'));
		this.browser.on('error', () => void this.end('browser socket error'));
		this.capTimer = setTimeout(
			() => {
				this.toBrowser({ type: 'system', text: 'Voice session reached its maximum length.' });
				void this.end('max session duration');
			},
			(MAX_SESSION_SECONDS - 5) * 1000
		);
		const { session: config } = await sessionConfigFor(this.db, this.voiceSessionId, true);
		this.toBrowser({ type: 'status', state: 'connecting' });
		await this.connectUpstream({ type: 'session.update', session: config });
	}

	// ─── Upstream (AssemblyAI) ──────────────────────────────────────────────

	private connectUpstream(first: Record<string, unknown>): Promise<void> {
		const key = env.ASSEMBLYAI_API_KEY?.trim();
		if (!key) {
			this.fail('Voice is not configured on the server.', 'not_configured');
			return Promise.resolve();
		}
		return new Promise((resolve) => {
			const ws = new WebSocket(env.ASSEMBLYAI_WS_URL || VOICE_AGENT_WS_URL, {
				headers: { Authorization: `Bearer ${key}` }
			});
			this.upstream = ws;
			ws.on('open', () => {
				ws.send(JSON.stringify(first));
				resolve();
			});
			ws.on('message', (raw) => {
				if (this.upstream !== ws) return;
				let msg: Record<string, unknown>;
				try {
					msg = JSON.parse(String(raw));
				} catch {
					return;
				}
				void this.onUpstream(msg);
			});
			ws.on('close', (code) => {
				if (this.upstream !== ws) return;
				this.upstream = null;
				this.ready = false;
				void this.onUpstreamClosed(code);
				resolve();
			});
			ws.on('error', (e) =>
				log.warn('upstream socket error', { voiceSessionId: this.voiceSessionId, err: e })
			);
		});
	}

	private sendUpstream(msg: Record<string, unknown>) {
		if (this.upstream?.readyState === WebSocket.OPEN) this.upstream.send(JSON.stringify(msg));
	}

	private async onUpstream(msg: Record<string, unknown>) {
		const type = String(msg.type);
		if (FORWARD.has(type)) this.toBrowser(msg);
		switch (type) {
			case 'session.ready': {
				const resumed = this.providerSessionId !== null && this.reconnecting;
				this.ready = true;
				this.providerSessionId = String(msg.session_id ?? '') || this.providerSessionId;
				this.readyAt = this.readyAt || Date.now();
				this.reconnecting = false;
				this.lastEvent = null;
				await recordLifecycle(this.db, this.voiceSessionId, resumed ? 'resumed' : 'ready', {
					providerSessionId: this.providerSessionId ?? undefined,
					reason: resumed ? 'Voice connection restored' : undefined
				}).catch((e) => log.error('lifecycle write failed', { err: e }));
				this.toBrowser({ type: 'status', state: resumed ? 'restored' : 'ready' });
				break;
			}
			case 'input.speech.started':
				this.lastEvent = type;
				break;
			case 'transcript.user': {
				const text = String(msg.text ?? '').trim();
				if (text) {
					this.lastUserTurnAt = Date.now();
					this.awaitingFirstAudio = true;
					this.persist(() =>
						saveTranscript(this.db, this.voiceSessionId, {
							speaker: 'user',
							text,
							channel: 'voice',
							userId: this.actor.userId,
							offsetMs: this.offset(),
							itemId: msg.item_id as string | undefined
						})
					);
				}
				break;
			}
			case 'reply.started':
				this.lastEvent = type;
				break;
			case 'reply.audio':
				if (this.awaitingFirstAudio && this.lastUserTurnAt) {
					metrics.voiceReplyLatency.observe(Date.now() - this.lastUserTurnAt);
					this.awaitingFirstAudio = false;
				}
				break;
			case 'transcript.agent': {
				const text = String(msg.text ?? '').trim();
				if (text) {
					this.persist(() =>
						saveTranscript(this.db, this.voiceSessionId, {
							speaker: 'agent',
							text,
							channel: 'voice',
							interrupted: !!msg.interrupted,
							offsetMs: this.offset()
						})
					);
				}
				break;
			}
			case 'reply.done':
				this.lastEvent = type;
				if (msg.status === 'interrupted') {
					metrics.interruptions.inc();
					// Per AssemblyAI docs: drop results for the abandoned reply.
					this.pending = [];
				}
				this.flushResults();
				this.flushSystemEvents();
				break;
			case 'tool.call':
				await this.runTool(
					String(msg.call_id),
					String(msg.name),
					(msg.arguments ?? {}) as Record<string, unknown>
				);
				break;
			case 'session.error': {
				const code = String(msg.code ?? '');
				log.warn('assemblyai session.error', {
					voiceSessionId: this.voiceSessionId,
					code,
					message: msg.message
				});
				if (
					['session_not_found', 'session_forbidden', 'session_expired'].includes(code) &&
					this.reconnecting
				) {
					// Resume rejected (observed live): the close handler starts a fresh session.
					break;
				}
				if (RETRYABLE.has(code)) {
					this.toBrowser({
						type: 'status',
						state: 'busy',
						message: 'AssemblyAI is busy — retrying…'
					});
				} else if (
					![
						'invalid_value',
						'invalid_config',
						'immutable_field',
						'invalid_format',
						'invalid_audio',
						'audio_rate_violation'
					].includes(code)
				) {
					this.fail(String(msg.message ?? 'Voice session error'), 'voice');
				}
				break;
			}
			case 'session.ended':
				await this.end('session ended by AssemblyAI');
				break;
		}
	}

	private async onUpstreamClosed(code: number) {
		// A failed resume attempt also closes its socket; the running loop handles it.
		if (this.ended || this.recovering) return;
		this.recovering = true;
		try {
			await this.recover(code);
		} finally {
			this.recovering = false;
		}
	}

	private async recover(code: number) {
		// Unexpected drop: try session.resume, then fall back to a fresh session on the same incident.
		this.reconnecting = true;
		this.toBrowser({ type: 'status', state: 'reconnecting' });
		await recordLifecycle(this.db, this.voiceSessionId, 'disconnected', {
			reason: `code ${code}`
		}).catch(() => {});
		for (let attempt = 1; attempt <= 2 && !this.ended; attempt++) {
			await new Promise((r) => setTimeout(r, 500 * attempt));
			if (this.providerSessionId) {
				await this.connectUpstream({ type: 'session.resume', session_id: this.providerSessionId });
				if (await this.waitReady(6000)) return;
			}
		}
		if (this.ended) return;
		// Fresh AssemblyAI session; SENTINEL rebuilds the context from the incident record.
		this.providerSessionId = null;
		const { session: config } = await sessionConfigFor(this.db, this.voiceSessionId, true);
		await this.connectUpstream({ type: 'session.update', session: config });
		if (await this.waitReady(10000)) {
			this.toBrowser({
				type: 'system',
				text: 'Voice reconnected with a new session. The incident record carried over.'
			});
			return;
		}
		this.fail('Voice unavailable. Your incident data is safe — continue manually.', 'voice');
	}

	private async waitReady(ms: number): Promise<boolean> {
		const until = Date.now() + ms;
		while (Date.now() < until && !this.ended) {
			if (this.ready) return true;
			if (!this.upstream) return false;
			await new Promise((r) => setTimeout(r, 100));
		}
		return this.ready;
	}

	// ─── Tools ───────────────────────────────────────────────────────────────

	private async runTool(callId: string, name: string, args: Record<string, unknown>) {
		this.inflight++;
		this.toBrowser({ type: 'tool', callId, name, state: 'running' });
		// Transcripts are persisted first so provenance can cite the utterance.
		await this.chain;
		const result = await executeTool(this.db, {
			name,
			arguments: args,
			origin: 'voice',
			orgId: this.orgId,
			actor: this.actor,
			voiceSessionId: this.voiceSessionId,
			callId
		}).catch((e) => {
			log.error('relay tool execution failed', { err: e, name });
			return {
				ok: false as const,
				tool: name,
				incidentId: this.incidentId,
				error: 'Internal error while saving. Nothing was changed.'
			};
		});
		this.inflight--;
		if (result.incidentId && result.incidentId !== this.incidentId) {
			this.incidentId = result.incidentId;
			this.toBrowser({ type: 'incident', incidentId: result.incidentId });
		}
		this.toBrowser({
			type: 'tool',
			callId,
			name,
			state: result.ok ? 'ok' : 'error',
			message: result.ok ? result.message : result.error
		});
		const forAgent = result.ok
			? { ok: true, message: result.message, guidance: result.guidance, ...(result.data ?? {}) }
			: { ok: false, error: result.error };
		this.pending.push({ callId, ok: result.ok, forAgent });
		this.flushResults();
		if (result.ok) this.scheduleConfigRefresh(name === 'create_incident' ? 0 : 1200);
	}

	/** tool.result only when reply.done is the latest event (AssemblyAI docs). */
	private flushResults() {
		if (this.lastEvent !== 'reply.done' || !this.pending.length) return;
		for (const p of this.pending) {
			this.sendUpstream({
				type: 'tool.result',
				call_id: p.callId,
				result: JSON.stringify(p.forAgent),
				is_error: !p.ok
			});
		}
		this.pending = [];
	}

	private scheduleConfigRefresh(delay: number) {
		if (this.configTimer) clearTimeout(this.configTimer);
		this.configTimer = setTimeout(async () => {
			this.configTimer = null;
			if (!this.ready || this.ended) return;
			try {
				const { session } = await sessionConfigFor(this.db, this.voiceSessionId, false);
				this.sendUpstream({ type: 'session.update', session });
			} catch (e) {
				log.warn('config refresh failed', { err: e });
			}
		}, delay);
	}

	// ─── System events & typed input ─────────────────────────────────────────

	systemEvent(text: string) {
		this.toBrowser({ type: 'system', text });
		this.systemQueue.push(text);
		this.flushSystemEvents();
	}

	private flushSystemEvents() {
		if (!this.systemQueue.length || !this.ready) return;
		const idle =
			(this.lastEvent === 'reply.done' || this.lastEvent === null) &&
			this.inflight === 0 &&
			this.pending.length === 0;
		if (!idle) return;
		const text = this.systemQueue.join(' ');
		this.systemQueue = [];
		this.sendUpstream({
			type: 'conversation.message',
			role: 'system',
			content: `SYSTEM EVENT: ${text}`
		});
		this.sendUpstream({
			type: 'reply.create',
			instructions: `SENTINEL update, already recorded (do not call a tool for it). Tell the user now, in one or two short sentences, then ask if they want to do anything about it: ${text}`
		});
		this.lastEvent = 'reply.create';
		this.scheduleConfigRefresh(300);
	}

	private onBrowser(raw: WebSocket.RawData) {
		let msg: { type?: string; audio?: string; text?: string };
		try {
			msg = JSON.parse(String(raw));
		} catch {
			return;
		}
		if (msg.type === 'audio' && typeof msg.audio === 'string') {
			// Cap frame size (~1 s of 24 kHz PCM16 as base64) to keep the relay honest.
			if (this.ready && msg.audio.length <= 70_000)
				this.sendUpstream({ type: 'input.audio', audio: msg.audio });
		} else if (msg.type === 'text' && typeof msg.text === 'string') {
			const text = msg.text.trim().slice(0, 1000);
			if (!text || !this.ready) return;
			this.persist(() =>
				saveTranscript(this.db, this.voiceSessionId, {
					speaker: 'user',
					text,
					channel: 'typed',
					userId: this.actor.userId,
					offsetMs: this.offset()
				})
			);
			// Live-verified: user-role conversation.message is not seen by the agent; instructions are.
			void this.chain.then(() => {
				this.sendUpstream({
					type: 'reply.create',
					instructions: `The user typed (instead of speaking): "${text.replace(/"/g, "'")}". Treat this exactly as the user's latest turn: record what it states with tools, then respond.`
				});
				this.lastEvent = 'reply.create';
			});
		} else if (msg.type === 'end') {
			void this.end('ended by user');
		}
	}

	// ─── Lifecycle ───────────────────────────────────────────────────────────

	private persist(fn: () => Promise<unknown>) {
		this.chain = this.chain.then(fn).catch((e) => log.error('transcript write failed', { err: e }));
	}

	private offset() {
		return this.readyAt ? Date.now() - this.readyAt : undefined;
	}

	private toBrowser(msg: Record<string, unknown>) {
		if (this.browser.readyState === WebSocket.OPEN) this.browser.send(JSON.stringify(msg));
	}

	private fail(message: string, kind: string) {
		this.toBrowser({ type: 'status', state: 'error', message, kind });
		void recordLifecycle(this.db, this.voiceSessionId, 'error', { reason: message }).catch(
			() => {}
		);
		void this.end(`error: ${message}`, true);
	}

	close(reason: string) {
		void this.end(reason);
	}

	refreshContext() {
		this.scheduleConfigRefresh(200);
	}

	async end(reason: string, alreadyRecorded = false) {
		if (this.ended) return;
		this.ended = true;
		voiceBus.unregister(this);
		if (this.configTimer) clearTimeout(this.configTimer);
		if (this.capTimer) clearTimeout(this.capTimer);
		// session.end stops AssemblyAI billing immediately (no 30 s grace window).
		this.sendUpstream({ type: 'session.end' });
		setTimeout(() => this.upstream?.close(), 1500);
		await this.chain;
		if (!alreadyRecorded) {
			await recordLifecycle(this.db, this.voiceSessionId, 'ended', { reason }).catch(() => {});
		}
		this.toBrowser({ type: 'status', state: 'ended' });
		setTimeout(() => {
			if (this.browser.readyState === WebSocket.OPEN) this.browser.close(1000, 'ended');
		}, 200);
	}
}
