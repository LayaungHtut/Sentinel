import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer } from 'ws';
import { getDb } from '../db';
import { resolveSession, SESSION_COOKIE } from '../auth';
import { getVoiceSession } from '../assemblyai/voice-sessions';
import { VoiceRelay } from './relay';
import { log } from '../observability';

/**
 * WebSocket upgrade handler for /api/voice/relay. SvelteKit has no WebSocket
 * route type, so the Node server (server/index.js), Vite dev server
 * (vite.config.ts) and the in-process test harness all forward HTTP upgrades
 * to `globalThis.__sentinelRelay.handleUpgrade`.
 */
export const RELAY_PATH = '/api/voice/relay';

declare global {
	var __sentinelRelay:
		{ handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean } | undefined;
}

function cookieValue(header: string | undefined, name: string): string | undefined {
	for (const part of (header ?? '').split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k === name) return decodeURIComponent(v.join('='));
	}
	return undefined;
}

function reject(socket: Duplex, status: number, message: string) {
	socket.write(`HTTP/1.1 ${status} ${message}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
	socket.destroy();
}

export function installRelay() {
	if (globalThis.__sentinelRelay) return;
	const wss = new WebSocketServer({ noServer: true, maxPayload: 256 * 1024 });

	globalThis.__sentinelRelay = {
		handleUpgrade(req, socket, head) {
			const url = new URL(req.url ?? '/', 'http://localhost');
			if (url.pathname !== RELAY_PATH) return false;

			// Same-origin check: browsers don't apply CORS to WebSockets, so we must.
			const origin = req.headers.origin;
			const host = req.headers['x-forwarded-host'] ?? req.headers.host;
			const allowed = (process.env.ORIGIN ?? '')
				.split(',')
				.map((s) => s.trim())
				.filter(Boolean);
			if (origin && !allowed.includes(origin)) {
				try {
					if (new URL(origin).host !== host) {
						reject(socket, 403, 'Forbidden');
						return true;
					}
				} catch {
					reject(socket, 403, 'Forbidden');
					return true;
				}
			}

			void (async () => {
				try {
					const db = await getDb();
					const auth = await resolveSession(db, cookieValue(req.headers.cookie, SESSION_COOKIE));
					if (!auth) return reject(socket, 401, 'Unauthorized');
					const voiceSessionId = url.searchParams.get('session') ?? '';
					const session = await getVoiceSession(db, voiceSessionId).catch(() => null);
					if (!session || session.orgId !== auth.orgId || session.userId !== auth.userId) {
						return reject(socket, 404, 'Not Found');
					}
					if (session.status !== 'connecting') return reject(socket, 409, 'Conflict');
					wss.handleUpgrade(req, socket, head, (ws) => {
						const relay = new VoiceRelay({
							db,
							browser: ws,
							voiceSessionId,
							orgId: auth.orgId,
							actor: { userId: auth.userId, name: auth.userName, role: auth.role }
						});
						relay.start().catch((e) => {
							log.error('relay start failed', { err: e, voiceSessionId });
							ws.close(1011, 'relay failed');
						});
					});
				} catch (e) {
					log.error('relay upgrade failed', { err: e });
					reject(socket, 500, 'Internal Server Error');
				}
			})();
			return true;
		}
	};
}
