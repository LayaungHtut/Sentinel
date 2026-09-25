import { json } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { getDbHandle } from '$lib/server/db';
import type { RequestHandler } from './$types';

/** Readiness: the database answers a query (use for load-balancer health checks). */
export const GET: RequestHandler = async () => {
	try {
		const { db } = await getDbHandle();
		await db.execute(sql`select 1`);
		return json({ ok: true });
	} catch {
		return json({ ok: false, error: 'database unavailable' }, { status: 503 });
	}
};
