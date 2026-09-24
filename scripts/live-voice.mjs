/**
 * LIVE voice evaluation against the real AssemblyAI Voice Agent API.
 * Uses your ASSEMBLYAI_API_KEY (billed). Never prints the key.
 *
 * For each scenario in tests/voice/*.json:
 *   - serves the production build in-process (real SENTINEL server + fresh DB),
 *   - starts a voice session via /api/voice/session (real temp token + config),
 *   - synthesises each user turn with Windows SAPI TTS to 24 kHz PCM16 and
 *     streams it in real time as microphone audio (AssemblyAI STT + turn
 *     detection + LLM + TTS + tool calling are all real),
 *   - bridges tool.call → /api/tools → tool.result exactly like the browser client,
 *   - evaluates the resulting database state against the scenario expectations.
 *
 * Usage:
 *   npm run build
 *   node --env-file=.env scripts/live-voice.mjs [scenario-id ...] [--runs N]
 * Results: .data/voice-results/<timestamp>.json (+ console summary)
 */
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

if (!process.env.ASSEMBLYAI_API_KEY) {
	console.error('ASSEMBLYAI_API_KEY is not configured (run with --env-file=.env).');
	process.exit(1);
}
const args = process.argv.slice(2);
const runsIdx = args.indexOf('--runs');
const runs = runsIdx >= 0 ? Number(args[runsIdx + 1]) : 1;
const wanted = args.filter((a, i) => !a.startsWith('--') && !(runsIdx >= 0 && i === runsIdx + 1));
const scenarios = readdirSync('tests/voice')
	.filter((f) => f.endsWith('.json'))
	.map((f) => JSON.parse(readFileSync(`tests/voice/${f}`, 'utf8')))
	.filter((s) => !s.manual && (!wanted.length || wanted.includes(s.id)));

process.env.DATABASE_URL = '';
process.env.PGLITE_DATA_DIR = '.data/live-voice-db';
rmSync(process.env.PGLITE_DATA_DIR, { recursive: true, force: true });
const { handler } = await import('../build/handler.js');
const server = http.createServer(handler);
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const post = async (path, body) => {
	const res = await fetch(base + path, {
		method: 'POST',
		headers: { 'content-type': 'application/json' },
		body: JSON.stringify(body ?? {})
	});
	return { status: res.status, body: await res.json().catch(() => null) };
};
const get = async (path) => (await fetch(base + path)).json();

// ---------------------------------------------------------------- TTS cache
mkdirSync('.data/voice/tts', { recursive: true });
function speech(text) {
	const file = `.data/voice/tts/${createHash('sha1').update(text).digest('hex').slice(0, 16)}.wav`;
	if (!existsSync(file)) {
		const ps = `Add-Type -AssemblyName System.Speech;
$f = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(24000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono);
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile('${file.replace(/'/g, "''")}', $f);
$s.Speak([Console]::In.ReadToEnd()); $s.Dispose()`;
		execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { input: text });
	}
	const buf = readFileSync(file);
	const at = buf.indexOf('data', 12);
	return buf.subarray(at + 8, at + 8 + buf.readUInt32LE(at + 4));
}

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

	const start = await post('/api/voice/session', { scenario: 'refrigeration' });
	step('authentication', start.status === 200);
	if (start.status !== 200) {
		res.errors.push(`voice session: ${start.status} ${start.body?.message}`);
		return res;
	}
	const { voiceSessionId, token, wsUrl, sessionUpdate } = start.body;
	const turnAudio = sc.turns.map((t) => speech(t.say));

	const ws = new WebSocket(`${wsUrl}?token=${encodeURIComponent(token)}`);
	const send = (o) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify(o));
	let ready = false;
	let lastEvent = null;
	let pending = [];
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
		send({ type: 'input.audio', audio: chunk.toString('base64') });
		sentAudio = true;
	}, 50);

	const speakTurn = (i) => {
		turn = i;
		log(
			`🎙 USER (streamed TTS audio, ${(turnAudio[i].length / 48000).toFixed(1)}s): ${sc.turns[i].say}`
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
		log('→ session.end');
		send({ type: 'session.end' });
		setTimeout(resolveDone, 4000);
	};
	const scheduleNext = () => {
		clearTimeout(quietTimer);
		quietTimer = setTimeout(() => {
			if (lastEvent !== 'reply.done' || inflight || pending.length || queue.length)
				return scheduleNext();
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

	const flush = () => {
		if (lastEvent !== 'reply.done' || !pending.length) return;
		for (const p of pending)
			send({
				type: 'tool.result',
				call_id: p.callId,
				result: JSON.stringify(p.forAgent),
				is_error: !p.ok
			});
		pending = [];
	};
	let cfgTimer = null;
	const refreshConfig = () => {
		clearTimeout(cfgTimer);
		cfgTimer = setTimeout(async () => {
			const { sessionUpdate: su } = await get(`/api/voice/session/${voiceSessionId}/config`);
			send({ type: 'session.update', session: su });
		}, 600);
	};

	// Dashboard-equivalent escalation tick.
	const escTick = setInterval(async () => {
		if (!incidentId || escalated) return;
		const r = await post(`/api/incidents/${incidentId}/escalation-check`);
		for (const c of r.body?.created ?? []) {
			escalated = true;
			escalationAt = Date.now();
			const text = `${c.reason}. Escalated to ${c.target}${c.simulated ? ' (demo simulation, no real message sent)' : ''}.`;
			log(`⚠ SYSTEM EVENT → agent: ${text}`);
			send({ type: 'conversation.message', role: 'system', content: `SYSTEM EVENT: ${text}` });
			send({
				type: 'reply.create',
				instructions: `Briefly tell the user this SENTINEL update in one or two short sentences, then ask if they want to do anything about it: ${text}`
			});
			lastEvent = 'reply.create';
			scheduleNext();
		}
	}, 1000);

	ws.onopen = () => send({ type: 'session.update', session: sessionUpdate });
	ws.onmessage = async (ev) => {
		const m = JSON.parse(ev.data);
		switch (m.type) {
			case 'session.ready':
				ready = true;
				step('session', true);
				log(`✓ session.ready (voice ${m.config?.output?.voice ?? '?'})`);
				await post(`/api/voice/session/${voiceSessionId}/lifecycle`, {
					event: 'ready',
					providerSessionId: m.session_id
				});
				break;
			case 'input.speech.started':
				step('speechDetected', true);
				break;
			case 'transcript.user':
				step('transcription', !!m.text);
				res.userTranscripts.push(m.text);
				log(`   STT: “${m.text}”`);
				await post(`/api/voice/session/${voiceSessionId}/transcripts`, {
					speaker: 'user',
					text: m.text,
					channel: 'voice'
				});
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
				await post(`/api/voice/session/${voiceSessionId}/transcripts`, {
					speaker: 'agent',
					text: m.text,
					channel: 'voice',
					interrupted: !!m.interrupted
				});
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
					pending = [];
					log('   reply.done status=interrupted');
				}
				flush();
				scheduleNext();
				break;
			case 'tool.call': {
				inflight++;
				const r = await post(`/api/tools/${m.name}`, {
					voiceSessionId,
					callId: m.call_id,
					arguments: m.arguments
				});
				inflight--;
				const ok = !!r.body?.ok;
				if (r.body?.incidentId) incidentId = r.body.incidentId;
				res.tools.push({
					name: m.name,
					ok,
					args: m.arguments,
					message: ok ? r.body.message : r.body?.error
				});
				step('toolCall', true);
				log(`⚙ ${m.name} ${ok ? '✓' : '✗'} ${ok ? r.body.message : r.body?.error}`);
				const forAgent = ok
					? { ok: true, message: r.body.message, guidance: r.body.guidance, ...(r.body.data ?? {}) }
					: { ok: false, error: r.body?.error };
				pending.push({ callId: m.call_id, ok, forAgent });
				flush();
				if (ok) refreshConfig();
				break;
			}
			case 'session.error':
				res.errors.push(`${m.code}: ${m.message}`);
				log(`✗ session.error ${m.code}: ${m.message}`);
				break;
			case 'session.ended':
				step('termination', true);
				log(`✓ session.ended (${m.session_duration_seconds}s)`);
				await post(`/api/voice/session/${voiceSessionId}/lifecycle`, { event: 'ended' });
				resolveDone();
				break;
		}
	};
	ws.onclose = (ev) => {
		if (!ended) {
			res.errors.push(
				`socket closed unexpectedly (code ${ev.code}${ev.reason ? `: ${ev.reason}` : ''})`
			);
			log(`✗ socket closed unexpectedly code=${ev.code} ${ev.reason ?? ''}`);
		}
		resolveDone();
	};
	scheduleNext(); // after greeting
	const hardStop = setTimeout(() => {
		res.errors.push('scenario timeout');
		finish();
	}, 240_000);
	await done;
	clearTimeout(hardStop);
	clearInterval(pump);
	clearInterval(escTick);
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
server.close();
process.exit(0);
