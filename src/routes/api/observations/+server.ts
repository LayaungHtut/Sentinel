import { error, json } from '@sveltejs/kit';
import { z } from 'zod';
import { getDb } from '$lib/server/db';
import { resolveApiKey } from '$lib/server/auth';
import { rateLimit, readJson } from '$lib/server/http';
import { findIncidentByIdOrCode } from '$lib/server/incidents/repository';
import { executeTool } from '$lib/server/tools/executor';
import { voiceBus } from '$lib/server/voice/bus';
import { INCIDENT_TYPES } from '$lib/domain/types';
import type { RequestHandler } from './$types';

const reading = z.object({
	key: z
		.string()
		.min(1)
		.max(64)
		.regex(/^[a-z0-9_]+$/),
	value: z.string().max(300).optional(),
	numeric_value: z.number().finite().optional(),
	unit: z.string().max(16).optional(),
	label: z.string().max(80).optional()
});

const body = z
	.object({
		/** Existing incident id or code (e.g. INC-0042). */
		incident: z.string().max(64).optional(),
		/** Or open a new incident from this observation (e.g. a freezer alarm). */
		open: z.object({ title: z.string().min(3).max(120), type: z.enum(INCIDENT_TYPES) }).optional(),
		/** Device or reading identifier, stored on each fact as its source reference. */
		source: z.string().min(1).max(120),
		readings: z.array(reading).min(1).max(10)
	})
	.refine((b) => Boolean(b.incident) !== Boolean(b.open), {
		message: 'Give exactly one of "incident" or "open".'
	})
	.refine((b) => b.readings.every((r) => r.value || r.numeric_value !== undefined), {
		message: 'Each reading needs value or numeric_value.'
	});

/**
 * Sensor / integration API. Authenticated with an organisation API key
 * (`Authorization: Bearer snt_...`). Readings are recorded as facts with basis
 * "observed" and source "sensor" — shown as sensor readings, never as
 * something a person said — and a live voice session on the incident is told.
 */
export const POST: RequestHandler = async (event) => {
	const db = await getDb();
	const key = await resolveApiKey(db, event.request.headers.get('authorization'));
	if (!key) error(401, 'A valid API key is required.');
	await rateLimit(event, `observations:${key.id}`, 120);
	const input = await readJson(event.request, body);

	const facts = input.readings.map((r) => ({
		key: r.key,
		value: r.value,
		numeric_value: r.numeric_value,
		unit: r.unit,
		label: r.label,
		certainty: 'exact' as const,
		basis: 'stated' as const // replaced by "observed" for sensor origin
	}));
	const common = {
		origin: 'sensor' as const,
		orgId: key.orgId,
		actorName: key.name,
		sourceRef: input.source
	};

	let result;
	if (input.open) {
		result = await executeTool(db, {
			...common,
			name: 'create_incident',
			arguments: { title: input.open.title, type: input.open.type, facts }
		});
	} else {
		const incident = await findIncidentByIdOrCode(db, key.orgId, input.incident!);
		if (!incident) error(404, 'Incident not found.');
		result = await executeTool(db, {
			...common,
			name: 'add_fact',
			incidentId: incident.id,
			arguments: { facts }
		});
	}
	if (!result.ok) return json(result, { status: 422 });
	if (result.incidentId && !input.open) {
		voiceBus.notify(
			result.incidentId,
			`Sensor "${key.name}" reported: ${result.message}. Mention it only if it matters to the caller.`
		);
	}
	return json({ ok: true, incidentId: result.incidentId, message: result.message });
};
