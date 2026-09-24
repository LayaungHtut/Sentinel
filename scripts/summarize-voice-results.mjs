/**
 * Summarise a live-voice results file into markdown (no manual transcription).
 * Usage: node scripts/summarize-voice-results.mjs .data/voice-results/<file>.json
 */
import { readFileSync } from 'node:fs';

const file = process.argv[2];
const results = JSON.parse(readFileSync(file, 'utf8'));
const pass = (r) => r.checks.length > 0 && r.checks.every((c) => c.ok);

const byScenario = new Map();
for (const r of results) {
	const list = byScenario.get(r.scenario) ?? [];
	list.push(r);
	byScenario.set(r.scenario, list);
}

console.log(
	'| Scenario | Runs | Passed | Checks passed | Tool calls (all runs) | Interrupted replies | Failures |'
);
console.log('| --- | --- | --- | --- | --- | --- | --- |');
for (const [id, runs] of byScenario) {
	const passed = runs.filter(pass).length;
	const checks = runs.reduce((n, r) => n + r.checks.filter((c) => c.ok).length, 0);
	const total = runs.reduce((n, r) => n + r.checks.length, 0);
	const tools = runs.reduce((n, r) => n + r.tools.length, 0);
	const toolErr = runs.reduce((n, r) => n + r.tools.filter((t) => !t.ok).length, 0);
	const intr = runs.reduce((n, r) => n + r.interruptedReplies, 0);
	const fails = [
		...new Set(
			runs.flatMap((r) =>
				r.checks
					.filter((c) => !c.ok)
					.map((c) => `${c.name}${c.detail ? ` (${c.detail.slice(0, 80)})` : ''}`)
			)
		)
	];
	console.log(
		`| ${id} | ${runs.length} | ${passed}/${runs.length} | ${checks}/${total} | ${tools} (${toolErr} failed) | ${intr} | ${fails.join('; ') || '—'} |`
	);
}

const all = results.length;
const ok = results.filter(pass).length;
const steps = [
	'authentication',
	'session',
	'microphoneAudio',
	'speechDetected',
	'transcription',
	'agentSpeech',
	'toolCall',
	'persistence',
	'termination'
];
console.log(`\nTotal: ${ok}/${all} scenario runs passed.\n`);
console.log('| Pipeline stage | Runs where it worked |');
console.log('| --- | --- |');
for (const s of steps) console.log(`| ${s} | ${results.filter((r) => r.steps[s]).length}/${all} |`);
const replies = results.flatMap((r) => r.replies);
console.log(
	`\nAgent replies: ${replies.length} (${replies.filter((x) => x.status === 'interrupted').length} interrupted). Total session time: ${results.reduce((n, r) => n + (r.durationSec ?? 0), 0)} s.`
);
const errs = results.flatMap((r) => r.errors);
console.log(`Session-level errors: ${errs.length ? errs.join(' | ') : 'none'}`);
