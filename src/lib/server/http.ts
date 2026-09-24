import { error, json, type RequestEvent } from '@sveltejs/kit';
import { z } from 'zod';

/**
 * Fixed-window in-memory rate limiter. Adequate for a single-process local
 * deployment; swap for a shared store if SENTINEL is ever horizontally scaled.
 */
const buckets = new Map<string, { count: number; resetAt: number }>();

export function rateLimit(event: RequestEvent, name: string, limit: number, windowMs = 60_000) {
	let ip = 'unknown';
	try {
		ip = event.getClientAddress();
	} catch {
		/* not available in some adapters/tests */
	}
	const key = `${name}:${ip}`;
	const now = Date.now();
	const bucket = buckets.get(key);
	if (!bucket || bucket.resetAt <= now) {
		buckets.set(key, { count: 1, resetAt: now + windowMs });
		return;
	}
	bucket.count++;
	if (bucket.count > limit) {
		error(429, `Too many requests. Try again in ${Math.ceil((bucket.resetAt - now) / 1000)}s.`);
	}
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
