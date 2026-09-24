/**
 * LIVE browser test: real Chromium + the production VoiceAgent client + the real
 * AssemblyAI Voice Agent API. Chromium's microphone is a WAV file (TTS of the
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

// ---- server in-process
process.env.DATABASE_URL = '';
process.env.PGLITE_DATA_DIR = '.data/live-browser-db';
rmSync(process.env.PGLITE_DATA_DIR, { recursive: true, force: true });
const { handler } = await import('../build/handler.js');
const server = http.createServer(handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

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
await context.grantPermissions(['microphone'], { origin: 'http://localhost:4999' });
await context.route('http://localhost:4999/**', async (route) => {
	const req = route.request();
	const url = new URL(req.url());
	const res = await fetch(base + url.pathname + url.search, {
		method: req.method(),
		headers: req.headers(),
		body: ['GET', 'HEAD'].includes(req.method()) ? undefined : req.postDataBuffer()
	});
	await route.fulfill({
		status: res.status,
		headers: Object.fromEntries(res.headers),
		body: Buffer.from(await res.arrayBuffer())
	});
});
const page = await context.newPage();
const wsFrames = { sent: 0, received: [] };
page.on('websocket', (ws) => {
	if (!ws.url().startsWith('wss://agents.assemblyai.com')) return;
	console.log('✓ browser opened', ws.url().replace(/token=[^&]+/, 'token=<temp>'));
	ws.on('framesent', () => wsFrames.sent++);
	ws.on('framereceived', (f) => {
		try {
			wsFrames.received.push(JSON.parse(String(f.payload)).type);
		} catch {
			/* binary */
		}
	});
});
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

await step('start incident in real Chromium (mic = WAV file)', async () => {
	await page.goto('http://localhost:4999/incidents/new?scenario=refrigeration');
	await page.getByRole('button', { name: 'Start incident' }).click();
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
		view = await (await fetch(`${base}/api/incidents/${id}`)).json();
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
await step('network drop (DevTools offline 4 s): voice recovers or degrades honestly', async () => {
	const cdp = await context.newCDPSession(page);
	const net = (offline) =>
		cdp.send('Network.emulateNetworkConditions', {
			offline,
			latency: 0,
			downloadThroughput: -1,
			uploadThroughput: -1
		});
	await net(true);
	await page.waitForTimeout(4000);
	await net(false);
	// Either the socket survived, or the client reconnects (new session fallback) or degrades with data preserved.
	const outcome = await Promise.race([
		page
			.getByText('Voice reconnected with a new session')
			.waitFor({ timeout: 40000 })
			.then(() => 'reconnected (new session)'),
		page
			.getByText('Voice connection restored.')
			.waitFor({ timeout: 40000 })
			.then(() => 'resumed'),
		page
			.getByText(/Voice unavailable/)
			.first()
			.waitFor({ timeout: 40000 })
			.then(() => 'degraded (data preserved)'),
		page
			.waitForTimeout(12000)
			.then(async () =>
				(await page.getByText(/VOICE CONNECTION LOST/i).count())
					? 'still reconnecting'
					: 'socket survived'
			)
	]);
	console.log(`   network-drop outcome: ${outcome}`);
	if (shots)
		await page.screenshot({ path: `${shots}/live-browser-after-drop.png`, fullPage: true });
	assert.notEqual(outcome, 'still reconnecting');
});
await step('End sends session.end and the session closes cleanly', async () => {
	const end = page.getByRole('button', { name: 'End', exact: true });
	if (!(await end.count())) throw new Error('no active session to end (voice degraded earlier)');
	await end.click();
	await page.getByText('Session ended').waitFor({ timeout: 10000 });
	assert.ok(wsFrames.received.includes('session.ended'), 'no session.ended frame');
});
await step('no page errors', async () => assert.deepEqual(errors, []));

console.log(
	`\nframes: sent=${wsFrames.sent}, received types=${[...new Set(wsFrames.received)].join(',')}`
);
console.log(`${results.filter((r) => r[1]).length}/${results.length} steps passed`);
await browser.close();
server.close();
process.exit(0);
