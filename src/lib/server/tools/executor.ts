import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db';
import * as t from '../db/schema';
import { getIncident, getOrg, getOrgSettings, NotFoundError } from '../incidents/repository';
import { TransitionError } from '$lib/domain/state-machine';
import { HANDLERS, ToolError, type HandlerContext } from './handlers';
import { isToolName, repairToolArguments, TOOL_SCHEMAS, type ToolName } from './schemas';
import type { Origin } from '../incidents/engine';
import { atLeast, ROLE_LABELS, TOOL_MIN_ROLE } from '../auth';
import { log, metrics } from '../observability';
import { flushIfQueued } from '../notifications/outbox';
import type { UserRole } from '$lib/domain/types';

/** Who is acting. Absent for system/scheduler/demo-simulation origins. */
export interface Actor {
	userId: string;
	name: string;
	role: UserRole;
}

export interface ExecuteRequest {
	name: string;
	arguments: unknown;
	origin: Origin;
	/** Tenant boundary: everything this call touches must belong to this organisation. */
	orgId: string;
	actor?: Actor | null;
	/** Display name for non-user callers (a sensor, an acknowledging contact). No role implied. */
	actorName?: string | null;
	incidentId?: string | null;
	voiceSessionId?: string | null;
	callId?: string | null;
	/** Only used when there is no voice session (operator-created incidents, seed data). */
	isDemo?: boolean;
	now?: Date;
	/** Sensor API: device/reading reference recorded on facts. */
	sourceRef?: string | null;
}

export type ExecuteResult =
	| {
			ok: true;
			tool: ToolName;
			incidentId: string | null;
			message: string;
			guidance?: string;
			data?: Record<string, unknown>;
	  }
	| { ok: false; tool: string; incidentId: string | null; error: string };

/**
 * Single entry point for every state change in SENTINEL — the voice relay,
 * the operator UI, the sensor API, the scheduler and the demo simulator all
 * go through here, so tenancy, permissions, validation, transactions and the
 * audit log are identical for each.
 */
export async function executeTool(db: Database, req: ExecuteRequest): Promise<ExecuteResult> {
	const started = Date.now();
	const now = req.now ?? new Date();
	let incidentId = req.incidentId ?? null;
	let isDemoSession = req.isDemo ?? false;
	let sessionStartedAt: Date | null = null;
	let scenario: string | null = null;

	const audit = async (ok: boolean, result: unknown, error: string | null) => {
		metrics.toolCalls.inc({ tool: req.name, origin: req.origin, ok: String(ok) });
		metrics.toolLatency.observe(Date.now() - started, { tool: req.name });
		await db
			.insert(t.toolInvocations)
			.values({
				voiceSessionId: req.voiceSessionId ?? null,
				incidentId,
				userId: req.actor?.userId ?? null,
				callId: req.callId ?? null,
				toolName: req.name,
				origin: req.origin,
				arguments: (req.arguments ?? null) as never,
				result: result as never,
				ok,
				error,
				durationMs: Date.now() - started
			})
			.catch((e) => log.error('tool audit insert failed', { err: e, tool: req.name }));
	};

	if (req.voiceSessionId) {
		const [session] = await db
			.select()
			.from(t.voiceSessions)
			.where(eq(t.voiceSessions.id, req.voiceSessionId));
		if (!session || session.orgId !== req.orgId)
			return fail(req.name, incidentId, 'Unknown voice session.');
		incidentId = incidentId ?? session.incidentId;
		isDemoSession = session.isDemo;
		sessionStartedAt = session.startedAt;
		scenario = session.scenario;
	}
	if (!req.voiceSessionId && req.isDemo === undefined) {
		// Everything created in a demo organisation is demo data (simulated outreach).
		const org = await getOrg(db, req.orgId).catch(() => null);
		if (!org) return fail(req.name, incidentId, 'Unknown organisation.');
		isDemoSession = org.isDemo;
	}
	if (incidentId) {
		// Tenant check before anything else; a foreign incident looks like a missing one.
		const incident = await getIncident(db, incidentId).catch(() => null);
		if (!incident || incident.orgId !== req.orgId) {
			await audit(false, null, 'incident not found in organisation');
			return fail(req.name, null, 'Incident not found.');
		}
	}

	if (!isToolName(req.name)) {
		const error = `Unknown tool "${req.name}".`;
		await audit(false, null, error);
		return fail(req.name, incidentId, error);
	}
	const name = req.name;

	// Role check. Voice calls run with the role of the person speaking.
	if (req.actor && !atLeast(req.actor.role, TOOL_MIN_ROLE[name] ?? 'admin')) {
		const need = ROLE_LABELS[TOOL_MIN_ROLE[name] ?? 'admin'];
		const error = `${req.actor.name} (${ROLE_LABELS[req.actor.role]}) is not allowed to ${name.replace(/_/g, ' ')}. It needs a ${need}. Tell the user this needs a ${need.toLowerCase()} and suggest who to ask.`;
		await audit(false, null, error);
		return fail(name, incidentId, error);
	}

	const { args: repaired, repairs } = repairToolArguments(name, req.arguments ?? {});
	if (repairs.length) log.warn('tool arguments repaired', { tool: name, repairs });
	const parsed = TOOL_SCHEMAS[name].safeParse(repaired);
	if (!parsed.success) {
		const error = `Invalid arguments for ${name}: ${formatZodError(parsed.error)}. Fix only those fields and call again.`;
		await audit(false, null, error);
		return fail(name, incidentId, error);
	}

	const ctx: HandlerContext = {
		origin: req.origin,
		voiceSessionId: req.voiceSessionId ?? null,
		toolName: name,
		now,
		incidentId,
		isDemoSession,
		sessionStartedAt,
		scenario,
		orgId: req.orgId,
		userId: req.actor?.userId ?? null,
		actorName: req.actor?.name ?? req.actorName ?? null,
		sourceRef: req.sourceRef ?? null,
		settings: await getOrgSettings(db, req.orgId)
	};

	try {
		const output = await db.transaction(async (tx) =>
			(
				HANDLERS[name] as (
					db: unknown,
					a: unknown,
					c: HandlerContext
				) => ReturnType<(typeof HANDLERS)[ToolName]>
			)(tx, parsed.data, ctx)
		);
		incidentId = output.incidentId ?? ctx.incidentId;
		await audit(true, { message: output.message }, null);
		// Notifications queued inside the transaction go out only now, after commit.
		void flushIfQueued(db);
		return {
			ok: true,
			tool: name,
			incidentId,
			message: output.message,
			guidance: output.guidance,
			data: output.data
		};
	} catch (err) {
		const error = toUserError(err);
		if (!(
			err instanceof ToolError ||
			err instanceof TransitionError ||
			err instanceof NotFoundError
		)) {
			log.error('tool failed', { tool: name, incidentId, err });
		}
		await audit(false, null, error);
		return fail(name, incidentId, error);
	}
}

function fail(tool: string, incidentId: string | null, error: string): ExecuteResult {
	return { ok: false, tool, incidentId, error };
}

function toUserError(err: unknown): string {
	if (err instanceof ToolError || err instanceof TransitionError || err instanceof NotFoundError) {
		return err.message;
	}
	return 'Internal error while saving. Nothing was changed. Tell the user the record could not be updated.';
}

function formatZodError(error: z.ZodError): string {
	return error.issues
		.slice(0, 5)
		.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
		.join('; ');
}
