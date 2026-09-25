import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { WebSocketServer, type WebSocket as WsSocket } from 'ws';
import { and, eq, sql } from 'drizzle-orm';

// Providers, relay and outbox read configuration at call time from process.env ($lib/server/env).

import { createDb, type DbHandle } from './db';
import * as t from './db/schema';
import { seedDatabase } from './demo/seed';
import { executeTool, type Actor } from './tools/executor';
import {
	atLeast,
	createSession,
	hashPassword,
	passwordProblem,
	resolveApiKey,
	newApiKey,
	resolveSession,
	verifyPassword
} from './auth';
import { verifyChain } from './incidents/audit';
import { getIncidentInOrg, listIncidents, NotFoundError } from './incidents/repository';
import { findByAckToken, markAcknowledged, recordDeliveryStatus } from './notifications/outbox';
import { validTwilioSignature } from './notifications/providers';
import { matchTurns } from './assemblyai/reconcile';
import { runRetention, REDACTED } from './jobs/retention';
import { escalationSweep } from './jobs/scheduler';
import { createVoiceSession } from './assemblyai/voice-sessions';
import { VoiceRelay } from './voice/relay';
import { voiceBus } from './voice/bus';

let h: DbHandle;
const ORG_A = 'org_test_a';
const ORG_B = 'org_test_b';
let userA: string;
let userB: string;
const admin = (userId: string): Actor => ({ userId, name: 'Admin', role: 'admin' });

const TWILIO_ENV = {
	TWILIO_ACCOUNT_SID: 'AC_test',
	TWILIO_AUTH_TOKEN: 'test-auth-token',
	TWILIO_FROM_NUMBER: '+15550000000',
	PUBLIC_BASE_URL: 'https://sentinel.example.test'
};

beforeAll(async () => {
	h = await createDb({ pgliteDataDir: 'memory://' });
	await seedDatabase(h.db);
	await h.db.insert(t.organizations).values([
		{ id: ORG_A, name: 'Org A', slug: 'org-a', settings: {} },
		{ id: ORG_B, name: 'Org B', slug: 'org-b', settings: {} }
	]);
	const [a] = await h.db
		.insert(t.users)
		.values({
			email: 'a@example.test',
			name: 'Ana',
			passwordHash: await hashPassword('correct horse battery')
		})
		.returning();
	const [b] = await h.db
		.insert(t.users)
		.values({ email: 'b@example.test', name: 'Bo', passwordHash: null })
		.returning();
	userA = a.id;
	userB = b.id;
	await h.db.insert(t.memberships).values([
		{ userId: userA, orgId: ORG_A, role: 'admin' },
		{ userId: userB, orgId: ORG_B, role: 'admin' }
	]);
	await h.db.insert(t.contacts).values({
		orgId: ORG_A,
		name: 'Ko Min',
		role: 'maintenance',
		roleLabel: 'Maintenance',
		organization: 'Org A',
		isDemo: false,
		notificationChannel: 'sms',
		phone: '+15551112222',
		onCall: true
	});
});
afterAll(async () => h?.close());
afterEach(() => {
	vi.unstubAllGlobals();
	for (const k of Object.keys(TWILIO_ENV)) delete process.env[k];
});

async function createIncident(orgId: string, actor: Actor, title = 'Freezer down') {
	const res = await executeTool(h.db, {
		name: 'create_incident',
		origin: 'operator',
		orgId,
		actor,
		arguments: {
			title,
			type: 'refrigeration_failure',
			facts: [
				{
					key: 'temperature',
					value: '12°C',
					numeric_value: 12,
					unit: 'C',
					certainty: 'exact',
					basis: 'stated'
				}
			]
		}
	});
	expect(res.ok).toBe(true);
	return res.incidentId!;
}

async function until(fn: () => Promise<boolean>, ms = 5000) {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (await fn()) return true;
		await new Promise((r) => setTimeout(r, 25));
	}
	return false;
}

function fakeCookies() {
	const jar = new Map<string, string>();
	return {
		jar,
		cookies: {
			set: (name: string, value: string) => void jar.set(name, value),
			delete: (name: string) => void jar.delete(name),
			get: (name: string) => jar.get(name)
		} as never
	};
}

describe('authentication', () => {
	it('hashes passwords with scrypt and rejects wrong ones', async () => {
		const hash = await hashPassword('correct horse battery');
		expect(hash.startsWith('scrypt$')).toBe(true);
		expect(await verifyPassword('correct horse battery', hash)).toBe(true);
		expect(await verifyPassword('wrong password!!', hash)).toBe(false);
		expect(await verifyPassword('anything', null)).toBe(false);
		expect(passwordProblem('short')).toMatch(/12/);
		expect(passwordProblem('long enough password')).toBeNull();
	});

	it('creates a session whose cookie resolves to user, org and role; stores only the token hash', async () => {
		const { jar, cookies } = fakeCookies();
		await createSession(h.db, userA, ORG_A, cookies, true);
		const token = jar.get('sentinel_session')!;
		expect(token).toBeTruthy();
		const auth = await resolveSession(h.db, token);
		expect(auth).toMatchObject({ userId: userA, orgId: ORG_A, role: 'admin', orgIsDemo: false });
		const rows = await h.db.select().from(t.authSessions).where(eq(t.authSessions.userId, userA));
		expect(rows.some((r) => r.id === token)).toBe(false);
		expect(await resolveSession(h.db, 'not-a-real-token')).toBeNull();
	});

	it('disabled users cannot use existing sessions', async () => {
		const { jar, cookies } = fakeCookies();
		await createSession(h.db, userB, ORG_B, cookies, false);
		await h.db.update(t.users).set({ disabledAt: new Date() }).where(eq(t.users.id, userB));
		expect(await resolveSession(h.db, jar.get('sentinel_session'))).toBeNull();
		await h.db.update(t.users).set({ disabledAt: null }).where(eq(t.users.id, userB));
	});

	it('API keys are stored hashed and can be revoked', async () => {
		const k = newApiKey();
		await h.db
			.insert(t.apiKeys)
			.values({ orgId: ORG_A, name: 'probe', keyHash: k.hash, prefix: k.prefix });
		expect((await resolveApiKey(h.db, `Bearer ${k.key}`))?.orgId).toBe(ORG_A);
		expect(await resolveApiKey(h.db, 'Bearer snt_wrong')).toBeNull();
		await h.db
			.update(t.apiKeys)
			.set({ revokedAt: new Date() })
			.where(eq(t.apiKeys.keyHash, k.hash));
		expect(await resolveApiKey(h.db, `Bearer ${k.key}`)).toBeNull();
	});
});

describe('roles', () => {
	it('orders roles reporter < coordinator < manager < admin', () => {
		expect(atLeast('manager', 'coordinator')).toBe(true);
		expect(atLeast('reporter', 'coordinator')).toBe(false);
	});

	it('a reporter can report but cannot close an incident or clear escalations', async () => {
		const reporter: Actor = { userId: userA, name: 'Rae', role: 'reporter' };
		const id = await createIncident(ORG_A, reporter, 'Reporter incident');
		const close = await executeTool(h.db, {
			name: 'close_incident',
			origin: 'operator',
			orgId: ORG_A,
			actor: reporter,
			incidentId: id,
			arguments: { final_status: 'closed', resolution_summary: 'done' }
		});
		expect(close.ok).toBe(false);
		if (!close.ok) expect(close.error).toMatch(/not allowed/);
		const [audit] = await h.db
			.select()
			.from(t.toolInvocations)
			.where(
				and(eq(t.toolInvocations.incidentId, id), eq(t.toolInvocations.toolName, 'close_incident'))
			);
		expect(audit.ok).toBe(false);
		expect(audit.userId).toBe(userA);
	});
});

describe('tenancy isolation', () => {
	it('another organisation cannot read or change an incident', async () => {
		const id = await createIncident(ORG_A, admin(userA), 'Org A only');
		await expect(getIncidentInOrg(h.db, ORG_B, id)).rejects.toBeInstanceOf(NotFoundError);
		expect((await listIncidents(h.db, ORG_B, 50)).some((i) => i.id === id)).toBe(false);
		const res = await executeTool(h.db, {
			name: 'add_fact',
			origin: 'operator',
			orgId: ORG_B,
			actor: admin(userB),
			incidentId: id,
			arguments: {
				facts: [{ key: 'temperature', value: '99°C', certainty: 'exact', basis: 'stated' }]
			}
		});
		expect(res).toMatchObject({ ok: false, error: 'Incident not found.' });
		const facts = await h.db.select().from(t.facts).where(eq(t.facts.incidentId, id));
		expect(facts.every((f) => f.value !== '99°C')).toBe(true);
	});

	it('incident codes are numbered per organisation', async () => {
		const a = await getIncidentInOrg(h.db, ORG_A, await createIncident(ORG_A, admin(userA)));
		const b = await getIncidentInOrg(h.db, ORG_B, await createIncident(ORG_B, admin(userB)));
		expect(a.code).toMatch(/^INC-\d{4}$/);
		expect(b.code).toBe('INC-0040');
	});
});

describe('tamper-evident audit trail', () => {
	it('verifies an intact hash chain', async () => {
		const id = await createIncident(ORG_A, admin(userA));
		const v = await verifyChain(h.db, id);
		expect(v.ok).toBe(true);
		expect(v.events).toBeGreaterThan(1);
		expect(v.verified).toBe(v.events);
		expect(v.headHash).toMatch(/^[0-9a-f]{64}$/);
	});

	it('the database rejects edits and deletions of timeline, tool log and fact evidence', async () => {
		const id = await createIncident(ORG_A, admin(userA));
		await expect(
			h.db.execute(sql`update timeline_events set description = 'x' where incident_id = ${id}`)
		).rejects.toThrow();
		await expect(
			h.db.execute(sql`delete from timeline_events where incident_id = ${id}`)
		).rejects.toThrow();
		await expect(
			h.db.execute(sql`update tool_invocations set ok = true where incident_id = ${id}`)
		).rejects.toThrow();
		await expect(
			h.db.execute(sql`update facts set value = '1°C' where incident_id = ${id}`)
		).rejects.toThrow();
		await expect(h.db.execute(sql`delete from facts where incident_id = ${id}`)).rejects.toThrow();
		// Lifecycle fields remain writable (supersession, verification).
		await h.db.execute(sql`update facts set verification = 'confirmed' where incident_id = ${id}`);
	});

	it('detects tampering that bypasses the triggers (e.g. a superuser edit)', async () => {
		const id = await createIncident(ORG_A, admin(userA));
		await h.db.execute(
			sql`alter table timeline_events disable trigger timeline_events_append_only`
		);
		try {
			await h.db.execute(
				sql`update timeline_events set description = 'Temperature recorded: 2°C' where incident_id = ${id} and chain_seq = 2`
			);
			const edited = await verifyChain(h.db, id);
			expect(edited.ok).toBe(false);
			expect(edited.brokenAt).toBe(2);

			await h.db.execute(
				sql`delete from timeline_events where incident_id = ${id} and chain_seq = 1`
			);
			const deleted = await verifyChain(h.db, id);
			expect(deleted.ok).toBe(false);
			expect(deleted.reason).toMatch(/missing/);
		} finally {
			await h.db.execute(
				sql`alter table timeline_events enable trigger timeline_events_append_only`
			);
		}
	});
});

describe('notifications (outbox)', () => {
	it('reports not_configured honestly when no provider is set up', async () => {
		const id = await createIncident(ORG_A, admin(userA));
		const res = await executeTool(h.db, {
			name: 'add_action',
			origin: 'operator',
			orgId: ORG_A,
			actor: admin(userA),
			incidentId: id,
			arguments: {
				actions: [
					{
						title: 'Call maintenance',
						priority: 'immediate',
						status: 'in_progress',
						contact_role: 'maintenance',
						requires_response: true
					}
				]
			}
		});
		expect(res.ok).toBe(true);
		const [action] = await h.db.select().from(t.actions).where(eq(t.actions.incidentId, id));
		expect(action.notificationStatus).toBe('not_configured');
		expect(
			await h.db.select().from(t.notifications).where(eq(t.notifications.incidentId, id))
		).toHaveLength(0);
	});

	it('queues, sends via Twilio after commit, and only says delivered after a receipt', async () => {
		Object.assign(process.env, TWILIO_ENV);
		const calls: { url: string; body: string }[] = [];
		vi.stubGlobal(
			'fetch',
			vi.fn(async (url: string, init: RequestInit) => {
				calls.push({ url: String(url), body: String(init.body) });
				return new Response(JSON.stringify({ sid: 'SM_test_1' }), { status: 201 });
			})
		);
		const id = await createIncident(ORG_A, admin(userA));
		const res = await executeTool(h.db, {
			name: 'add_action',
			origin: 'operator',
			orgId: ORG_A,
			actor: admin(userA),
			incidentId: id,
			arguments: {
				actions: [
					{
						title: 'Call maintenance',
						priority: 'immediate',
						status: 'in_progress',
						contact_role: 'maintenance',
						requires_response: true
					}
				]
			}
		});
		expect(res.ok).toBe(true);
		// At tool time the message is only queued, and the agent is told exactly that.
		if (res.ok) expect(`${res.message} ${res.guidance}`).toMatch(/queued/i);

		const sent = await until(async () => {
			const [n] = await h.db
				.select()
				.from(t.notifications)
				.where(eq(t.notifications.incidentId, id));
			return n?.status === 'sent';
		});
		expect(sent).toBe(true);
		expect(calls[0].url).toContain('/Accounts/AC_test/Messages.json');
		expect(calls[0].body).toContain('To=%2B15551112222');
		expect(calls[0].body).toContain(
			encodeURIComponent('https://sentinel.example.test/api/webhooks/twilio/status')
		);

		const [n] = await h.db.select().from(t.notifications).where(eq(t.notifications.incidentId, id));
		const [action] = await h.db.select().from(t.actions).where(eq(t.actions.incidentId, id));
		expect(action.notificationStatus).toBe('sent');

		expect(await recordDeliveryStatus(h.db, 'SM_test_1', 'delivered')).toBe(true);
		const [after] = await h.db.select().from(t.actions).where(eq(t.actions.id, action.id));
		expect(after.notificationStatus).toBe('delivered');
		const timeline = await h.db
			.select()
			.from(t.timelineEvents)
			.where(eq(t.timelineEvents.incidentId, id));
		expect(timeline.map((e) => e.eventType)).toEqual(
			expect.arrayContaining(['notification_sent', 'notification_delivered'])
		);

		// The acknowledgement link in the message resolves to this notification only.
		const token = n.body.match(/\/ack\/([A-Za-z0-9_-]+)/)![1];
		expect((await findByAckToken(h.db, token))?.id).toBe(n.id);
		expect(await findByAckToken(h.db, 'x'.repeat(32))).toBeNull();
		expect(n.ackTokenHash).not.toBe(token);
		await markAcknowledged(h.db, n.id);
		expect((await findByAckToken(h.db, token))?.acknowledgedAt).toBeInstanceOf(Date);
	});

	it('records a provider failure as failed, never as sent', async () => {
		Object.assign(process.env, TWILIO_ENV);
		vi.stubGlobal(
			'fetch',
			vi.fn(
				async () => new Response(JSON.stringify({ message: 'invalid number' }), { status: 400 })
			)
		);
		const id = await createIncident(ORG_A, admin(userA));
		await executeTool(h.db, {
			name: 'add_action',
			origin: 'operator',
			orgId: ORG_A,
			actor: admin(userA),
			incidentId: id,
			arguments: {
				actions: [
					{
						title: 'Call maintenance',
						priority: 'immediate',
						status: 'in_progress',
						contact_role: 'maintenance'
					}
				]
			}
		});
		expect(
			await until(async () => {
				const [n] = await h.db
					.select()
					.from(t.notifications)
					.where(eq(t.notifications.incidentId, id));
				return n?.status === 'failed';
			})
		).toBe(true);
		const [action] = await h.db.select().from(t.actions).where(eq(t.actions.incidentId, id));
		expect(action.notificationStatus).toBe('failed');
	});

	it('validates Twilio webhook signatures', () => {
		process.env.TWILIO_AUTH_TOKEN = 'test-auth-token';
		const url = 'https://sentinel.example.test/api/webhooks/twilio/status';
		const params = { MessageSid: 'SM1', MessageStatus: 'delivered' };
		const data = url + 'MessageSid' + 'SM1' + 'MessageStatus' + 'delivered';
		const sig = createHmac('sha1', 'test-auth-token').update(data).digest('base64');
		expect(validTwilioSignature(url, params, sig)).toBe(true);
		expect(validTwilioSignature(url, { ...params, MessageStatus: 'failed' }, sig)).toBe(false);
		expect(validTwilioSignature(url, params, null)).toBe(false);
	});
});

describe('server-side escalation timers', () => {
	it('escalates an unanswered contact without any browser open', async () => {
		const id = await createIncident(ORG_A, admin(userA));
		const start = new Date();
		await executeTool(h.db, {
			name: 'add_action',
			origin: 'operator',
			orgId: ORG_A,
			actor: admin(userA),
			incidentId: id,
			now: start,
			arguments: {
				actions: [
					{
						title: 'Call maintenance',
						priority: 'immediate',
						status: 'in_progress',
						contact_role: 'maintenance',
						requires_response: true
					}
				]
			}
		});
		const [action] = await h.db.select().from(t.actions).where(eq(t.actions.incidentId, id));
		expect(action.responseDueAt).toBeInstanceOf(Date);
		await escalationSweep(h.db, new Date(action.responseDueAt!.getTime() - 1000));
		expect(
			await h.db.select().from(t.escalations).where(eq(t.escalations.incidentId, id))
		).toHaveLength(0);
		await escalationSweep(h.db, new Date(action.responseDueAt!.getTime() + 1000));
		await escalationSweep(h.db, new Date(action.responseDueAt!.getTime() + 2000));
		expect(
			await h.db.select().from(t.escalations).where(eq(t.escalations.incidentId, id))
		).toHaveLength(1);
	});
});

describe('retention', () => {
	it('redacts old transcript text and quotes but keeps facts and the chain', async () => {
		const id = await createIncident(ORG_A, admin(userA));
		await h.db
			.update(t.organizations)
			.set({ settings: { retentionDays: 1 } })
			.where(eq(t.organizations.id, ORG_A));
		const old = new Date(Date.now() - 3 * 86400_000);
		await h.db.insert(t.transcripts).values({
			incidentId: id,
			speaker: 'user',
			text: 'my phone is 555 0100',
			channel: 'voice',
			receivedAt: old
		});
		await runRetention(h.db);
		const rows = await h.db.select().from(t.transcripts).where(eq(t.transcripts.incidentId, id));
		expect(rows[0].text).toBe(REDACTED);
		expect(rows[0].redactedAt).toBeInstanceOf(Date);
		expect(
			(await h.db.select().from(t.facts).where(eq(t.facts.incidentId, id))).length
		).toBeGreaterThan(0);
		expect((await verifyChain(h.db, id)).ok).toBe(true);
		await h.db.update(t.organizations).set({ settings: {} }).where(eq(t.organizations.id, ORG_A));
	});
});

describe('post-session reconciliation', () => {
	it('aligns AssemblyAI user turns with local transcripts and carries confidence', () => {
		const { matches, matched } = matchTurns(
			[
				{ user_transcript: 'The freezer at Yangon stopped working.', user_confidence: 0.93 },
				{ agent_text: 'Got it.' },
				{ user_transcript: 'It says twelve degrees', user_confidence: 0.41 }
			],
			[
				{ id: 't1', text: 'The freezer at Yangon stopped working.' },
				{ id: 't2', text: 'It says twelve degrees.' }
			]
		);
		expect(matched).toBe(2);
		expect(matches).toEqual([
			{ transcriptId: 't1', confidence: 0.93 },
			{ transcriptId: 't2', confidence: 0.41 }
		]);
	});
});

describe('sensor observations', () => {
	it('records readings as observed sensor facts, never as something a person said', async () => {
		const id = await createIncident(ORG_A, admin(userA));
		const res = await executeTool(h.db, {
			name: 'add_fact',
			origin: 'sensor',
			orgId: ORG_A,
			actorName: 'Walk-in probe',
			sourceRef: 'probe-7',
			incidentId: id,
			arguments: {
				facts: [
					{
						key: 'temperature',
						value: '14°C',
						numeric_value: 14,
						unit: 'C',
						certainty: 'exact',
						basis: 'stated'
					}
				]
			}
		});
		expect(res.ok).toBe(true);
		const [f] = await h.db
			.select()
			.from(t.facts)
			.where(
				and(
					eq(t.facts.incidentId, id),
					eq(t.facts.key, 'temperature'),
					eq(t.facts.status, 'current')
				)
			);
		expect(f).toMatchObject({
			basis: 'observed',
			sourceType: 'sensor',
			sourceRef: 'probe-7',
			speaker: 'Walk-in probe'
		});
	});
});

describe('shared rate limiter', () => {
	it('counts per user and window in Postgres and rejects requests over the limit', async () => {
		process.env.PGLITE_DATA_DIR = 'memory://';
		delete process.env.DATABASE_URL;
		const { rateLimit } = await import('./http');
		const event = (userId: string) =>
			({ locals: { auth: { userId } }, getClientAddress: () => '203.0.113.9' }) as never;
		const hour = 3_600_000; // wide window so the test never straddles a boundary
		for (let i = 0; i < 3; i++) await rateLimit(event('rl-a'), 'rl-test', 3, hour);
		await expect(rateLimit(event('rl-a'), 'rl-test', 3, hour)).rejects.toMatchObject({
			status: 429
		});
		await expect(rateLimit(event('rl-b'), 'rl-test', 3, hour)).resolves.toBeUndefined();
	});
});

// ─── Voice relay against an in-process mock of the AssemblyAI Voice Agent API ───

class FakeBrowser extends EventEmitter {
	readyState = 1;
	frames: Record<string, unknown>[] = [];
	send(data: string) {
		this.frames.push(JSON.parse(data));
	}
	close() {
		this.readyState = 3;
	}
	fromBrowser(msg: Record<string, unknown>) {
		this.emit('message', Buffer.from(JSON.stringify(msg)));
	}
}

describe('voice relay', () => {
	let wss: WebSocketServer;
	let upstream: WsSocket;
	const received: Record<string, unknown>[] = [];
	const authHeaders: string[] = [];

	beforeAll(async () => {
		wss = new WebSocketServer({ port: 0 });
		await new Promise<void>((r) => wss.once('listening', () => r()));
		wss.on('connection', (ws, req) => {
			upstream = ws;
			authHeaders.push(String(req.headers.authorization));
			ws.on('message', (raw) => {
				const msg = JSON.parse(String(raw));
				received.push(msg);
				if (msg.type === 'session.update' && msg.session?.system_prompt) {
					ws.send(JSON.stringify({ type: 'session.ready', session_id: 'provider-1' }));
				}
				if (msg.type === 'session.end') ws.send(JSON.stringify({ type: 'session.ended' }));
			});
		});
	});
	afterAll(async () => {
		delete process.env.ASSEMBLYAI_WS_URL;
		delete process.env.ASSEMBLYAI_API_KEY;
		await new Promise((r) => wss.close(r));
	});

	it('executes tools server-side, persists transcripts, and honours reply.done ordering', async () => {
		const port = (wss.address() as { port: number }).port;
		process.env.ASSEMBLYAI_WS_URL = `ws://127.0.0.1:${port}`;
		process.env.ASSEMBLYAI_API_KEY = 'test-key-not-real';

		const vs = await createVoiceSession(h.db, {
			orgId: ORG_A,
			userId: userA,
			consentAt: new Date()
		});
		const browser = new FakeBrowser();
		const relay = new VoiceRelay({
			db: h.db,
			browser: browser as never,
			voiceSessionId: vs.id,
			orgId: ORG_A,
			actor: { userId: userA, name: 'Ana', role: 'coordinator' }
		});
		await relay.start();
		expect(
			await until(async () =>
				browser.frames.some((f) => f.type === 'status' && f.state === 'ready')
			)
		).toBe(true);
		expect(authHeaders.at(-1)).toBe('Bearer test-key-not-real');
		expect(voiceBus.activeCount()).toBeGreaterThan(0);

		// Audio frames from the browser are forwarded as input.audio.
		browser.fromBrowser({ type: 'audio', audio: 'AAAA' });
		expect(await until(async () => received.some((m) => m.type === 'input.audio'))).toBe(true);

		const say = 'Our Yangon freezer stopped, it reads twelve degrees';
		upstream.send(JSON.stringify({ type: 'transcript.user', text: say, item_id: 'u1' }));
		upstream.send(JSON.stringify({ type: 'reply.started' }));
		upstream.send(
			JSON.stringify({
				type: 'tool.call',
				call_id: 'call-1',
				name: 'create_incident',
				arguments: {
					title: 'Freezer failure',
					type: 'refrigeration_failure',
					facts: [
						{
							key: 'temperature',
							value: '12°C',
							numeric_value: 12,
							unit: 'C',
							certainty: 'exact',
							basis: 'stated',
							evidence_quote: 'it reads twelve degrees'
						}
					]
				}
			})
		);
		expect(await until(async () => browser.frames.some((f) => f.type === 'incident'))).toBe(true);
		// No tool.result before reply.done.
		expect(received.some((m) => m.type === 'tool.result')).toBe(false);
		upstream.send(JSON.stringify({ type: 'reply.done', status: 'completed' }));
		expect(await until(async () => received.some((m) => m.type === 'tool.result'))).toBe(true);
		const result = received.find((m) => m.type === 'tool.result')!;
		expect(result.call_id).toBe('call-1');
		expect(JSON.parse(String(result.result)).ok).toBe(true);

		const incidentId = String(browser.frames.find((f) => f.type === 'incident')!.incidentId);
		const [transcript] = await h.db
			.select()
			.from(t.transcripts)
			.where(eq(t.transcripts.voiceSessionId, vs.id));
		expect(transcript).toMatchObject({ text: say, userId: userA });
		const [fact] = await h.db.select().from(t.facts).where(eq(t.facts.incidentId, incidentId));
		expect(fact.quoteMatched).toBe(true);
		const [inc] = await h.db.select().from(t.incidents).where(eq(t.incidents.id, incidentId));
		expect(inc.orgId).toBe(ORG_A);

		// SENTINEL events reach the caller through the relay.
		voiceBus.notify(incidentId, 'Maintenance acknowledged.');
		expect(
			browser.frames.some((f) => f.type === 'system' && f.text === 'Maintenance acknowledged.')
		).toBe(true);
		expect(await until(async () => received.some((m) => m.type === 'reply.create'))).toBe(true);

		// A role-restricted tool fails cleanly for a coordinator.
		upstream.send(
			JSON.stringify({
				type: 'tool.call',
				call_id: 'call-2',
				name: 'close_incident',
				arguments: { final_status: 'closed', resolution_summary: 'x' }
			})
		);
		expect(
			await until(async () =>
				browser.frames.some(
					(f) => f.type === 'tool' && f.callId === 'call-2' && f.state === 'error'
				)
			)
		).toBe(true);

		// Ending from the browser sends session.end upstream and records the lifecycle.
		browser.fromBrowser({ type: 'end' });
		expect(await until(async () => received.some((m) => m.type === 'session.end'))).toBe(true);
		expect(
			await until(async () => {
				const [s] = await h.db.select().from(t.voiceSessions).where(eq(t.voiceSessions.id, vs.id));
				return s.status === 'ended';
			})
		).toBe(true);
		expect(browser.frames.some((f) => f.type === 'status' && f.state === 'ended')).toBe(true);
	});
});
