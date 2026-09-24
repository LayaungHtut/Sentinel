import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { Database } from '../db';
import * as t from '../db/schema';
import { NotFoundError } from '../incidents/repository';
import { TransitionError } from '$lib/domain/state-machine';
import { HANDLERS, ToolError, type HandlerContext } from './handlers';
import { isToolName, repairToolArguments, TOOL_SCHEMAS, type ToolName } from './schemas';
import type { Origin } from '../incidents/engine';

export interface ExecuteRequest {
	name: string;
	arguments: unknown;
	origin: Origin;
	incidentId?: string | null;
	voiceSessionId?: string | null;
	callId?: string | null;
	/** Only used when there is no voice session (operator-created incidents, seed data). */
	isDemo?: boolean;
	now?: Date;
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
 * Single entry point for every state change in SENTINEL — voice agent,
 * operator UI and demo simulator all go through here, so validation,
 * transactions and the audit log are identical for each.
 */
export async function executeTool(db: Database, req: ExecuteRequest): Promise<ExecuteResult> {
	const started = Date.now();
	const now = req.now ?? new Date();
	let incidentId = req.incidentId ?? null;
	let isDemoSession = req.isDemo ?? false;
	let sessionStartedAt: Date | null = null;
	let scenario: string | null = null;

	if (req.voiceSessionId) {
		const [session] = await db
			.select()
			.from(t.voiceSessions)
			.where(eq(t.voiceSessions.id, req.voiceSessionId));
		if (!session) return fail(req.name, incidentId, 'Unknown voice session.');
		incidentId = incidentId ?? session.incidentId;
		isDemoSession = session.isDemo;
		sessionStartedAt = session.startedAt;
		scenario = session.scenario;
	}

	const audit = async (ok: boolean, result: unknown, error: string | null) => {
		await db
			.insert(t.toolInvocations)
			.values({
				voiceSessionId: req.voiceSessionId ?? null,
				incidentId,
				callId: req.callId ?? null,
				toolName: req.name,
				origin: req.origin,
				arguments: (req.arguments ?? null) as never,
				result: result as never,
				ok,
				error,
				durationMs: Date.now() - started
			})
			.catch((e) => console.error('[tools] audit insert failed', e));
	};

	if (!isToolName(req.name)) {
		const error = `Unknown tool "${req.name}".`;
		await audit(false, null, error);
		return fail(req.name, incidentId, error);
	}
	const name = req.name;
	const { args: repaired, repairs } = repairToolArguments(name, req.arguments ?? {});
	if (repairs.length) console.warn(`[tools] ${name}: repaired ${repairs.join('; ')}`);
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
		scenario
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
		const result: ExecuteResult = {
			ok: true,
			tool: name,
			incidentId,
			message: output.message,
			guidance: output.guidance,
			data: output.data
		};
		await audit(true, { message: output.message }, null);
		return result;
	} catch (err) {
		const error = toUserError(err);
		if (!(
			err instanceof ToolError ||
			err instanceof TransitionError ||
			err instanceof NotFoundError
		)) {
			console.error(`[tools] ${name} failed`, err);
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
