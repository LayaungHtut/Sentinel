/**
 * Production entry point: the SvelteKit Node handler plus the voice relay
 * WebSocket (SvelteKit has no WebSocket routes). Run `npm run build` first.
 *   PORT (default 3000), HOST (default 0.0.0.0), ORIGIN (public URL, required behind a proxy)
 */
import http from 'node:http';
import { handler } from '../build/handler.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '0.0.0.0';

const server = http.createServer(handler);
server.on('upgrade', (req, socket, head) => {
	const handled = globalThis.__sentinelRelay?.handleUpgrade(req, socket, head);
	if (!handled) socket.destroy();
});
server.keepAliveTimeout = 65_000;
server.listen(port, host, () => {
	process.stdout.write(
		JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'listening', host, port }) +
			'\n'
	);
});

let shuttingDown = false;
async function shutdown(signal) {
	if (shuttingDown) return;
	shuttingDown = true;
	process.stdout.write(
		JSON.stringify({ ts: new Date().toISOString(), level: 'info', msg: 'shutting down', signal }) +
			'\n'
	);
	// End live voice sessions cleanly (session.end stops AssemblyAI billing) and stop jobs.
	await globalThis.__sentinelShutdown?.();
	server.close(() => process.exit(0));
	setTimeout(() => process.exit(0), 10_000).unref();
}
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
