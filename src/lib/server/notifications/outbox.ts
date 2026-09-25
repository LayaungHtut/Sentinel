import { randomBytes } from 'node:crypto';
import { and, asc, eq } from 'drizzle-orm';
import { env } from '$lib/server/env';
import type { Database } from '../db';
import * as t from '../db/schema';
import { sha256Hex } from '../db/crypto';
import { addTimeline, type Tx } from '../incidents/repository';
import { channelConfigured, send } from './providers';
import { voiceBus } from '../voice/bus';
import { log, metrics } from '../observability';
import type { ContactRecord, IncidentRecord, NotificationChannel } from '$lib/domain/types';

/**
 * Outbox pattern: tool handlers only *queue* a notification inside their
 * database transaction. `flushOutbox` sends after commit and records the real
 * outcome, so a rolled-back action never sends a message and nothing is
 * reported as sent before the provider accepted it.
 */

export function publicBaseUrl(): string {
	return (env.PUBLIC_BASE_URL || env.ORIGIN || 'http://localhost:5173').replace(/\/$/, '');
}

const CHANNEL_LABELS: Record<NotificationChannel, string> = {
	sms: 'SMS',
	voice_call: 'phone call',
	email: 'email',
	slack: 'Slack message',
	webhook: 'webhook'
};

export interface QueuedNotification {
	status: 'simulated' | 'not_configured' | 'queued';
	channel: NotificationChannel | null;
	/** Plain-language statement that is true right now (for tool guidance and the UI). */
	statement: string;
}

export async function queueNotification(
	db: Tx,
	opts: {
		incident: IncidentRecord;
		contact: ContactRecord | null;
		contactName: string;
		purpose: 'contact' | 'escalation';
		text: string;
		actionId?: string | null;
		escalationId?: string | null;
	}
): Promise<QueuedNotification> {
	const { incident, contact } = opts;
	if (incident.isDemo) {
		return {
			status: 'simulated',
			channel: null,
			statement: `DEMO SIMULATION: outreach to ${opts.contactName} is simulated, no real message was sent.`
		};
	}
	const channel = (contact?.notificationChannel ?? 'none') as NotificationChannel | 'none';
	const address =
		channel === 'sms' || channel === 'voice_call'
			? contact?.phone
			: channel === 'email'
				? contact?.email
				: 'channel';
	if (channel === 'none' || !channelConfigured(channel) || !address) {
		const why =
			channel === 'none'
				? `${opts.contactName} has no notification channel set up`
				: !address
					? `${opts.contactName} has no ${channel === 'email' ? 'email address' : 'phone number'} on file`
					: `the ${CHANNEL_LABELS[channel]} integration isn't configured`;
		return {
			status: 'not_configured',
			channel: channel === 'none' ? null : channel,
			statement: `No message was sent to ${opts.contactName}: ${why}. Staff must contact them directly; SENTINEL tracks the response.`
		};
	}
	const token = randomBytes(24).toString('base64url');
	const link = `${publicBaseUrl()}/ack/${token}`;
	const prefix =
		opts.purpose === 'escalation'
			? `SENTINEL ${incident.code} ESCALATION`
			: `SENTINEL ${incident.code}`;
	const body = `${prefix}: ${opts.text}\nAcknowledge: ${link}`;
	queuedSinceFlush = true;
	await db.insert(t.notifications).values({
		orgId: incident.orgId,
		incidentId: incident.id,
		escalationId: opts.escalationId ?? null,
		actionId: opts.actionId ?? null,
		contactId: contact?.id ?? null,
		channel,
		toAddress:
			channel === 'sms' || channel === 'voice_call' || channel === 'email' ? address : null,
		body,
		status: 'queued',
		ackTokenHash: sha256Hex(token)
	});
	return {
		status: 'queued',
		channel,
		statement: `A ${CHANNEL_LABELS[channel]} to ${opts.contactName} is queued. SENTINEL will confirm when it is actually sent; don't say it was delivered.`
	};
}

let flushing = false;
/** Set when something was queued in this process; lets callers skip needless flushes. */
let queuedSinceFlush = false;

/** Flush right after a commit, but only if this process queued something (the scheduler sweeps the rest). */
export function flushIfQueued(db: Database): Promise<number> {
	if (!queuedSinceFlush) return Promise.resolve(0);
	queuedSinceFlush = false;
	return flushOutbox(db);
}

/** Send queued notifications and record real outcomes. Safe to call repeatedly. */
export async function flushOutbox(db: Database): Promise<number> {
	if (flushing) return 0;
	flushing = true;
	try {
		const queued = await db
			.select()
			.from(t.notifications)
			.where(eq(t.notifications.status, 'queued'))
			.orderBy(asc(t.notifications.createdAt))
			.limit(25);
		for (const n of queued) {
			const result = await send({
				channel: n.channel as NotificationChannel,
				to: n.toAddress,
				body: n.body,
				statusCallbackUrl:
					n.channel === 'sms' || n.channel === 'voice_call'
						? `${publicBaseUrl()}/api/webhooks/twilio/status`
						: undefined
			});
			metrics.notifications.inc({ channel: n.channel, status: result.status });
			await db.transaction(async (tx) => {
				await tx
					.update(t.notifications)
					.set({
						status: result.status,
						providerMessageId: result.providerMessageId ?? null,
						error: result.error ?? null,
						updatedAt: new Date()
					})
					.where(eq(t.notifications.id, n.id));
				await syncLinkedStatus(tx, n.actionId, n.escalationId, result.status);
				if (n.incidentId) {
					await addTimeline(tx, {
						incidentId: n.incidentId,
						eventType: result.ok ? 'notification_sent' : 'notification_failed',
						description: result.ok
							? `${CHANNEL_LABELS[n.channel as NotificationChannel]} sent${n.toAddress ? ` to ${maskAddress(n.toAddress)}` : ''}${result.providerMessageId ? ` (provider id ${result.providerMessageId})` : ''}`
							: `${CHANNEL_LABELS[n.channel as NotificationChannel]} FAILED: ${result.error}`,
						source: 'system',
						refType: 'notification',
						refId: n.id
					});
				}
			});
			if (!result.ok && n.incidentId) {
				voiceBus.notify(
					n.incidentId,
					`The ${CHANNEL_LABELS[n.channel as NotificationChannel]} could not be sent (${result.error}). Someone needs to contact them another way.`
				);
			}
		}
		return queued.length;
	} catch (e) {
		log.error('outbox flush failed', { err: e });
		return 0;
	} finally {
		flushing = false;
	}
}

async function syncLinkedStatus(
	tx: Tx,
	actionId: string | null,
	escalationId: string | null,
	status: string
) {
	if (actionId)
		await tx
			.update(t.actions)
			.set({ notificationStatus: status, updatedAt: new Date() })
			.where(eq(t.actions.id, actionId));
	if (escalationId)
		await tx
			.update(t.escalations)
			.set({ notificationStatus: status })
			.where(eq(t.escalations.id, escalationId));
}

export function maskAddress(a: string): string {
	if (a.includes('@')) {
		const [u, d] = a.split('@');
		return `${u.slice(0, 2)}…@${d}`;
	}
	return a.length > 4 ? `…${a.slice(-4)}` : a;
}

/** Twilio delivery receipt (signature verified by the caller). */
export async function recordDeliveryStatus(
	db: Database,
	providerMessageId: string,
	providerStatus: string
) {
	const mapped =
		providerStatus === 'delivered' || providerStatus === 'completed'
			? 'delivered'
			: ['failed', 'undelivered', 'busy', 'no-answer', 'canceled'].includes(providerStatus)
				? 'failed'
				: null;
	if (!mapped) return false;
	const [n] = await db
		.select()
		.from(t.notifications)
		.where(eq(t.notifications.providerMessageId, providerMessageId));
	if (!n || n.status === mapped) return false;
	await db.transaction(async (tx) => {
		await tx
			.update(t.notifications)
			.set({ status: mapped, updatedAt: new Date() })
			.where(eq(t.notifications.id, n.id));
		await syncLinkedStatus(tx, n.actionId, n.escalationId, mapped);
		if (n.incidentId) {
			await addTimeline(tx, {
				incidentId: n.incidentId,
				eventType: mapped === 'delivered' ? 'notification_delivered' : 'notification_failed',
				description: `${CHANNEL_LABELS[n.channel as NotificationChannel]} ${mapped === 'delivered' ? 'DELIVERED' : `FAILED (${providerStatus})`} — carrier receipt`,
				source: 'external',
				refType: 'notification',
				refId: n.id
			});
		}
	});
	if (mapped === 'failed' && n.incidentId) {
		voiceBus.notify(
			n.incidentId,
			`The ${CHANNEL_LABELS[n.channel as NotificationChannel]} was not delivered (${providerStatus}).`
		);
	}
	return true;
}

export async function findByAckToken(db: Database, token: string) {
	if (!/^[A-Za-z0-9_-]{20,64}$/.test(token)) return null;
	const [n] = await db
		.select()
		.from(t.notifications)
		.where(eq(t.notifications.ackTokenHash, sha256Hex(token)));
	return n ?? null;
}

export async function markAcknowledged(db: Database, notificationId: string) {
	await db
		.update(t.notifications)
		.set({ acknowledgedAt: new Date(), updatedAt: new Date() })
		.where(and(eq(t.notifications.id, notificationId)));
}
