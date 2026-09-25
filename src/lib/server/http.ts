import { error, json, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { getDb } from './db';
import { rateLimits } from './db/schema';
import { atLeast, type AuthContext } from './auth';
import { log } from './observability';
import type { UserRole } from '$lib/domain/types';

/** RATE_LIMIT_SCALE multiplies every limit (e.g. 0.5 to tighten, 10 for load tests). */
function limitScale(): number {
	const v = Number(process.env.RATE_LIMIT_SCALE ?? 1);
	return Number.isFinite(v) && v > 0 ? v : 1;
}

/**
 * Fixed-window rate limiter backed by Postgres, so every app instance shares
 * the same counters. Keyed by user when signed in, otherwise by client IP.
 * If the database is unreachable the limiter fails open (logged), rather than
 * taking the whole API down with it.
 */
export async function rateLimit(
	event: RequestEvent,
	name: string,
	limit: number,
	windowMs = 60_000
) {
	let who = event.locals.auth?.userId;
	if (!who) {
		try {
			who = event.getClientAddress();
		} catch {
			who = 'unknown';
		}
	}
	const key = `${name}:${who}`;
	const windowStart = new Date(Math.floor(Date.now() / windowMs) * windowMs);
	let count: number;
	try {
		const db = await getDb();
		const [row] = await db
			.insert(rateLimits)
			.values({ key, windowStart, count: 1 })
			.onConflictDoUpdate({
				target: rateLimits.key,
				set: {
					count: sql`case when ${rateLimits.windowStart} = ${windowStart} then ${rateLimits.count} + 1 else 1 end`,
					windowStart
				}
			})
			.returning({ count: rateLimits.count });
		count = row.count;
	} catch (e) {
		log.warn('rate limiter unavailable', { err: e });
		return;
	}
	if (count > limit * limitScale()) {
		const retry = Math.ceil((windowStart.getTime() + windowMs - Date.now()) / 1000);
		error(429, `Too many requests. Try again in ${retry}s.`);
	}
}

/** Require a signed-in user with at least `min` role (401/403 otherwise). */
export function requireRole(event: RequestEvent, min: UserRole): AuthContext {
	const auth = event.locals.auth;
	if (!auth) error(401, 'Sign in required.');
	if (!atLeast(auth.role, min)) error(403, `This needs the ${min} role or higher.`);
	return auth;
}

export function actorOf(auth: AuthContext) {
	return { userId: auth.userId, name: auth.userName, role: auth.role };
}

/** Parse and validate a JSON body; 400 with field errors on failure. */
export async function readJson<S extends z.ZodType>(
	request: Request,
	schema: S
): Promise<z.infer<S>> {
	let body: unknown;
	try {
		const text = await request.text();
		if (text.length > 64_000) error(413, 'Request body too large.');
		body = text ? JSON.parse(text) : {};
	} catch (e) {
		if (e && typeof e === 'object' && 'status' in e) throw e;
		error(400, 'Body must be valid JSON.');
	}
	const parsed = schema.safeParse(body);
	if (!parsed.success) {
		error(
			400,
			parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ')
		);
	}
	return parsed.data;
}

export { json };

export const idParam = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[A-Za-z0-9-]+$/);
