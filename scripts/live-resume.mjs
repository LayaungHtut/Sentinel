/**
 * LIVE reconnect check against the real AssemblyAI Voice Agent API (billed; never prints the key).
 * 1) start a session through SENTINEL (/api/voice/session) and wait for session.ready
 * 2) drop the socket WITHOUT session.end (simulated network loss)
 * 3) mint a fresh single-use token via /api/voice/session/:id/token
 * 4) reconnect and send session.resume with the saved session_id, expect session.ready
 * 5) end cleanly with session.end → session.ended
 * Usage: npm run build && node --env-file=.env scripts/live-resume.mjs
 */
import http from 'node:http';
import { rmSync } from 'node:fs';

if (!process.env.ASSEMBLYAI_API_KEY) {
	console.error('ASSEMBLYAI_API_KEY is not configured.');
	process.exit(1);
}
process.env.DATABASE_URL = '';
process.env.PGLITE_DATA_DIR = '.data/live-resume-db';
rmSync(process.env.PGLITE_DATA_DIR, { recursive: true, force: true });
const { handler } = await import('../build/handler.js');
const server = http.createServer(handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (p, b) => {
	const r = await fetch(base + p, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(b ?? {})
	});
	return { status: r.status, body: await r.json().catch(() => null) };
};
const results = [];
const check = (name, ok, detail = '') => {
	results.push({ name, ok });
	console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const waitFor = (ws, pred, ms = 15000) =>
	new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('timeout')), ms);
		ws.addEventListener('message', (ev) => {
			const m = JSON.parse(ev.data);
			if (pred(m)) {
				clearTimeout(t);
				resolve(m);
			}
		});
		ws.addEventListener('close', (e) => {
			clearTimeout(t);
			reject(new Error(`closed ${e.code}`));
		});
	});

const start = await post('/api/voice/session', {});
check('token minted through SENTINEL', start.status === 200);
const { voiceSessionId, token, wsUrl, sessionUpdate } = start.body;
const ws1 = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
ws1.onopen = () => ws1.send(JSON.stringify({ type: 'session.update', session: sessionUpdate }));
const ready1 = await waitFor(ws1, (m) => m.type === 'session.ready');
const sessionId = ready1.session_id;
check('first session.ready', !!sessionId);

// Simulated network drop: close without session.end.
ws1.close();
await new Promise((r) => setTimeout(r, 2000));

const fresh = await post(`/api/voice/session/${voiceSessionId}/token`);
check('fresh single-use token for resume', fresh.status === 200);
const ws2 = new WebSocket(`${wsUrl}?token=${encodeURIComponent(fresh.body.token)}`);
ws2.onopen = () => ws2.send(JSON.stringify({ type: 'session.resume', session_id: sessionId }));
try {
	const ready2 = await waitFor(
		ws2,
		(m) => m.type === 'session.ready' || m.type === 'session.error'
	);
	check(
		'session.resume accepted',
		ready2.type === 'session.ready',
		ready2.type === 'session.error'
			? `${ready2.code}: ${ready2.message}`
			: `same id: ${ready2.session_id === sessionId}`
	);
	ws2.send(JSON.stringify({ type: 'session.end' }));
	const ended = await waitFor(ws2, (m) => m.type === 'session.ended');
	check('session.end → session.ended after resume', !!ended);
} catch (e) {
	check('session.resume accepted', false, e.message);
}

// Reusing a consumed token must fail (single-use).
const ws3 = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
ws3.onopen = () => ws3.send(JSON.stringify({ type: 'session.update', session: sessionUpdate }));
try {
	const r = await waitFor(
		ws3,
		(m) => m.type === 'session.ready' || m.type === 'session.error',
		8000
	);
	check(
		'consumed token is rejected (single-use)',
		r.type === 'session.error',
		r.type === 'session.error' ? r.code : 'unexpectedly accepted'
	);
	if (r.type === 'session.ready') ws3.send(JSON.stringify({ type: 'session.end' }));
} catch (e) {
	check('consumed token is rejected (single-use)', true, e.message);
}

server.close();
console.log(`\n${results.filter((r) => r.ok).length}/${results.length} checks passed`);
process.exit(0);
