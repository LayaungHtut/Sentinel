/**
 * LIVE probe of AssemblyAI Voice Agent `session.resume` (billed; never prints the key).
 *
 * SENTINEL's relay connects server-side with `Authorization: Bearer <key>`, so this
 * probe does exactly the same, with no app involved:
 *   1) open a session, wait for session.ready, note session_id
 *   2) drop the socket WITHOUT session.end (simulated network loss)
 *   3) wait N seconds, reconnect, send { type: 'session.resume', session_id }
 *   4) record the outcome (session.ready vs session.error code/message), end cleanly
 * Repeats for several delays. Output: console + .data/voice-results/resume-probe-<ts>.json
 * (suitable for attaching to a support ticket; contains no credentials).
 *
 * Usage: node --env-file=.env scripts/live-resume.mjs [--delays 1,5,15]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';

const key = process.env.ASSEMBLYAI_API_KEY?.trim();
if (!key) {
	console.error('ASSEMBLYAI_API_KEY is not configured.');
	process.exit(1);
}
const URL_WS = process.env.ASSEMBLYAI_WS_URL || 'wss://agents.assemblyai.com/v1/ws';
const di = process.argv.indexOf('--delays');
const delays = (di >= 0 ? process.argv[di + 1] : '1,5,15').split(',').map(Number);

const open = () => new WebSocket(URL_WS, { headers: { Authorization: `Bearer ${key}` } });
const next = (ws, pred, ms = 15000) =>
	new Promise((resolve, reject) => {
		const t = setTimeout(() => reject(new Error('timeout')), ms);
		const onMsg = (raw) => {
			const m = JSON.parse(String(raw));
			if (pred(m)) {
				clearTimeout(t);
				ws.off('message', onMsg);
				resolve(m);
			}
		};
		ws.on('message', onMsg);
		ws.once('close', (code, reason) => {
			clearTimeout(t);
			reject(new Error(`closed ${code} ${String(reason)}`));
		});
		ws.once('error', (e) => {
			clearTimeout(t);
			reject(e);
		});
	});

const results = [];
for (const delay of delays) {
	const r = { delaySeconds: delay, at: new Date().toISOString() };
	try {
		const ws1 = open();
		await new Promise((res, rej) => (ws1.once('open', res), ws1.once('error', rej)));
		ws1.send(
			JSON.stringify({
				type: 'session.update',
				session: { system_prompt: 'You are a connectivity probe. Say nothing unless asked.' }
			})
		);
		const ready = await next(ws1, (m) => m.type === 'session.ready' || m.type === 'session.error');
		if (ready.type !== 'session.ready')
			throw new Error(`first session: ${ready.code} ${ready.message}`);
		r.sessionId = ready.session_id;
		ws1.terminate(); // abrupt drop, no session.end
		await new Promise((res) => setTimeout(res, delay * 1000));

		const ws2 = open();
		await new Promise((res, rej) => (ws2.once('open', res), ws2.once('error', rej)));
		ws2.send(JSON.stringify({ type: 'session.resume', session_id: r.sessionId }));
		const out = await next(
			ws2,
			(m) => m.type === 'session.ready' || m.type === 'session.error'
		).catch((e) => ({ type: 'closed', message: e.message }));
		r.outcome = out.type;
		r.code = out.code ?? null;
		r.message = out.message ?? null;
		r.sameSessionId = out.type === 'session.ready' ? out.session_id === r.sessionId : null;
		if (ws2.readyState === WebSocket.OPEN) {
			ws2.send(JSON.stringify({ type: 'session.end' }));
			await next(ws2, (m) => m.type === 'session.ended', 5000).catch(() => null);
			ws2.close();
		}
	} catch (e) {
		r.outcome = 'probe_error';
		r.message = e.message;
	}
	results.push(r);
	console.log(
		`${r.outcome === 'session.ready' ? '✓' : '✗'} resume after ${delay}s → ${r.outcome}${r.code ? ` (${r.code})` : ''}${r.message ? `: ${r.message}` : ''}`
	);
}

mkdirSync('.data/voice-results', { recursive: true });
const out = `.data/voice-results/resume-probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
writeFileSync(out, JSON.stringify({ endpoint: URL_WS, results }, null, 1));
console.log(
	`\n${results.filter((r) => r.outcome === 'session.ready').length}/${results.length} resumes accepted. Written to ${out}`
);
process.exit(0);
