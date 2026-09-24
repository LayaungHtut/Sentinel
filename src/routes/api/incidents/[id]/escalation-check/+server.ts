import { error, json } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { idParam, rateLimit } from '$lib/server/http';
import { getIncident, NotFoundError } from '$lib/server/incidents/repository';
import { refreshSeverity, runEscalationCheck } from '$lib/server/incidents/engine';
import type { RequestHandler } from './$types';

/**
 * Evaluate the response-timeout escalation rule. The dashboard calls this on
 * a short interval while an incident is open; the rule itself (and its
 * idempotency) lives server-side.
 */
export const POST: RequestHandler = async (event) => {
	rateLimit(event, 'escalation-check', 120);
	const id = idParam.parse(event.params.id);
	const db = await getDb();
	try {
		await getIncident(db, id);
		const ctx = { origin: 'system' as const, voiceSessionId: null, now: new Date() };
		const created = await db.transaction(async (tx) => {
			const esc = await runEscalationCheck(tx, id, ctx);
			// Time-based rules (e.g. 2 h above 5 °C) can change severity without new facts.
			await refreshSeverity(tx, id, ctx);
			return esc;
		});
		return json({ created });
	} catch (e) {
		if (e instanceof NotFoundError) error(404, e.message);
		throw e;
	}
};
