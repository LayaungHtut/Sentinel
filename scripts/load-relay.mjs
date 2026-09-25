/**
 * Load + chaos test for the voice relay (no AssemblyAI usage, nothing billed).
 *
 * Serves the production build in-process with a mock Voice Agent API, then runs
 * N concurrent voice sessions. Each streams 24 kHz PCM16 "audio" at real-time
 * rate while the mock agent issues tool calls (create_incident, then add_fact
 * every few seconds). Measures session setup time, tool round trip (tool.call
 * → executed on the server → tool.result after reply.done) and errors.
 * With --chaos, upstream agent sockets are killed at random; the relay must
 * recover each session (resume is rejected, so a fresh session is opened).
 *
 * Usage: npm run build && node scripts/load-relay.mjs [--sessions 25] [--seconds 30] [--chaos]
 * Uses the embedded database by default; set LOAD_DATABASE_URL to test PostgreSQL.
 */
import http from 'node:http';
import { rmSync } from 'node:fs';
import WebSocket, { WebSocketServer } from 'ws';

const arg = (name, def) => {
	const i = process.argv.indexOf(name);
	return i >= 0 ? Number(process.argv[i + 1]) : def;
};
const SESSIONS = arg('--sessions', 25);
const SECONDS = arg('--seconds', 30);
const CHAOS = process.argv.includes('--chaos');

// ── Mock Voice Agent API ─────────────────────────────────────────────────────
const toolSent = new Map(); // call_id → sentAt
const toolRtt = [];
let upstreamConnections = 0;
let killed = 0;
const agentServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((r) => agentServer.once('listening', r));
agentServer.on('connection', (ws) => {
	upstreamConnections++;
	let n = 0;
	let timer = null;
	const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
	const turn = () => {
		n++;
		const id = `c${upstreamConnections}_${n}_${Math.random().toString(36).slice(2, 6)}`;
		send({ type: 'transcript.user', item_id: id, text: `It reads ${10 + n} degrees now.` });
		send({ type: 'reply.started', reply_id: `r_${id}` });
		toolSent.set(id, Date.now());
		send({
			type: 'tool.call',
			call_id: id,
			name: n === 1 ? 'create_incident' : 'add_fact',
			arguments:
				n === 1
					? {
							title: 'Freezer failure',
							type: 'refrigeration_failure',
							facts: [
								{
									key: 'temperature',
									value: `${10 + n}°C`,
									numeric_value: 10 + n,
									unit: 'C',
									certainty: 'exact',
									basis: 'stated',
									evidence_quote: `It reads ${10 + n} degrees now`
								}
							]
						}
					: {
							facts: [
								{
									key: 'temperature',
									value: `${10 + n}°C`,
									numeric_value: 10 + n,
									unit: 'C',
									certainty: 'exact',
									basis: 'stated',
									evidence_quote: `It reads ${10 + n} degrees now`
								}
							]
						}
		});
		send({ type: 'reply.done', reply_id: `r_${id}`, status: 'completed' });
	};
	ws.on('message', (raw) => {
		const m = JSON.parse(String(raw));
		if (m.type === 'session.update' && m.session?.system_prompt && !timer) {
			send({ type: 'session.ready', session_id: `load_${upstreamConnections}` });
			timer = setInterval(turn, 3000 + Math.random() * 1000);
			if (CHAOS && Math.random() < 0.3) {
				setTimeout(
					() => {
						killed++;
						ws.terminate();
					},
					2000 + Math.random() * SECONDS * 500
				);
			}
		}
		if (m.type === 'session.resume') {
			send({ type: 'session.error', code: 'session_not_found', message: 'Session not found' });
			ws.close(1008);
		}
		if (m.type === 'tool.result') {
			const at = toolSent.get(m.call_id);
			if (at) toolRtt.push(Date.now() - at);
		}
		if (m.type === 'session.end') {
			send({ type: 'session.ended' });
			ws.close();
		}
	});
	ws.on('close', () => clearInterval(timer));
});

// ── SENTINEL, in-process ─────────────────────────────────────────────────────
const dataDir = '.data/load-db';
rmSync(dataDir, { recursive: true, force: true });
let handler;
const server = http.createServer((req, res) => handler(req, res));
server.on('upgrade', (req, socket, head) => {
	if (!globalThis.__sentinelRelay?.handleUpgrade(req, socket, head)) socket.destroy();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
Object.assign(process.env, {
	ORIGIN: base,
	DATABASE_URL: process.env.LOAD_DATABASE_URL ?? '',
	PGLITE_DATA_DIR: dataDir,
	ASSEMBLYAI_API_KEY: 'load-test-key',
	ASSEMBLYAI_WS_URL: `ws://127.0.0.1:${agentServer.address().port}`,
	LOG_LEVEL: 'error',
	// One test user opens every session; lift the per-user limits for this run only.
	RATE_LIMIT_SCALE: '100'
});
({ handler } = await import('../build/handler.js'));

const form = async (path, fields, cookie) => {
	const res = await fetch(base + path, {
		method: 'POST',
		redirect: 'manual',
		headers: {
			origin: base,
			accept: 'application/json',
			'x-sveltekit-action': 'true',
			'content-type': 'application/x-www-form-urlencoded',
			...(cookie ? { cookie } : {})
		},
		body: new URLSearchParams(fields).toString()
	});
	const set = (res.headers.getSetCookie?.() ?? [])
		.map((c) => c.split(';')[0])
		.find((c) => c.startsWith('sentinel_session=') && c.length > 17);
	return { body: await res.json(), cookie: set };
};
const setup = await form('/setup', {
	orgName: 'Load Test Org',
	name: 'Load Admin',
	email: 'load@example.test',
	password: 'load test password 123'
});
const cookie = setup.cookie;
if (!cookie) throw new Error('setup failed');
await form(
	'/settings?/policy',
	{
		responseTimeoutMinutes: '15',
		retentionDays: '0',
		voiceMaxConcurrent: '100',
		voiceDailyMinutes: '100000'
	},
	cookie
);

// ── Clients ──────────────────────────────────────────────────────────────────
const setupMs = [];
const errors = [];
let restored = 0;
let reconnecting = 0;
const pct = (arr, p) => {
	if (!arr.length) return NaN;
	const s = [...arr].sort((a, b) => a - b);
	return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
};

async function client(i) {
	await new Promise((r) => setTimeout(r, i * 40)); // ramp up
	const t0 = Date.now();
	const res = await fetch(`${base}/api/voice/session`, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify({ consent: true })
	});
	if (!res.ok) return errors.push(`session ${res.status}: ${(await res.json()).message}`);
	const { relayPath } = await res.json();
	const ws = new WebSocket(`${base.replace('http', 'ws')}${relayPath}`, {
		headers: { cookie, origin: base }
	});
	const chunk = Buffer.alloc(2400).toString('base64'); // 50 ms of PCM16
	let pump;
	await new Promise((resolve) => {
		ws.on('message', (raw) => {
			const m = JSON.parse(String(raw));
			if (m.type === 'status') {
				if (m.state === 'ready' && !pump) {
					setupMs.push(Date.now() - t0);
					pump = setInterval(
						() =>
							ws.readyState === WebSocket.OPEN &&
							ws.send(JSON.stringify({ type: 'audio', audio: chunk })),
						50
					);
					setTimeout(() => ws.send(JSON.stringify({ type: 'end' })), SECONDS * 1000);
				}
				if (m.state === 'reconnecting') reconnecting++;
				if (m.state === 'error') errors.push(`relay error: ${m.message}`);
				if (m.state === 'ended') resolve();
			}
			if (m.type === 'system' && /reconnected/.test(m.text)) restored++;
		});
		ws.on('close', resolve);
		ws.on('error', (e) => {
			errors.push(`socket: ${e.message}`);
			resolve();
		});
	});
	clearInterval(pump);
}

const started = Date.now();
const rssBefore = process.memoryUsage().rss;
await Promise.all(Array.from({ length: SESSIONS }, (_, i) => client(i)));
const wall = (Date.now() - started) / 1000;

console.log(
	`\nVoice relay load test: ${SESSIONS} concurrent sessions × ${SECONDS}s${CHAOS ? ' with chaos' : ''}`
);
console.log(
	`  session setup      p50 ${pct(setupMs, 50)} ms · p95 ${pct(setupMs, 95)} ms (${setupMs.length}/${SESSIONS} ready)`
);
console.log(
	`  tool round trip    p50 ${pct(toolRtt, 50)} ms · p95 ${pct(toolRtt, 95)} ms · max ${Math.max(...toolRtt)} ms (${toolRtt.length} calls)`
);
if (CHAOS)
	console.log(
		`  chaos              ${killed} upstream sockets killed · ${reconnecting} reconnecting · ${restored} restored with a new session`
	);
console.log(`  upstream sessions  ${upstreamConnections}`);
console.log(
	`  errors             ${errors.length}${errors.length ? ` (${[...new Set(errors)].slice(0, 5).join(' | ')})` : ''}`
);
console.log(
	`  wall ${wall.toFixed(1)}s · rss +${((process.memoryUsage().rss - rssBefore) / 1e6).toFixed(0)} MB`
);

await globalThis.__sentinelShutdown?.();
server.close();
agentServer.close();
const ok = setupMs.length === SESSIONS && errors.length === 0 && (!CHAOS || restored >= killed);
process.exit(ok ? 0 : 1);
