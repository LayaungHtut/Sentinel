/**
 * End-to-end test against the production build, served in-process.
 *
 * Why in-process: some sandboxed environments block loopback connections
 * between processes. Serving build/handler.js inside this Node process (with
 * the voice relay on the same HTTP server) and proxying the browser's requests
 * through Playwright's routing works everywhere.
 *
 * Covered: first-run setup, sign-in, roles, tenancy isolation, the tool
 * pipeline, a REAL outbound notification (generic webhook to an in-process
 * receiver, HMAC-verified) with its one-time acknowledgement link, the sensor
 * API, photo evidence, the audit-chain verifier, export, reports and demo reset.
 * With --voice-mock, the production browser client talks to the SENTINEL relay,
 * which talks to an in-process stand-in for the AssemblyAI Voice Agent API.
 *
 * Usage: npm run build && node scripts/e2e-inprocess.mjs [--voice-mock] [--shots dir]
 */
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { rmSync, mkdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import WebSocket, { WebSocketServer } from 'ws';

const shotsDir = process.argv.includes('--shots')
	? process.argv[process.argv.indexOf('--shots') + 1]
	: null;
const voiceMock = process.argv.includes('--voice-mock');
const PUBLIC = 'http://localhost:4999'; // the origin the browser sees
const MOCK_KEY = 'e2e-mock-key';
const HOOK_SECRET = 'e2e-webhook-secret';
const METRICS_TOKEN = 'e2e-metrics-token';

// ── In-process receivers: a notification webhook and a mock Voice Agent API ──
const hooks = [];
const hookServer = http.createServer((req, res) => {
	let body = '';
	req.on('data', (c) => (body += c));
	req.on('end', () => {
		hooks.push({ headers: req.headers, body });
		res.writeHead(204).end();
	});
});
await new Promise((r) => hookServer.listen(0, '127.0.0.1', r));

const agent = { received: [], sockets: [], auth: [], current: null, connections: 0 };
const agentServer = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((r) => agentServer.once('listening', r));
agentServer.on('connection', (ws, req) => {
	agent.auth.push(req.headers.authorization);
	agent.current = ws;
	let ready = false;
	ws.on('message', (raw) => {
		const msg = JSON.parse(String(raw));
		agent.received.push(msg);
		if (msg.type === 'session.update' && !ready) {
			ready = true;
			agent.connections++;
			ws.send(
				JSON.stringify({ type: 'session.ready', session_id: `sess_e2e_${agent.connections}` })
			);
		}
		if (msg.type === 'session.resume') {
			// Mirrors the live service: resume rejected even inside the grace window.
			ws.send(
				JSON.stringify({
					type: 'session.error',
					code: 'session_not_found',
					message: 'Session not found or grace window has expired'
				})
			);
			ws.close(1008, 'session_not_found');
		}
		if (msg.type === 'session.end') {
			ws.send(JSON.stringify({ type: 'session.ended', session_duration_seconds: 12.3 }));
			ws.close();
		}
	});
});

const dataDir = '.data/e2e';
rmSync(dataDir, { recursive: true, force: true });
Object.assign(process.env, {
	PGLITE_DATA_DIR: dataDir,
	DATABASE_URL: '',
	ORIGIN: PUBLIC,
	PUBLIC_BASE_URL: PUBLIC,
	DEMO_LOGIN_ENABLED: 'true',
	DEMO_RESET_ENABLED: 'true',
	SCHEDULER_ENABLED: 'true',
	METRICS_TOKEN,
	NOTIFY_WEBHOOK_URL: `http://127.0.0.1:${hookServer.address().port}/hook`,
	NOTIFY_WEBHOOK_SECRET: HOOK_SECRET,
	ASSEMBLYAI_API_KEY: voiceMock ? MOCK_KEY : (process.env.E2E_ASSEMBLYAI_API_KEY ?? ''),
	ASSEMBLYAI_WS_URL: `ws://127.0.0.1:${agentServer.address().port}`,
	LOG_LEVEL: 'warn'
});

const { handler } = await import('../build/handler.js');
const server = http.createServer(handler);
server.on('upgrade', (req, socket, head) => {
	if (!globalThis.__sentinelRelay?.handleUpgrade(req, socket, head)) socket.destroy();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

// ── HTTP helpers ─────────────────────────────────────────────────────────────
const api = async (path, { cookie, headers, ...init } = {}) => {
	const res = await fetch(base + path, {
		redirect: 'manual',
		...init,
		headers: {
			'content-type': 'application/json',
			...(cookie ? { cookie } : {}),
			...(headers ?? {})
		}
	});
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = text;
	}
	return { status: res.status, body, headers: res.headers };
};
const sessionCookie = (res) =>
	(res.headers.getSetCookie?.() ?? [])
		.map((c) => c.split(';')[0])
		.find((c) => c.startsWith('sentinel_session=') && c.length > 'sentinel_session='.length);
/** Submit a SvelteKit form action the way use:enhance does (JSON result). */
const action = async (path, fields, cookie) => {
	const res = await fetch(base + path, {
		method: 'POST',
		redirect: 'manual',
		headers: {
			origin: PUBLIC,
			accept: 'application/json',
			'x-sveltekit-action': 'true',
			'content-type': 'application/x-www-form-urlencoded',
			...(cookie ? { cookie } : {})
		},
		body: new URLSearchParams(fields).toString()
	});
	const text = await res.text();
	let body;
	try {
		body = JSON.parse(text);
	} catch {
		body = { raw: text };
	}
	return { status: res.status, body, text, cookie: sessionCookie(res) };
};
/** Flat devalue payload of a successful action → plain object (strings/booleans only). */
const actionData = (r) => {
	const arr = JSON.parse(r.body.data);
	return Object.fromEntries(Object.entries(arr[0]).map(([k, i]) => [k, arr[i]]));
};
const tool = (cookie, name, args, incidentId) =>
	api(`/api/tools/${name}`, {
		method: 'POST',
		cookie,
		body: JSON.stringify({ incidentId, arguments: args })
	});
const until = async (fn, what, timeout = 10_000) => {
	const t0 = Date.now();
	while (Date.now() - t0 < timeout) {
		const v = await fn();
		if (v) return v;
		await new Promise((r) => setTimeout(r, 50));
	}
	throw new Error(`timed out waiting for ${what}`);
};

let failures = 0;
const step = async (name, fn) => {
	try {
		await fn();
		console.log(`  ✓ ${name}`);
	} catch (e) {
		failures++;
		console.log(`  ✗ ${name}\n    ${e.message}`);
	}
};

console.log(`SENTINEL e2e (in-process) at ${base}`);
const ADMIN = { email: 'ana@northwind.example', password: 'correct horse battery staple' };
let admin; // real organisation administrator
let demo; // demo organisation (fictional, simulated outreach)
let incidentId;
let incidentCode;

await step('liveness, readiness and token-protected metrics', async () => {
	assert.deepEqual((await api('/api/health')).body, { ok: true });
	assert.equal((await api('/api/ready')).status, 200);
	assert.equal((await api('/api/metrics')).status, 401);
	const m = await api('/api/metrics', { headers: { authorization: `Bearer ${METRICS_TOKEN}` } });
	assert.equal(m.status, 200);
	assert.match(m.body, /sentinel_voice_relays_active/);
});

await step('everything else requires sign-in', async () => {
	assert.equal((await api('/api/incidents')).status, 401);
	const page = await api('/');
	assert.equal(page.status, 303);
	assert.match(page.headers.get('location'), /^\/login\?next=/);
});

await step('first-run setup creates the organisation and its administrator, once', async () => {
	const r = await action(
		'/setup',
		{ orgName: 'Northwind Kitchens', name: 'Ana Admin', ...ADMIN },
		undefined
	);
	assert.equal(r.body.type, 'redirect', r.text.slice(0, 200));
	assert.ok(r.cookie, 'session cookie set');
	admin = r.cookie;
	const again = await action('/setup', {
		orgName: 'X',
		name: 'Y',
		email: 'y@x.example',
		password: 'another long password'
	});
	assert.notEqual(again.body.type, 'redirect');
	const wrong = await action('/login?/login', { email: ADMIN.email, password: 'wrong password!!' });
	assert.equal(wrong.body.type, 'failure');
	const ok = await action('/login?/login', ADMIN);
	assert.equal(ok.body.type, 'redirect');
});

await step('demo sign-in lands in the fictional demo organisation only', async () => {
	const r = await action('/login?/demo', {});
	assert.ok(r.cookie);
	demo = r.cookie;
	const { body } = await api('/api/incidents', { cookie: demo });
	assert.deepEqual(body.map((i) => i.code).sort(), ['INC-0040', 'INC-0041']);
	assert.deepEqual((await api('/api/incidents', { cookie: admin })).body, []);
});

await step('voice start is honest: not configured, or consent required first', async () => {
	const r = await api('/api/voice/session', { method: 'POST', cookie: admin, body: '{}' });
	if (process.env.ASSEMBLYAI_API_KEY) {
		assert.equal(r.status, 428);
		assert.match(r.body.message, /Consent/);
	} else {
		assert.equal(r.status, 503);
		assert.match(r.body.message, /not configured/);
	}
});

await step('administrator adds an on-call contact with a webhook channel', async () => {
	const r = await action(
		'/settings?/saveContact',
		{
			name: 'Ko Min',
			role: 'maintenance',
			site: 'Yangon Branch',
			channel: 'webhook',
			onCall: 'on'
		},
		admin
	);
	assert.equal(r.body.type, 'success', r.text.slice(0, 300));
});

await step('operator creates an incident manually (degraded mode)', async () => {
	const { body } = await tool(admin, 'create_incident', {
		title: 'Walk-in freezer not cooling',
		type: 'refrigeration_failure',
		facts: [
			{ key: 'location', value: 'Yangon Branch', certainty: 'exact', basis: 'stated' },
			{
				key: 'temperature',
				value: '12°C',
				numeric_value: 12,
				unit: 'C',
				certainty: 'exact',
				basis: 'stated'
			},
			{
				key: 'affected_inventory',
				value: 'frozen chicken and dairy',
				certainty: 'exact',
				basis: 'stated'
			},
			{
				key: 'incident_start',
				value: 'about 20 minutes ago',
				minutes_ago: 20,
				certainty: 'approximate',
				basis: 'stated'
			}
		]
	});
	assert.equal(body.ok, true, JSON.stringify(body));
	incidentId = body.incidentId;
});

await step(
	'incident view exposes severity reasons, checklist, unknowns and a verified chain',
	async () => {
		const { body } = await api(`/api/incidents/${incidentId}`, { cookie: admin });
		incidentCode = body.incident.code;
		assert.equal(incidentCode, 'INC-0040');
		assert.equal(body.incident.isDemo, false);
		assert.equal(body.severityAssessment.level, 'high');
		assert.ok(body.severityAssessment.signals.some((s) => s.rule === 'cold_chain_breach'));
		assert.ok(body.checklist.some((c) => c.key === 'backup_storage' && c.state === 'open'));
		assert.equal(body.audit.ok, true);
	}
);

await step('another organisation cannot see or change it', async () => {
	assert.equal((await api(`/api/incidents/${incidentId}`, { cookie: demo })).status, 404);
	const r = await tool(
		demo,
		'add_fact',
		{ facts: [{ key: 'temperature', value: '2°C', certainty: 'exact', basis: 'stated' }] },
		incidentId
	);
	assert.equal(r.body.ok, false);
	assert.equal(r.body.error, 'Incident not found.');
});

await step('actions, invalid transition rejected, tools validated', async () => {
	const add = await tool(
		admin,
		'add_action',
		{
			actions: [
				{ title: 'Keep refrigeration doors closed', priority: 'immediate', status: 'completed' },
				{
					title: 'Contact maintenance',
					priority: 'immediate',
					contact_role: 'maintenance',
					requires_response: true
				}
			]
		},
		incidentId
	);
	assert.equal(add.body.ok, true);
	const bad = await tool(admin, 'update_action', { action: 1, status: 'in_progress' }, incidentId);
	assert.equal(bad.status, 422);
	const invalid = await tool(admin, 'add_fact', { facts: [] }, incidentId);
	assert.equal(invalid.status, 422);
	const unknown = await tool(admin, 'send_sms', {}, incidentId);
	assert.equal(unknown.status, 404);
});

await step('correction supersedes and keeps history', async () => {
	const r = await tool(
		admin,
		'mark_fact_confirmed',
		{
			key: 'temperature',
			method: 'user_rechecked',
			corrected_value: '13.4°C',
			corrected_numeric_value: 13.4,
			unit: 'C'
		},
		incidentId
	);
	assert.equal(r.body.ok, true);
	const { body } = await api(`/api/incidents/${incidentId}`, { cookie: admin });
	const temps = body.facts.filter((f) => f.key === 'temperature');
	assert.equal(temps.length, 2);
	assert.equal(temps.find((f) => f.status === 'current').numericValue, 13.4);
});

await step('simulation refused on real (non-demo) incidents', async () => {
	const r = await api(`/api/incidents/${incidentId}/simulate`, {
		method: 'POST',
		cookie: admin,
		body: JSON.stringify({ kind: 'contact_responds' })
	});
	assert.equal(r.status, 409);
});

let ackToken;
await step(
	'REAL notification: signed webhook sent after commit, status recorded honestly',
	async () => {
		const r = await tool(admin, 'update_action', { action: 2, status: 'in_progress' }, incidentId);
		assert.equal(r.body.ok, true, JSON.stringify(r.body));
		assert.match(`${r.body.message} ${r.body.guidance}`, /queued/i);
		const hook = await until(() => hooks[0], 'webhook delivery');
		const sig = createHmac('sha256', HOOK_SECRET).update(hook.body).digest('hex');
		assert.equal(hook.headers['x-sentinel-signature'], `sha256=${sig}`);
		const payload = JSON.parse(hook.body);
		assert.match(payload.body, new RegExp(`SENTINEL ${incidentCode}`));
		ackToken = payload.body.match(/\/ack\/([A-Za-z0-9_-]+)/)[1];
		assert.ok(payload.body.includes(`${PUBLIC}/ack/`));
		const view = await until(async () => {
			const { body } = await api(`/api/incidents/${incidentId}`, { cookie: admin });
			return body.notifications?.[0]?.status === 'sent' ? body : null;
		}, 'notification status sent');
		assert.equal(view.actions.find((a) => a.seq === 2).notificationStatus, 'sent');
		assert.ok(view.timeline.some((e) => e.eventType === 'notification_sent'));
	}
);

await step('one-time acknowledgement link records the response without signing in', async () => {
	// SvelteKit reports load errors inside __data.json.
	const bad = await api(`/ack/${'x'.repeat(32)}/__data.json`);
	assert.match(JSON.stringify(bad.body), /"status":404/);
	const page = await api(`/ack/${ackToken}/__data.json`);
	assert.doesNotMatch(JSON.stringify(page.body), /"type":"error"/);
	const r = await action(`/ack/${ackToken}`, { note: 'On my way, 15 minutes' });
	assert.equal(r.body.type, 'success', r.text.slice(0, 300));
	const { body } = await api(`/api/incidents/${incidentId}`, { cookie: admin });
	const a2 = body.actions.find((a) => a.seq === 2);
	assert.ok(a2.responseReceivedAt);
	assert.match(a2.responseSummary, /On my way/);
	assert.ok(body.notifications[0].acknowledgedAt);
	const again = await action(`/ack/${ackToken}`, {});
	assert.equal(again.body.type, 'success');
});

await step('report generation + markdown download', async () => {
	const r = await tool(admin, 'generate_incident_report', {}, incidentId);
	assert.equal(r.body.ok, true);
	const md = await fetch(`${base}/api/incidents/${incidentId}/report`, {
		headers: { cookie: admin }
	});
	assert.equal(md.status, 200);
	const text = await md.text();
	assert.match(text, new RegExp(`# Incident Report — ${incidentCode}`));
	assert.match(text, /previously 12°C/);
});

await step(
	'sensor API: API key required; readings are recorded as sensor observations',
	async () => {
		const key = await action('/settings?/createKey', { name: 'Walk-in probe' }, admin);
		assert.equal(key.body.type, 'success', key.text.slice(0, 200));
		const apiKey = actionData(key).apiKey;
		assert.match(apiKey, /^snt_/);
		const body = JSON.stringify({
			incident: incidentCode,
			source: 'probe-7',
			readings: [{ key: 'temperature', numeric_value: 15, unit: 'C' }]
		});
		assert.equal((await api('/api/observations', { method: 'POST', body })).status, 401);
		const r = await api('/api/observations', {
			method: 'POST',
			body,
			headers: { authorization: `Bearer ${apiKey}` }
		});
		assert.equal(r.status, 200, JSON.stringify(r.body));
		const { body: view } = await api(`/api/incidents/${incidentId}`, { cookie: admin });
		const t = view.facts.find((f) => f.key === 'temperature' && f.status === 'current');
		assert.equal(t.numericValue, 15);
		assert.equal(t.basis, 'observed');
		assert.equal(t.sourceType, 'sensor');
		assert.equal(t.sourceRef, 'probe-7');
	}
);

await step('photo evidence: type-checked by content, hashed, org-scoped', async () => {
	const png = Buffer.from(
		'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
		'base64'
	);
	const upload = async (bytes, type, name) => {
		const fd = new FormData();
		fd.set('file', new Blob([bytes], { type }), name);
		fd.set('caption', 'Display reading');
		const res = await fetch(`${base}/api/incidents/${incidentId}/attachments`, {
			method: 'POST',
			body: fd,
			headers: { cookie: admin, origin: PUBLIC } // browsers send Origin; SvelteKit's CSRF check needs it
		});
		return { status: res.status, body: await res.json() };
	};
	assert.equal((await upload(Buffer.from('not an image'), 'image/png', 'x.png')).status, 415);
	const ok = await upload(png, 'image/png', 'display.png');
	assert.equal(ok.status, 201);
	assert.match(ok.body.sha256, /^[0-9a-f]{64}$/);
	const img = await fetch(`${base}/api/attachments/${ok.body.id}`, { headers: { cookie: admin } });
	assert.equal(img.status, 200);
	assert.equal(img.headers.get('content-type'), 'image/png');
	assert.equal(
		(await fetch(`${base}/api/attachments/${ok.body.id}`, { headers: { cookie: demo } })).status,
		404
	);
});

await step('audit chain verifies and the export carries the verification', async () => {
	const v = await api(`/api/incidents/${incidentId}/audit`, { cookie: admin });
	assert.equal(v.body.ok, true);
	assert.equal(v.body.verified, v.body.events);
	const x = await api(`/api/incidents/${incidentId}/export`, { cookie: admin });
	assert.equal(x.status, 200);
	assert.equal(x.body.format, 'sentinel.incident-export/v1');
	assert.equal(x.body.timelineVerification.ok, true);
	assert.ok(x.body.notifications.every((n) => n.ackTokenHash === undefined));
});

await step('roles: a reporter can report but cannot close or export', async () => {
	const add = await action(
		'/settings?/addMember',
		{ email: 'rae@northwind.example', name: 'Rae Reporter', role: 'reporter' },
		admin
	);
	assert.equal(add.body.type, 'success', add.text.slice(0, 200));
	const temp = actionData(add).tempPassword;
	assert.ok(temp && temp.length >= 12, 'one-time password returned once');
	const login = await action('/login?/login', { email: 'rae@northwind.example', password: temp });
	assert.ok(login.cookie, login.text.slice(0, 200));
	const note = await tool(
		login.cookie,
		'add_timeline_event',
		{ event_type: 'observation', description: 'Door seal looks damaged' },
		incidentId
	);
	assert.equal(note.body.ok, true);
	const close = await tool(
		login.cookie,
		'close_incident',
		{ final_status: 'closed', resolution_summary: 'x' },
		incidentId
	);
	assert.equal(close.status, 403);
	assert.match(close.body.error, /not allowed/);
	assert.equal(
		(await api(`/api/incidents/${incidentId}/export`, { cookie: login.cookie })).status,
		403
	);
});

await step('security headers present; no server secret in page HTML', async () => {
	const res = await fetch(`${base}/`, { headers: { cookie: admin } });
	assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
	assert.equal(res.headers.get('x-frame-options'), 'DENY');
	assert.match(res.headers.get('permissions-policy') ?? '', /microphone=\(self\)/);
	const html = await res.text();
	for (const secret of [process.env.ASSEMBLYAI_API_KEY, HOOK_SECRET, METRICS_TOKEN].filter(
		Boolean
	)) {
		assert.ok(!html.includes(secret));
	}
});

// ── Browser ─────────────────────────────────────────────────────────────────
if (shotsDir || voiceMock) {
	if (shotsDir) mkdirSync(shotsDir, { recursive: true });
	const { chromium } = await import('playwright');
	const browser = await chromium.launch({
		// Fake microphone so getUserMedia + the capture worklet run for real.
		args: [
			'--use-fake-ui-for-media-stream',
			'--use-fake-device-for-media-stream',
			'--autoplay-policy=no-user-gesture-required'
		]
	});
	const context = await browser.newContext({
		viewport: { width: 1600, height: 1000 },
		deviceScaleFactor: 1
	});
	// Proxy every request for the public origin to the in-process server.
	await context.route(`${PUBLIC}/**`, (route) =>
		proxy(route).catch((e) => {
			console.log(`    proxy error for ${route.request().url()}: ${e.message}`);
			return route.abort();
		})
	);
	async function proxy(route) {
		const req = route.request();
		if (process.env.E2E_DEBUG) console.log(`    → ${req.method()} ${req.url()}`);
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
			// Playwright does not route the follow-up request of a fulfilled redirect, so
			// navigate client-side instead (cookies set by the redirect still apply).
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
		await route.fulfill({
			status: res.status,
			headers,
			body: Buffer.from(await res.arrayBuffer())
		});
	}
	// Bridge the browser's relay WebSocket to the in-process server, with its cookie.
	await context.routeWebSocket(/\/api\/voice\/relay/, async (route) => {
		const url = new URL(route.url());
		const jar = await context.cookies(PUBLIC);
		const cookie = jar.map((c) => `${c.name}=${c.value}`).join('; ');
		const upstream = new WebSocket(`${base.replace('http', 'ws')}${url.pathname}${url.search}`, {
			headers: { cookie, origin: PUBLIC }
		});
		const early = [];
		route.onMessage((m) =>
			upstream.readyState === WebSocket.OPEN ? upstream.send(m) : early.push(m)
		);
		upstream.on('open', () => early.splice(0).forEach((m) => upstream.send(m)));
		upstream.on('message', (d) => route.send(String(d)));
		upstream.on('close', (code) =>
			route.close({ code: code === 1005 || code === 1006 ? 1000 : code }).catch(() => {})
		);
		upstream.on('error', () => route.close({ code: 1011 }).catch(() => {}));
		route.onClose(() => upstream.close());
	});
	await context.grantPermissions(['microphone'], { origin: PUBLIC });
	const page = await context.newPage();
	const consoleErrors = [];
	const browserUrls = [];
	page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
	page.on('pageerror', (e) => consoleErrors.push(e.message));
	page.on('request', (r) => browserUrls.push(r.url()));
	page.on('websocket', (ws) => browserUrls.push(ws.url()));
	// Deliberate error paths (422 tool call, 428 consent) are logged by Chrome as resource errors.
	const unexpectedErrors = () => consoleErrors.filter((e) => !/status of (422|428)/.test(e));

	await step('browser: sign-in page, demo sign-in', async () => {
		await page.goto(`${PUBLIC}/`);
		await page.waitForURL(/\/login/);
		await page.getByRole('button', { name: 'Continue with demo' }).click();
		await page.getByText('Turn a messy spoken incident').waitFor();
		await page.getByText('Demo operator').first().waitFor();
	});

	if (voiceMock) await runVoiceMock(page);

	await step('browser: sign out, then sign in as the administrator', async () => {
		await page.goto(`${PUBLIC}/`);
		await page.getByRole('button', { name: 'Sign out' }).click();
		await page.waitForURL(/\/login/);
		await page.getByLabel('Email').fill(ADMIN.email);
		await page.getByLabel('Password').fill(ADMIN.password);
		await page.getByRole('button', { name: 'Sign in', exact: true }).click();
		await page.getByText('Ana Admin').first().waitFor();
		if (shotsDir) await page.screenshot({ path: `${shotsDir}/home.png`, fullPage: true });
	});
	await step(
		'browser: incident command centre shows chain badge, photos and outreach log',
		async () => {
			await page.goto(`${PUBLIC}/incidents/${incidentId}`);
			await page.getByText('Evidence timeline').waitFor();
			await page.getByText('chain verified').waitFor();
			await page.getByText('Photo evidence').waitFor();
			await page.getByText('Outreach log').waitFor();
			await page.getByText('Display reading', { exact: true }).waitFor();
			if (shotsDir) await page.screenshot({ path: `${shotsDir}/incident.png`, fullPage: true });
		}
	);
	await step('browser: provenance drawer shows the sensor reading and history', async () => {
		await page
			.getByRole('button', { name: /Temperature 15°C/ })
			.first()
			.click();
		await page.getByText('Measured by a sensor').waitFor();
		await page.getByText('probe-7').waitFor();
		await page.getByText('Earlier values (kept, not deleted)').waitFor();
		if (shotsDir) await page.screenshot({ path: `${shotsDir}/provenance.png` });
		await page.keyboard.press('Escape');
	});
	await step('browser: settings page manages contacts, members and keys', async () => {
		await page.goto(`${PUBLIC}/settings`);
		await page.getByText('Response policy').waitFor();
		await page.getByText('Ko Min').first().waitFor();
		await page.getByText('Rae Reporter', { exact: true }).waitFor();
		await page.getByText('Walk-in probe').waitFor();
		if (shotsDir) await page.screenshot({ path: `${shotsDir}/settings.png`, fullPage: true });
	});
	await step('browser: replay page rebuilds the chain from stored rows', async () => {
		await page.goto(`${PUBLIC}/incidents/${incidentId}/replay`);
		await page.getByText(/^Incident replay ·/).waitFor();
		if (shotsDir) await page.screenshot({ path: `${shotsDir}/replay.png`, fullPage: true });
	});
	await step('browser: responsive layouts render without horizontal overflow', async () => {
		for (const [name, width] of [
			['laptop', 1280],
			['tablet', 820],
			['narrow', 400]
		]) {
			await page.setViewportSize({ width, height: 900 });
			for (const path of [`/incidents/${incidentId}`, '/settings']) {
				await page.goto(`${PUBLIC}${path}`);
				await page.waitForLoadState('networkidle');
				if (shotsDir && path !== '/settings')
					await page.screenshot({ path: `${shotsDir}/incident-${name}.png`, fullPage: true });
				const overflow = await page.evaluate(() => {
					const over = [...document.querySelectorAll('body *')]
						.filter((el) => el.getBoundingClientRect().right > window.innerWidth + 1)
						.slice(0, 3)
						.map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 60)}`);
					return { px: document.documentElement.scrollWidth - window.innerWidth, over };
				});
				assert.ok(
					overflow.px <= 1,
					`${name} ${path}: horizontal overflow ${overflow.px}px from ${overflow.over.join(' | ')}`
				);
			}
		}
		await page.setViewportSize({ width: 1600, height: 1000 });
	});
	await step('browser: report page renders', async () => {
		await page.goto(`${PUBLIC}/incidents/${incidentId}/report`);
		await page.getByText('Executive summary').waitFor();
		if (shotsDir) await page.screenshot({ path: `${shotsDir}/report.png`, fullPage: true });
	});
	await step('browser: the browser never contacted AssemblyAI or saw its key', async () => {
		assert.ok(browserUrls.length > 0);
		assert.ok(!browserUrls.some((u) => /assemblyai\.com/.test(u)), 'no AssemblyAI URL');
		assert.ok(!browserUrls.some((u) => u.includes(MOCK_KEY)), 'no key in any URL');
	});
	await step('no browser console errors', async () =>
		assert.deepEqual(unexpectedErrors(), [], consoleErrors.join(' | '))
	);
	await browser.close();
}

await step('demo reset: only in the demo organisation', async () => {
	assert.equal((await api('/api/demo/reset', { method: 'POST', cookie: admin })).status, 403);
	const r = await api('/api/demo/reset', { method: 'POST', cookie: demo });
	assert.equal(r.status, 200, JSON.stringify(r.body));
	const { body } = await api('/api/incidents', { cookie: demo });
	assert.deepEqual(body.map((i) => i.code).sort(), ['INC-0040', 'INC-0041']);
	assert.equal((await api(`/api/incidents/${incidentId}`, { cookie: admin })).status, 200);
});

await globalThis.__sentinelShutdown?.();
server.close();
hookServer.close();
agentServer.close();
console.log(failures ? `\n${failures} step(s) FAILED` : '\nAll steps passed');
process.exit(failures ? 1 : 0);

/**
 * Voice through the SENTINEL relay. The in-process agent server stands in for
 * wss://agents.assemblyai.com/v1/ws using the documented event names; the
 * browser code under test is the production VoiceAgent client.
 */
async function runVoiceMock(page) {
	const received = agent.received;
	const send = (o) => agent.current.send(JSON.stringify(o));
	const waitFor = (pred, what, timeout = 10_000) => until(() => received.find(pred), what, timeout);
	const pcmSilence = Buffer.alloc(4800).toString('base64'); // 100 ms of 24 kHz PCM16

	await step(
		'voice: consent is asked once, then the relay opens an AssemblyAI session server-side',
		async () => {
			await page.goto(`${PUBLIC}/incidents/new?scenario=refrigeration`);
			await page.getByRole('button', { name: 'Start incident' }).click();
			await page.getByText('Before voice starts').waitFor();
			await page.getByRole('button', { name: 'I agree, start voice' }).click();
			const update = await waitFor((m) => m.type === 'session.update', 'session.update');
			assert.equal(agent.auth.at(-1), `Bearer ${MOCK_KEY}`);
			assert.equal(update.session.greeting, "I'm listening. Tell me what happened.");
			assert.deepEqual(
				update.session.tools.map((t) => t.name),
				['create_incident']
			);
			assert.ok(update.session.output.voice);
			await page.getByText('Listening', { exact: true }).waitFor();
		}
	);

	await step(
		'voice: mic audio streams through the relay as base64 PCM16 after session.ready',
		async () => {
			const audio = await waitFor((m) => m.type === 'input.audio', 'input.audio');
			const bytes = Buffer.from(audio.audio, 'base64');
			assert.ok(bytes.length > 0 && bytes.length % 2 === 0);
			assert.ok(received.indexOf(audio) > received.findIndex((m) => m.type === 'session.update'));
		}
	);

	const line =
		'The refrigeration unit at our Yangon branch stopped working about twenty minutes ago. The display says twelve degrees. We have frozen chicken and dairy inside.';
	await step(
		'voice: the server executes tool.call and sends tool.result only after reply.done',
		async () => {
			send({ type: 'input.speech.started' });
			send({
				type: 'transcript.user.delta',
				item_id: 'item_1',
				text: 'The refrigeration unit at our'
			});
			send({ type: 'input.speech.stopped' });
			send({ type: 'transcript.user', item_id: 'item_1', text: line });
			await page.getByRole('list', { name: 'Conversation' }).getByText(line).waitFor();
			send({ type: 'reply.started', reply_id: 'fc-call_1', item_id: 'item_2' });
			send({
				type: 'tool.call',
				call_id: 'call_1',
				name: 'create_incident',
				arguments: {
					title: 'Refrigeration failure',
					type: 'refrigeration_failure',
					facts: [
						{
							key: 'location',
							value: 'Yangon Branch',
							certainty: 'exact',
							basis: 'stated',
							evidence_quote: 'at our Yangon branch'
						},
						{
							key: 'incident_start',
							value: 'about twenty minutes ago',
							minutes_ago: 20,
							certainty: 'approximate',
							basis: 'stated',
							evidence_quote: 'stopped working about twenty minutes ago'
						},
						{
							key: 'temperature',
							value: '12°C',
							numeric_value: 12,
							unit: 'C',
							certainty: 'exact',
							basis: 'stated',
							evidence_quote: 'The display says twelve degrees'
						},
						{
							key: 'affected_inventory',
							value: 'frozen chicken and dairy',
							certainty: 'exact',
							basis: 'stated',
							evidence_quote: 'We have frozen chicken and dairy inside'
						}
					]
				}
			});
			await page.getByText('INC-0042').first().waitFor();
			assert.ok(
				!received.some((m) => m.type === 'tool.result'),
				'no tool.result before reply.done'
			);
			send({ type: 'reply.done', reply_id: 'fc-call_1', status: 'completed' });
			const result = await waitFor(
				(m) => m.type === 'tool.result' && m.call_id === 'call_1',
				'tool.result'
			);
			const payload = JSON.parse(result.result);
			assert.equal(payload.ok, true, result.result);
			assert.match(payload.message, /Created INC-0042/);
			assert.ok(payload.state.unknown.some((u) => u.startsWith('unit_status')));
		}
	);

	await step('voice: tools are revealed progressively once the incident exists', async () => {
		const upgrade = await waitFor(
			(m) => m.type === 'session.update' && m.session.tools?.some((t) => t.name === 'add_fact'),
			'tier-2 session.update'
		);
		assert.ok(!upgrade.session.tools.some((t) => t.name === 'create_incident'));
		assert.ok(!('greeting' in upgrade.session), 'immutable greeting must not be re-sent');
		assert.match(upgrade.session.system_prompt, /INC-0042/);
		await page.waitForURL(/\/incidents\/[0-9a-f-]{36}$/);
	});

	await step('voice: transcripts are stored by the server and facts trace to them', async () => {
		const id = page.url().split('/').pop();
		const { body } = await api(`/api/incidents/${id}`, { cookie: demo });
		const temp = body.facts.find((f) => f.key === 'temperature');
		assert.equal(temp.quoteMatched, true);
		assert.equal(temp.sourceType, 'voice_transcript');
		assert.equal(body.transcripts[0].text, line);
		assert.ok(body.transcripts[0].userId, 'utterance attributed to the signed-in speaker');
		assert.equal(body.incident.isDemo, true);
		assert.equal(body.incident.scenario, 'refrigeration');
	});

	await step('voice: agent speech plays and is captioned', async () => {
		send({ type: 'reply.started', reply_id: 'r2', item_id: 'item_3' });
		send({ type: 'reply.audio', data: pcmSilence });
		for (const w of ['Got', 'it,', 'twelve', 'degrees.'])
			send({ type: 'transcript.agent.delta', reply_id: 'r2', delta: w });
		send({
			type: 'transcript.agent',
			reply_id: 'r2',
			text: 'Got it, twelve degrees. Is the unit still running, or completely off?',
			interrupted: false
		});
		send({ type: 'reply.done', reply_id: 'r2', status: 'completed' });
		await page.getByText('Is the unit still running, or completely off?').waitFor();
	});

	await step('voice: barge-in marks the reply interrupted', async () => {
		send({ type: 'reply.started', reply_id: 'r3', item_id: 'item_4' });
		send({ type: 'reply.audio', data: pcmSilence });
		send({ type: 'input.speech.started' });
		send({
			type: 'transcript.agent',
			reply_id: 'r3',
			text: 'The next recommended action is',
			interrupted: true
		});
		send({ type: 'reply.done', reply_id: 'r3', status: 'interrupted' });
		await page.getByText('✋ interrupted').first().waitFor();
		const wait = "Wait, stop. It's still running but it's not cooling.";
		send({ type: 'transcript.user', item_id: 'item_5', text: wait });
		await page.getByRole('list', { name: 'Conversation' }).getByText(wait).waitFor();
	});

	await step('voice: typed input goes through the relay as the user turn', async () => {
		await page.getByRole('button', { name: /Type instead/ }).click();
		await page
			.getByRole('textbox', { name: /message|type/i })
			.first()
			.fill('The door seal is torn');
		await page.keyboard.press('Enter');
		const r = await waitFor(
			(m) => m.type === 'reply.create' && /door seal is torn/.test(m.instructions),
			'typed reply.create'
		);
		assert.match(r.instructions, /The user typed/);
	});

	await step('voice: tool errors come back as is_error with a recoverable message', async () => {
		send({
			type: 'tool.call',
			call_id: 'call_bad',
			name: 'update_action',
			arguments: { action: 99, status: 'completed' }
		});
		send({ type: 'reply.done', reply_id: 'fc-call_bad', status: 'completed' });
		const result = await waitFor(
			(m) => m.type === 'tool.result' && m.call_id === 'call_bad',
			'error tool.result'
		);
		assert.equal(result.is_error, true);
		assert.match(JSON.parse(result.result).error, /no action A99/);
	});

	await step(
		'voice: the server-side timer escalates and SENTINEL is told to relay it (real 30 s demo timer)',
		async () => {
			const id = page.url().split('/').pop();
			send({
				type: 'tool.call',
				call_id: 'call_act',
				name: 'add_action',
				arguments: {
					actions: [
						{
							title: 'Keep refrigeration doors closed',
							priority: 'immediate',
							status: 'completed'
						},
						{
							title: 'Contact maintenance',
							priority: 'immediate',
							status: 'in_progress',
							contact_role: 'maintenance'
						}
					]
				}
			});
			send({ type: 'reply.done', reply_id: 'fc-call_act', status: 'completed' });
			const res = await waitFor(
				(m) => m.type === 'tool.result' && m.call_id === 'call_act',
				'add_action result'
			);
			assert.match(JSON.parse(res.result).guidance, /DEMO SIMULATION/);
			await page.getByText('Awaiting response from Ko Min').waitFor({ timeout: 10_000 });
			if (shotsDir)
				await page.screenshot({ path: `${shotsDir}/voice-awaiting.png`, fullPage: true });
			const sys = await waitFor(
				(m) =>
					m.type === 'conversation.message' &&
					m.role === 'system' &&
					/SYSTEM EVENT: No response from Ko Min/.test(m.content),
				'system event',
				45_000
			);
			assert.match(sys.content, /Maya Win/);
			assert.match(sys.content, /simulated/i);
			await waitFor(
				(m) => m.type === 'reply.create' && received.indexOf(m) > received.indexOf(sys),
				'reply.create'
			);
			const { body } = await api(`/api/incidents/${id}`, { cookie: demo });
			assert.equal(body.incident.status, 'escalated');
			assert.equal(body.escalations[0].targetName, 'Maya Win');
			await page.getByText('E1').first().waitFor();
		}
	);

	if (shotsDir) await page.screenshot({ path: `${shotsDir}/voice-live.png`, fullPage: true });

	await step(
		'voice: upstream drop → resume rejected → fresh session on the same incident',
		async () => {
			const before = received.length;
			agent.current.close(1011, 'simulated network failure');
			await page
				.getByText(/VOICE CONNECTION LOST/i)
				.first()
				.waitFor({ timeout: 10_000 });
			const resume = await waitFor((m) => m.type === 'session.resume', 'session.resume', 15_000);
			assert.equal(resume.session_id, 'sess_e2e_1');
			const fresh = await waitFor(
				(m) =>
					m.type === 'session.update' &&
					received.indexOf(m) > before &&
					typeof m.session.greeting === 'string',
				'fresh session.update',
				20_000
			);
			assert.match(fresh.session.greeting, /back on incident/);
			assert.match(fresh.session.system_prompt, /INC-0042/);
			assert.ok(fresh.session.tools.some((t) => t.name === 'add_fact'));
			await page
				.getByText('Voice reconnected with a new session')
				.first()
				.waitFor({ timeout: 10_000 });
			await page.getByText('Listening', { exact: true }).waitFor();
		}
	);

	await step('voice: End sends session.end upstream and records the lifecycle', async () => {
		await page.getByRole('button', { name: 'End', exact: true }).click();
		await waitFor((m) => m.type === 'session.end', 'session.end');
		await page.getByText('Session ended').waitFor();
		const id = page.url().split('/').pop();
		const body = await until(async () => {
			const { body } = await api(`/api/incidents/${id}`, { cookie: demo });
			return body.timeline.some((e) => e.eventType === 'voice_ended') ? body : null;
		}, 'voice_ended timeline event');
		assert.ok(body);
	});
}
