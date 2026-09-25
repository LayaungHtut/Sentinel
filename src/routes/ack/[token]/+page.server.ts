import { error, fail } from '@sveltejs/kit';
import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { actions as actionsTable, contacts, escalations, incidents } from '$lib/server/db/schema';
import { findByAckToken, markAcknowledged } from '$lib/server/notifications/outbox';
import { executeTool } from '$lib/server/tools/executor';
import { rateLimit } from '$lib/server/http';
import { voiceBus } from '$lib/server/voice/bus';
import { log } from '$lib/server/observability';
import type { Actions, PageServerLoad } from './$types';

/**
 * One-time acknowledgement link sent in a real notification. The token (hashed
 * at rest) authorises exactly one thing: acknowledging that notification.
 */
async function lookup(token: string) {
	const db = await getDb();
	const n = await findByAckToken(db, token);
	if (!n || !n.incidentId) error(404, 'This link is not valid.');
	const [incident] = await db.select().from(incidents).where(eq(incidents.id, n.incidentId));
	if (!incident) error(404, 'This link is not valid.');
	const [contact] = n.contactId
		? await db.select().from(contacts).where(eq(contacts.id, n.contactId))
		: [];
	return { db, n, incident, contactName: contact?.name ?? 'Recipient' };
}

export const load: PageServerLoad = async (event) => {
	await rateLimit(event, 'ack', 30);
	const { n, incident, contactName } = await lookup(event.params.token);
	return {
		code: incident.code,
		title: incident.title,
		status: incident.status,
		contactName,
		message: n.body.split('\nAcknowledge:')[0],
		acknowledgedAt: n.acknowledgedAt?.toISOString() ?? null
	};
};

export const actions: Actions = {
	default: async (event) => {
		await rateLimit(event, 'ack', 30);
		const { db, n, incident, contactName } = await lookup(event.params.token);
		if (n.acknowledgedAt) return { ok: true, already: true };
		const form = await event.request.formData();
		const note = String(form.get('note') ?? '')
			.trim()
			.slice(0, 200);
		const said = note ? `: "${note}"` : '';

		let result;
		if (n.escalationId) {
			const [esc] = await db.select().from(escalations).where(eq(escalations.id, n.escalationId));
			if (!esc) error(404, 'This escalation no longer exists.');
			result = await executeTool(db, {
				name: 'resolve_escalation',
				arguments: {
					escalation: esc.seq,
					status: 'acknowledged',
					note: `${contactName} acknowledged via notification link${said}`.slice(0, 300)
				},
				origin: 'external',
				actorName: contactName,
				orgId: incident.orgId,
				incidentId: incident.id
			});
		} else if (n.actionId) {
			const [action] = await db.select().from(actionsTable).where(eq(actionsTable.id, n.actionId));
			if (!action) error(404, 'This action no longer exists.');
			result = await executeTool(db, {
				name: 'record_response',
				arguments: {
					action: action.seq,
					responder: contactName.slice(0, 80),
					response: (note || 'Acknowledged via notification link.').slice(0, 400)
				},
				origin: 'external',
				actorName: contactName,
				orgId: incident.orgId,
				incidentId: incident.id
			});
		} else {
			error(400, 'Nothing to acknowledge for this message.');
		}
		// An already-resolved escalation still counts as the recipient having seen the message.
		if (!result.ok && !/already/i.test(result.error)) {
			log.warn('acknowledgement not recorded', { notificationId: n.id, error: result.error });
			return fail(409, {
				error: 'Could not record the acknowledgement. Please contact the team directly.'
			});
		}
		await markAcknowledged(db, n.id);
		voiceBus.notify(incident.id, `${contactName} acknowledged the notification${said}.`);
		return { ok: true, already: false };
	}
};
