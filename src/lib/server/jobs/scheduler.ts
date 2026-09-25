import { and, eq, isNull, lte } from 'drizzle-orm';
import { env } from '$lib/server/env';
import { getDb, getDbHandle, type Database } from '../db';
import * as t from '../db/schema';
import { refreshSeverity, runEscalationCheck } from '../incidents/engine';
import { flushIfQueued, flushOutbox } from '../notifications/outbox';
import { pendingReconciliations, reconcileSession } from '../assemblyai/reconcile';
import { runRetention } from './retention';
import { purgeExpiredSessions } from '../auth';
import { voiceBus } from '../voice/bus';
import { log, metrics } from '../observability';

/**
 * Server-side job runner. Replaces the old browser-driven escalation tick:
 * timeouts now fire whether or not anyone has the incident open.
 *
 * Every task runs inside a transaction holding a Postgres advisory lock, so
 * with several app instances only one executes a given task at a time.
 */
/** Advisory-lock key for scheduler leadership (one instance runs jobs). */
const LEADER_KEY = 71_000_001;
let isLeader = false;

async function ensureLeader(): Promise<boolean> {
	if (isLeader) return true;
	try {
		isLeader = await (await getDbHandle()).tryLeaderLock(LEADER_KEY);
		if (isLeader) log.info('scheduler leadership acquired');
	} catch (e) {
		log.warn('leader election failed', { err: e });
	}
	return isLeader;
}

/** Escalation sweep: find overdue awaited actions across all organisations. */
export async function escalationSweep(db: Database, now = new Date()) {
	const due = await db
		.selectDistinct({ incidentId: t.actions.incidentId })
		.from(t.actions)
		.where(
			and(
				eq(t.actions.status, 'in_progress'),
				eq(t.actions.requiresResponse, true),
				isNull(t.actions.responseReceivedAt),
				lte(t.actions.responseDueAt, now)
			)
		);
	const announced: { incidentId: string; text: string }[] = [];
	for (const { incidentId } of due) {
		const ctx = { origin: 'system' as const, voiceSessionId: null, now };
		const created = await db.transaction(async (tx) => {
			const esc = await runEscalationCheck(tx, incidentId, ctx);
			await refreshSeverity(tx, incidentId, ctx);
			return esc;
		});
		for (const c of created) {
			metrics.escalations.inc({ trigger: 'response_timeout' });
			const text = `${c.reason}. Escalated to ${c.target}. ${c.statement}`;
			voiceBus.notify(incidentId, text);
			announced.push({ incidentId, text });
		}
	}
	if (announced.length) void flushIfQueued(db);
	return announced;
}

let timers: ReturnType<typeof setInterval>[] = [];

export function startScheduler() {
	if (timers.length) return;
	const running = new Set<string>();
	const every = (ms: number, name: string, task: (db: Database) => Promise<unknown>) => {
		const tick = async () => {
			if (running.has(name) || !(await ensureLeader())) return;
			running.add(name);
			try {
				await task(await getDb());
			} catch (e) {
				log.error('scheduled task failed', { task: name, err: e });
			} finally {
				running.delete(name);
			}
		};
		timers.push(setInterval(() => void tick(), ms));
	};
	const fast = Number(env.SCHEDULER_TICK_MS) || 2000;
	every(fast, 'escalation', (db) => escalationSweep(db));
	every(5000, 'outbox', (db) => flushOutbox(db));
	every(30_000, 'reconcile', async (db) => {
		if (!env.ASSEMBLYAI_API_KEY) return;
		for (const s of await pendingReconciliations(db)) {
			await reconcileSession(db, s.id).catch((e) =>
				log.warn('reconciliation failed', { err: e, voiceSessionId: s.id })
			);
		}
	});
	every(3600_000, 'retention', (db) => runRetention(db));
	every(3600_000, 'housekeeping', async (db) => {
		await purgeExpiredSessions(db);
		await db
			.delete(t.rateLimits)
			.where(lte(t.rateLimits.windowStart, new Date(Date.now() - 3600_000)));
	});
	log.info('scheduler started', { tickMs: fast });

	globalThis.__sentinelShutdown = async () => {
		stopScheduler();
		voiceBus.closeAll('server shutting down');
		await new Promise((r) => setTimeout(r, 1500));
	};
}

export function stopScheduler() {
	for (const t of timers) clearInterval(t);
	timers = [];
}

declare global {
	var __sentinelShutdown: (() => Promise<void>) | undefined;
}
