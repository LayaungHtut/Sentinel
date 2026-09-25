/**
 * LIVE voice evaluation against the real AssemblyAI Voice Agent API.
 * Uses your ASSEMBLYAI_API_KEY (billed). Never prints the key.
 *
 * Exercises the production path end to end. For each scenario in tests/voice/*.json:
 *   - serves the production build in-process (real SENTINEL server, fresh DB,
 *     scheduler running) and signs in to the fictional demo organisation,
 *   - registers a voice session (POST /api/voice/session) and opens the
 *     SENTINEL voice relay WebSocket exactly like the browser does,
 *   - streams each user turn as 24 kHz PCM16 microphone audio in real time:
 *     a recorded WAV when the turn has `"audio": "path.wav"`, otherwise
 *     synthesised speech (Windows SAPI, or espeak-ng + sox on Linux),
 *   - the server relays to AssemblyAI, executes tools, persists transcripts and
 *     fires escalation timers; this script only speaks and listens,
 *   - evaluates the resulting database state against the scenario expectations.
 *
 * Usage:
 *   npm run build
 *   node --env-file=.env scripts/live-voice.mjs [scenario-id ...] [--runs N] [--min-pass-rate 0.8]
 * Results: .data/voice-results/<timestamp>.json (+ console summary). Exit code 1
 * when the pass rate is below --min-pass-rate (default: report only).
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import WebSocket from 'ws';

if (!process.env.ASSEMBLYAI_API_KEY) {
	console.error('ASSEMBLYAI_API_KEY is not configured (run with --env-file=.env).');
	process.exit(1);
}
const args = process.argv.slice(2);
const flag = (name) => {
	const i = args.findIndex((a) => a === name || a.startsWith(`${name}=`));
	if (i < 0) return undefined;
	return args[i].includes('=') ? args[i].split('=')[1] : args[i + 1];
};
const runs = Number(flag('--runs') ?? 1);
const minPassRate = flag('--min-pass-rate') !== undefined ? Number(flag('--min-pass-rate')) : null;
const flagValues = new Set([flag('--runs'), flag('--min-pass-rate')].filter(Boolean));
const wanted = args.filter((a) => !a.startsWith('--') && !flagValues.has(a));
const scenarios = readdirSync('tests/voice')
	.filter((f) => f.endsWith('.json'))
	.map((f) => JSON.parse(readFileSync(`tests/voice/${f}`, 'utf8')))
	.filter((s) => !s.manual && (!wanted.length || wanted.includes(s.id)));

process.env.DATABASE_URL = '';
process.env.PGLITE_DATA_DIR = '.data/live-voice-db';
process.env.DEMO_LOGIN_ENABLED = 'true';
process.env.SCHEDULER_ENABLED = 'true';
rmSync(process.env.PGLITE_DATA_DIR, { recursive: true, force: true });
// Listen first so ORIGIN (read when the handler loads) matches this server.
let handler;
const server = http.createServer((req, res) => handler(req, res));
server.on('upgrade', (req, socket, head) => {
	if (!globalThis.__sentinelRelay?.handleUpgrade(req, socket, head)) socket.destroy();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
process.env.ORIGIN = base;
({ handler } = await import('../build/handler.js'));

// Sign in to the fictional demo organisation (opt-in demo login).
const login = await fetch(`${base}/login?/demo`, {
	method: 'POST',
	headers: { origin: base, 'content-type': 'application/x-www-form-urlencoded' },
	body: '',
	redirect: 'manual'
});
const cookie = (login.headers.getSetCookie?.() ?? [])
	.map((c) => c.split(';')[0])
	.find((c) => c.startsWith('sentinel_session='));
if (!cookie) {
	console.error(`Demo sign-in failed (${login.status}).`);
	process.exit(1);
}
const post = async (path, body) => {
	const res = await fetch(base + path, {
		method: 'POST',
		headers: { 'content-type': 'application/json', cookie },
		body: JSON.stringify(body ?? {})
	});
	return { status: res.status, body: await res.json().catch(() => null) };
};
const get = async (path) => (await fetch(base + path, { headers: { cookie } })).json();

// ---------------------------------------------------------------- audio
mkdirSync('.data/voice/tts', { recursive: true });
/** PCM16 samples from a WAV file; must be 24 kHz mono 16-bit. */
function wavPcm(file) {
	const buf = readFileSync(file);
	const fmt = buf.indexOf('fmt ', 12);
	const channels = buf.readUInt16LE(fmt + 10);
	const rate = buf.readUInt32LE(fmt + 12);
	const bits = buf.readUInt16LE(fmt + 22);
	if (channels !== 1 || rate !== 24000 || bits !== 16) {
		throw new Error(
			`${file}: need 24 kHz mono 16-bit PCM (got ${rate} Hz, ${channels} ch, ${bits}-bit)`
		);
	}
	const at = buf.indexOf('data', 12);
	return buf.subarray(at + 8, at + 8 + buf.readUInt32LE(at + 4));
}
function speech(text) {
	const file = `.data/voice/tts/${createHash('sha1').update(text).digest('hex').slice(0, 16)}.wav`;
	if (!existsSync(file)) {
		if (process.platform === 'win32') {
			const ps = `Add-Type -AssemblyName System.Speech;
$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${file.replace(/'/g, "''")}', $f);
$s.Speak([Console]::In.ReadToEnd()); $s.Dispose()`;
			execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { input: text });
		} else {
			// Linux/macOS: espeak-ng, then sox resamples to 24 kHz mono PCM16.
			const raw = `${file}.raw.wav`;
			execFileSync('espeak-ng', ['-w', raw, '--stdin'], { input: text });
			execFileSync('sox', [raw, '-r', '24000', '-c', '1', '-b', '16', file]);
			rmSync(raw, { force: true });
		}
	}
	return wavPcm(file);
}
const turnPcm = (turn) => (turn.audio ? wavPcm(turn.audio) : speech(turn.say));

// ---------------------------------------------------------------- one run
async function runScenario(sc) {
	const t0 = Date.now();
	const ts = () => `+${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(7);
	const events = [];
	const log = (line) => {
		events.push(`${ts()} ${line}`);
		console.log(`${ts()} ${line}`);
	};
	const res = {
		scenario: sc.id,
		name: sc.name,
		steps: {},
		agentLines: [],
		userTranscripts: [],
		tools: [],
		errors: [],
		replies: [],
		checks: [],
		interruptedReplies: 0
	};
	const step = (k, ok) => (res.steps[k] = res.steps[k] === false ? false : ok);

	const start = await post('/api/voice/session', { scenario: 'refrigeration', consent: true });
	step('authentication', start.status === 200);
	if (start.status !== 200) {
		res.errors.push(`voice session: ${start.status} ${start.body?.message}`);
		return res;
	}
	const { relayPath } = start.body;
	const turnAudio = sc.turns.map(turnPcm);

	const ws = new WebSocket(`${base.replace('http', 'ws')}${relayPath}`, {
		headers: { cookie, origin: base }
	});
	const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
	let ready = false;
	let lastEvent = null;
	let inflight = 0;
	let turn = -1;
	let queue = Buffer.alloc(0);
	let incidentId = null;
	let reply = null; // current reply metrics
	let awaitingBargeIn = false;
	let armedAt = 0;
	let quietTimer = null;
	let escalated = false;
	let escalationAt = 0;
	let ended = false;
	let resolveDone;
	const done = new Promise((r) => (resolveDone = r));

	const CHUNK = 2400;
	const silence = Buffer.alloc(CHUNK);
	let sentAudio = false;
	const pump = setInterval(() => {
		if (!ready) return;
		let chunk = silence;
		if (queue.length) {
			chunk = queue.subarray(0, CHUNK);
			queue = queue.subarray(CHUNK);
			if (chunk.length < CHUNK) chunk = Buffer.concat([chunk, Buffer.alloc(CHUNK - chunk.length)]);
		}
		send({ type: 'audio', audio: chunk.toString('base64') });
		sentAudio = true;
	}, 50);

	const speakTurn = (i) => {
		turn = i;
		log(
			`🎙 USER (${sc.turns[i].audio ? 'recorded' : 'synthesised'} audio, ${(turnAudio[i].length / 48000).toFixed(1)}s): ${sc.turns[i].say}`
		);
		queue = turnAudio[i];
		lastEvent = 'user.audio';
		// Arm barge-in for the reply to THIS turn: interrupt it ~2 s into its audio.
		if (sc.turns[i + 1]?.bargeIn) {
			awaitingBargeIn = true;
			armedAt = Date.now() + (turnAudio[i].length / 48000) * 1000;
		}
	};
	const finish = () => {
		if (ended) return;
		ended = true;
		log('→ end');
		send({ type: 'end' });
		setTimeout(resolveDone, 5000);
	};
	const scheduleNext = () => {
		clearTimeout(quietTimer);
		quietTimer = setTimeout(() => {
			if (lastEvent !== 'reply.done' || inflight || queue.length) return scheduleNext();
			const next = turn + 1;
			if (next < sc.turns.length) {
				if (sc.turns[next].bargeIn) {
					// SENTINEL finished before we could interrupt: record it and speak normally.
					awaitingBargeIn = false;
					log('… reply ended before barge-in point; speaking normally');
				}
				return speakTurn(next);
			}
			if (
				sc.waitForEscalationSeconds &&
				!escalated &&
				Date.now() - t0 < (sc.waitForEscalationSeconds + 90) * 1000
			) {
				return scheduleNext();
			}
			if (escalated && Date.now() - escalationAt < 12000) return scheduleNext();
			finish();
		}, 3000);
	};

	ws.on('message', (raw) => {
		const m = JSON.parse(String(raw));
		switch (m.type) {
			case 'status':
				if (m.state === 'ready' || m.state === 'restored') {
					ready = true;
					step('session', true);
					log(`✓ relay ready (${m.state})`);
				} else if (m.state === 'error') {
					res.errors.push(`relay error: ${m.message}`);
					log(`✗ relay error: ${m.message}`);
				} else if (m.state === 'busy' || m.state === 'reconnecting') {
					res.errors.push(`relay ${m.state}`);
					log(`⚠ relay ${m.state}`);
				} else if (m.state === 'ended') {
					step('termination', true);
					log('✓ session ended');
					resolveDone();
				}
				break;
			case 'incident':
				incidentId = m.incidentId;
				break;
			case 'system':
				// Escalations and other SENTINEL events, delivered by the server's scheduler.
				if (/escalat/i.test(m.text)) {
					escalated = true;
					escalationAt = Date.now();
				}
				log(`⚠ SYSTEM EVENT → agent: ${m.text}`);
				scheduleNext();
				break;
			case 'tool':
				if (m.state === 'running') {
					inflight++;
					break;
				}
				inflight = Math.max(0, inflight - 1);
				res.tools.push({ name: m.name, ok: m.state === 'ok', message: m.message });
				step('toolCall', true);
				log(`⚙ ${m.name} ${m.state === 'ok' ? '✓' : '✗'} ${m.message}`);
				break;
			case 'input.speech.started':
				step('speechDetected', true);
				break;
			case 'transcript.user':
				step('transcription', !!m.text);
				res.userTranscripts.push(m.text);
				log(`   STT: “${m.text}”`);
				break;
			case 'reply.started':
				lastEvent = m.type;
				reply = { id: m.reply_id, startedAt: Date.now(), firstAudioAt: 0, audioBytes: 0, words: 0 };
				break;
			case 'reply.audio':
				if (reply) {
					if (!reply.firstAudioAt) reply.firstAudioAt = Date.now();
					reply.audioBytes += Buffer.from(m.data, 'base64').length;
				}
				step('agentSpeech', true);
				if (
					awaitingBargeIn &&
					!queue.length &&
					reply &&
					reply.startedAt > armedAt &&
					reply.words >= 3 &&
					Date.now() - reply.firstAudioAt > 2000
				) {
					awaitingBargeIn = false;
					log('✋ BARGE-IN: user starts talking over SENTINEL');
					speakTurn(turn + 1);
				}
				break;
			case 'transcript.agent.delta':
				if (reply) reply.words++;
				break;
			case 'transcript.agent':
				res.agentLines.push({ text: m.text, interrupted: !!m.interrupted, at: Date.now() - t0 });
				log(`🔊 SENTINEL${m.interrupted ? ' [INTERRUPTED]' : ''}: ${m.text}`);
				break;
			case 'reply.done':
				lastEvent = m.type;
				if (reply) {
					res.replies.push({
						status: m.status,
						audioSec: +(reply.audioBytes / 48000).toFixed(2),
						streamMs: reply.firstAudioAt ? Date.now() - reply.firstAudioAt : 0
					});
				}
				if (m.status === 'interrupted') {
					res.interruptedReplies++;
					log('   reply.done status=interrupted');
				}
				scheduleNext();
				break;
		}
	});
	ws.on('close', (code) => {
		if (!ended) {
			res.errors.push(`socket closed unexpectedly (code ${code})`);
			log(`✗ socket closed unexpectedly code=${code}`);
		}
		resolveDone();
	});
	ws.on('error', (e) => {
		res.errors.push(`socket error: ${e.message}`);
		resolveDone();
	});
	scheduleNext(); // after greeting
	const hardStop = setTimeout(() => {
		res.errors.push('scenario timeout');
		finish();
	}, 240_000);
	await done;
	clearTimeout(hardStop);
	clearInterval(pump);
	clearTimeout(quietTimer);
	step('microphoneAudio', sentAudio);
	res.durationSec = Math.round((Date.now() - t0) / 1000);
	res.events = events;

	// ------------------------------------------------------------ evaluate
	const check = (name, ok, detail = '') => res.checks.push({ name, ok: !!ok, detail });
	const e = sc.expect ?? {};
	if (!incidentId) {
		check('incident created', false);
		return res;
	}
	const view = await get(`/api/incidents/${incidentId}`);
	res.incident = {
		code: view.incident.code,
		type: view.incident.type,
		status: view.incident.status,
		severity: view.severityAssessment.level,
		location: view.incident.location,
		facts: view.facts.map((f) => ({
			key: f.key,
			value: f.value,
			num: f.numericValue,
			status: f.status,
			certainty: f.certainty,
			verification: f.verification,
			basis: f.basis,
			quoteMatched: f.quoteMatched
		})),
		actions: view.actions.map((a) => ({
			seq: a.seq,
			title: a.title,
			status: a.status,
			contact: a.contactName
		})),
		escalations: view.escalations.map((x) => ({
			target: x.targetName,
			status: x.status,
			simulated: x.simulated
		})),
		unknowns: view.checklist.filter((c) => c.state === 'open').map((c) => c.key)
	};
	step('persistence', view.facts.length > 0 || view.actions.length > 0);
	const cls = (f) =>
		f.verification === 'disputed'
			? 'disputed'
			: f.verification === 'confirmed'
				? 'confirmed'
				: f.basis === 'inferred'
					? 'inferred'
					: f.certainty === 'approximate'
						? 'approximate'
						: f.needsVerification
							? 'unverified'
							: 'reported';
	const cur = view.facts.filter((f) => f.status === 'current');
	const findFact = (keys) => cur.find((f) => keys.includes(f.key));
	check('incident created', true, view.incident.code);
	if (e.incidentType)
		check(`type = ${e.incidentType}`, view.incident.type === e.incidentType, view.incident.type);
	if (e.location)
		check(
			`location ~ ${e.location}`,
			(view.incident.location ?? '').toLowerCase().includes(e.location),
			view.incident.location
		);
	for (const fx of e.facts ?? []) {
		const f = findFact([fx.key]);
		let ok = !!f;
		let detail = f ? `${f.value} [${cls(f)}]` : 'missing';
		if (f && fx.numeric !== undefined) ok &&= f.numericValue === fx.numeric;
		if (f && fx.classIn) ok &&= fx.classIn.includes(cls(f));
		if (f && fx.forbidClass) ok &&= !fx.forbidClass.includes(cls(f));
		if (f && fx.valueIncludes)
			ok &&= fx.valueIncludes.every((v) => f.value.toLowerCase().includes(v));
		if (f && fx.valueIncludesAny)
			ok &&= fx.valueIncludesAny.some((v) => f.value.toLowerCase().includes(v));
		if (f && fx.quoteTraced) ok &&= f.quoteMatched === true;
		check(`fact ${fx.key}`, ok, detail);
	}
	for (const fx of e.factsAny ?? []) {
		const f = view.facts.find(
			(x) =>
				fx.keys.includes(x.key) &&
				fx.valueIncludesAny.some((v) => x.value.toLowerCase().includes(v))
		);
		check(
			`fact any of ${fx.keys.join('/')} ~ ${fx.valueIncludesAny.join('|')}`,
			!!f,
			f ? `${f.key}=${f.value}` : 'missing'
		);
	}
	for (const s of e.superseded ?? []) {
		const f = view.facts.find(
			(x) => x.key === s.key && x.status === 'superseded' && x.numericValue === s.numeric
		);
		check(`superseded ${s.key}=${s.numeric}`, !!f);
	}
	for (const a of [...(e.actions ?? []), ...(e.actionsAny ?? [])]) {
		const re = new RegExp(a.titleMatches, 'i');
		const hit = view.actions.find(
			(x) => re.test(x.title) && (!a.statusIn || a.statusIn.includes(x.status))
		);
		check(
			`action /${a.titleMatches}/ ${a.statusIn?.join('|') ?? ''}`,
			!!hit,
			view.actions.map((x) => `${x.title}:${x.status}`).join('; ')
		);
	}
	if (e.severityIn)
		check(
			`severity ∈ ${e.severityIn}`,
			e.severityIn.includes(view.severityAssessment.level),
			view.severityAssessment.level
		);
	if (e.reportGenerated) check('report generated', !!view.latestReport);
	if (e.interrupted)
		check('reply interrupted by barge-in', res.interruptedReplies > 0, `${res.interruptedReplies}`);
	if (e.unknownsIncludeAny)
		check(
			'unknowns tracked',
			e.unknownsIncludeAny.some((k) => res.incident.unknowns.includes(k)),
			res.incident.unknowns.join(',')
		);
	if (e.agentAsksQuestion)
		check(
			'agent asks a question',
			res.agentLines.some((l) => l.text.includes('?'))
		);
	if (e.escalation) {
		const x = view.escalations.find((y) => y.targetName === e.escalation.target);
		check(`escalation → ${e.escalation.target}`, !!x && x.simulated === e.escalation.simulated);
	}
	if (e.agentMentionsAfterEscalation) {
		const after = res.agentLines
			.filter((l) => l.at > escalationAt - t0)
			.map((l) => l.text.toLowerCase())
			.join(' ');
		check(
			'agent announces escalation',
			escalationAt > 0 && e.agentMentionsAfterEscalation.every((w) => after.includes(w)),
			after.slice(0, 160)
		);
	}
	if (e.forbiddenAgentPhrases) {
		const all = res.agentLines.map((l) => l.text.toLowerCase()).join(' ');
		const hits = e.forbiddenAgentPhrases.filter((p) => all.includes(p));
		check('no forbidden claims', hits.length === 0, hits.join(', '));
	}
	check(
		'no tool errors',
		res.tools.every((t) => t.ok),
		res.tools
			.filter((t) => !t.ok)
			.map((t) => `${t.name}: ${t.message}`)
			.join(' | ')
	);
	check('no session errors', res.errors.length === 0, res.errors.join(' | '));
	return res;
}

const all = [];
mkdirSync('.data/voice-results', { recursive: true });
const out = `.data/voice-results/${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
for (let r = 1; r <= runs; r++) {
	for (const sc of scenarios) {
		console.log(`\n════════ ${sc.id} (run ${r}/${runs}) ════════`);
		const result = await runScenario(sc);
		result.run = r;
		all.push(result);
		const failed = result.checks.filter((c) => !c.ok);
		console.log(
			`── ${sc.id}: ${failed.length ? 'FAIL' : 'PASS'} (${result.checks.length - failed.length}/${result.checks.length} checks)`
		);
		for (const c of failed) console.log(`   ✗ ${c.name} — ${c.detail}`);
		writeFileSync(out, JSON.stringify(all, null, 1)); // incremental: survives interruption
	}
}
writeFileSync(out, JSON.stringify(all, null, 1));
console.log(`\nResults written to ${out}`);
for (const r of all)
	console.log(
		`${r.checks.every((c) => c.ok) ? 'PASS' : 'FAIL'}  ${r.scenario} run ${r.run}  (${r.durationSec}s, tools: ${r.tools.map((t) => t.name + (t.ok ? '' : '✗')).join(',')})`
	);
const passed = all.filter((r) => r.checks.length && r.checks.every((c) => c.ok)).length;
const rate = all.length ? passed / all.length : 0;
console.log(`\nPass rate: ${passed}/${all.length} (${Math.round(rate * 100)}%)`);
await globalThis.__sentinelShutdown?.();
server.close();
if (minPassRate !== null && rate < minPassRate) {
	console.error(`Below the required pass rate of ${Math.round(minPassRate * 100)}%.`);
	process.exit(1);
}
process.exit(0);
