/**
 * LIVE browser test: real Chromium + the production VoiceAgent client + the
 * SENTINEL voice relay + the real AssemblyAI Voice Agent API. Chromium's microphone is a WAV file (TTS of the
 * demo report, padded with silence) via --use-file-for-fake-audio-capture.
 * Billed to your key; never prints it.
 *
 * Usage: npm run build && node --env-file=.env scripts/live-browser.mjs [--shots dir]
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import WebSocket from 'ws';

if (!process.env.ASSEMBLYAI_API_KEY) {
	console.error('ASSEMBLYAI_API_KEY is not configured.');
	process.exit(1);
}
const shots = process.argv.includes('--shots')
	? process.argv[process.argv.indexOf('--shots') + 1]
	: null;
if (shots) mkdirSync(shots, { recursive: true });

// ---- build the "microphone" WAV: 4 s silence + spoken report + 60 s silence
const LINE =
	"The refrigeration unit at our Yangon branch stopped cooling about twenty minutes ago. It's showing twelve degrees and we've got frozen chicken and dairy inside.";
mkdirSync('.data/voice/tts', { recursive: true });
const tts = `.data/voice/tts/${createHash('sha1').update(LINE).digest('hex').slice(0, 16)}.wav`;
if (!existsSync(tts)) {
	const ps = `Add-Type -AssemblyName System.Speech;
$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${tts}', $f); $s.Speak([Console]::In.ReadToEnd()); $s.Dispose()`;
	execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { input: LINE });
}
const src = readFileSync(tts);
const at = src.indexOf('data', 12);
const pcm = src.subarray(at + 8, at + 8 + src.readUInt32LE(at + 4));
const body = Buffer.concat([Buffer.alloc(24000 * 2 * 4), pcm, Buffer.alloc(24000 * 2 * 60)]);
const header = Buffer.alloc(44);
header.write('RIFF', 0);
header.writeUInt32LE(36 + body.length, 4);
header.write('WAVE', 8);
header.write('fmt ', 12);
header.writeUInt32LE(16, 16);
header.writeUInt16LE(1, 20);
header.writeUInt16LE(1, 22);
header.writeUInt32LE(24000, 24);
header.writeUInt32LE(48000, 28);
header.writeUInt16LE(2, 32);
header.writeUInt16LE(16, 34);
header.write('data', 36);
header.writeUInt32LE(body.length, 40);
const micWav = resolve('.data/voice/browser-mic.wav');
writeFileSync(micWav, Buffer.concat([header, body]));

// ---- server in-process (voice relay on the same HTTP server)
process.env.DATABASE_URL = '';
process.env.PGLITE_DATA_DIR = '.data/live-browser-db';
process.env.DEMO_LOGIN_ENABLED = 'true';
process.env.ORIGIN = 'http://localhost:4999';
rmSync(process.env.PGLITE_DATA_DIR, { recursive: true, force: true });
const { handler } = await import('../build/handler.js');
const server = http.createServer(handler);
server.on('upgrade', (req, socket, head) => {
	if (!globalThis.__sentinelRelay?.handleUpgrade(req, socket, head)) socket.destroy();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const PUBLIC = 'http://localhost:4999';

const { chromium } = await import('playwright');
const browser = await chromium.launch({
	args: [
		'--use-fake-ui-for-media-stream',
		'--use-fake-device-for-media-stream',
		`--use-file-for-fake-audio-capture=${micWav}`,
		'--autoplay-policy=no-user-gesture-required'
	]
});
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
await context.grantPermissions(['microphone'], { origin: PUBLIC });
await context.route(`${PUBLIC}/**`, async (route) => {
	const req = route.request();
	const url = new URL(req.url());
	const res = await fetch(base + url.pathname + url.search, {
		method: req.method(),
		headers: req.headers(),
		body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer(),
		redirect: 'manual'
	});
	const headers = Object.fromEntries(res.headers);
	const cookies = res.headers.getSetCookie?.() ?? [];
	if (cookies.length) headers['set-cookie'] = cookies.join('\n');
	const location = res.headers.get('location');
	if (res.status >= 300 && res.status < 400 && location && req.isNavigationRequest()) {
		// Playwright does not route the follow-up of a fulfilled redirect: navigate client-side.
		delete headers.location;
		delete headers['content-length'];
		headers['content-type'] = 'text/html';
		const target = JSON.stringify(new URL(location, PUBLIC).href);
		return route.fulfill({
			status: 200,
			headers,
			body: `<script>location.replace(${target})</script>`
		});
	}
	await route.fulfill({ status: res.status, headers, body: Buffer.from(await res.arrayBuffer()) });
});
// Bridge the browser's relay WebSocket to the in-process server (which talks to AssemblyAI).
// (Playwright emits no page 'websocket' events for routed sockets, so frames are counted here.)
const relayUrls = [];
const relayFrames = [];
let bridge = null;
await context.routeWebSocket(/\/api\/voice\/relay/, async (route) => {
	const url = new URL(route.url());
	const cookie = (await context.cookies(PUBLIC)).map((c) => `${c.name}=${c.value}`).join('; ');
	const upstream = new WebSocket(`${base.replace('http', 'ws')}${url.pathname}${url.search}`, {
		headers: { cookie, origin: PUBLIC }
	});
	relayUrls.push(url.pathname);
	bridge = { upstream, route };
	const early = [];
	route.onMessage((m) =>
		upstream.readyState === WebSocket.OPEN ? upstream.send(m) : early.push(m)
	);
	upstream.on('open', () => early.splice(0).forEach((m) => upstream.send(m)));
	upstream.on('message', (d) => {
		try {
			const m = JSON.parse(String(d));
			relayFrames.push(m.type === 'status' ? `status:${m.state}` : m.type);
		} catch {
			/* ignore */
		}
		route.send(String(d));
	});
	upstream.on('close', (code) =>
		route.close({ code: code === 1005 || code === 1006 ? 1000 : code }).catch(() => {})
	);
	route.onClose(() => upstream.close());
});
const page = await context.newPage();
const browserUrls = [];
page.on('request', (r) => browserUrls.push(r.url()));
page.on('websocket', (ws) => browserUrls.push(ws.url()));
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

const results = [];
const step = async (name, fn) => {
	try {
		await fn();
		results.push([name, true]);
		console.log(`✓ ${name}`);
	} catch (e) {
		results.push([name, false]);
		console.log(`✗ ${name} — ${e.message.split('\n')[0]}`);
	}
};

await step('sign in (demo organisation) and start an incident (mic = WAV file)', async () => {
	await page.goto(`${PUBLIC}/login`);
	await page.getByRole('button', { name: 'Continue with demo' }).click();
	await page.getByText('Turn a messy spoken incident').waitFor();
	await page.goto(`${PUBLIC}/incidents/new?scenario=refrigeration`);
	await page.getByRole('button', { name: 'Start incident' }).click();
	await page.getByRole('button', { name: 'I agree, start voice' }).click();
	await page
		.getByRole('status')
		.getByText(/^(Listening|Speaking|Hearing you|Processing)$/)
		.waitFor({ timeout: 20000 });
});
await step('AssemblyAI greeting is spoken and captioned', async () => {
	await page
		.getByRole('list', { name: 'Conversation' })
		.getByText("I'm listening")
		.waitFor({ timeout: 20000 });
});
await step('real STT transcript of the spoken report appears', async () => {
	await page
		.getByRole('list', { name: 'Conversation' })
		.getByText(/Yangon/i)
		.first()
		.waitFor({ timeout: 45000 });
});
await step('agent tool call creates the incident (URL + panels update)', async () => {
	await page.waitForURL(/\/incidents\/[0-9a-f-]{36}$/, { timeout: 45000 });
	await page.getByText('Operational state').first().waitFor();
});
await step('facts are persisted with transcript provenance', async () => {
	const id = page.url().split('/').pop();
	const deadline = Date.now() + 20000;
	let view;
	while (Date.now() < deadline) {
		view = await page.evaluate(async (u) => (await fetch(u)).json(), `/api/incidents/${id}`);
		if (view.facts.some((f) => f.key === 'temperature')) break;
		await new Promise((r) => setTimeout(r, 1000));
	}
	const temp = view.facts.find((f) => f.key === 'temperature' && f.status === 'current');
	assert.ok(temp, 'temperature fact missing');
	assert.equal(temp.numericValue, 12);
	assert.equal(temp.sourceType, 'voice_transcript');
	console.log(
		`   temperature=${temp.value} quoteMatched=${temp.quoteMatched} location=${view.incident.location}`
	);
});
await step('SENTINEL asks a follow-up question by voice', async () => {
	await page
		.getByRole('list', { name: 'Conversation' })
		.getByText(/\?/)
		.last()
		.waitFor({ timeout: 30000 });
	await page.waitForTimeout(3000);
	if (shots) await page.screenshot({ path: `${shots}/live-browser.png`, fullPage: true });
});
await step(
	'link to SENTINEL drops: the client opens a new session on the same incident',
	async () => {
		const incidentUrl = page.url();
		const sessionsBefore = relayUrls.length;
		// Cut the browser's socket to SENTINEL (the server ends that AssemblyAI session).
		bridge.upstream.terminate();
		await page
			.getByText('Voice reconnected with a new session')
			.first()
			.waitFor({ timeout: 40000 });
		assert.ok(relayUrls.length > sessionsBefore, 'no new relay session opened');
		assert.equal(page.url(), incidentUrl, 'stayed on the same incident');
		await page
			.getByRole('status')
			.getByText(/^(Listening|Speaking|Hearing you|Processing)$/)
			.waitFor({ timeout: 20000 });
		if (shots)
			await page.screenshot({ path: `${shots}/live-browser-after-drop.png`, fullPage: true });
	}
);
await step('End sends session.end and the session closes cleanly', async () => {
	const end = page.getByRole('button', { name: 'End', exact: true });
	if (!(await end.count())) throw new Error('no active session to end (voice degraded earlier)');
	await end.click();
	await page.getByText('Session ended').first().waitFor({ timeout: 10000 });
	assert.ok(relayFrames.includes('status:ended'), 'no ended status from the relay');
	const id = page.url().split('/').pop();
	const view = await page.evaluate(async (u) => (await fetch(u)).json(), `/api/incidents/${id}`);
	assert.ok(view.voiceSessions.length >= 2, 'both voice sessions recorded');
});
await step('no page errors', async () => assert.deepEqual(errors, []));
await step('the browser never contacted AssemblyAI or saw the key', async () => {
	assert.ok(!browserUrls.some((u) => /assemblyai\.com/.test(u)));
	assert.ok(!browserUrls.some((u) => u.includes(process.env.ASSEMBLYAI_API_KEY)));
});

console.log(
	`\nrelay sessions: ${relayUrls.length}; frame types: ${[...new Set(relayFrames)].join(',')}`
);
console.log(`${results.filter((r) => r[1]).length}/${results.length} steps passed`);
await browser.close();
await globalThis.__sentinelShutdown?.();
server.close();
process.exit(results.every((r) => r[1]) ? 0 : 1);
