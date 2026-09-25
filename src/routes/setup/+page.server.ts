import { error, fail, redirect } from '@sveltejs/kit';
import { sql } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { memberships, organizations, users } from '$lib/server/db/schema';
import { createSession, hashPassword, passwordProblem } from '$lib/server/auth';
import { rateLimit } from '$lib/server/http';
import { log } from '$lib/server/observability';
import type { Actions, PageServerLoad } from './$types';

/** Accounts with a password (the opt-in demo operator has none). */
const realUsers = sql<number>`count(*)::int`;

/** First-run bootstrap: available only until the first real account exists. */
export const load: PageServerLoad = async () => {
	const [{ n }] = await (
		await getDb()
	)
		.select({ n: realUsers })
		.from(users)
		.where(sql`${users.passwordHash} is not null`);
	if (n > 0) redirect(303, '/login');
	return {};
};

function slugify(s: string) {
	return (
		s
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '-')
			.replace(/^-|-$/g, '')
			.slice(0, 40) || 'org'
	);
}

export const actions: Actions = {
	default: async (event) => {
		await rateLimit(event, 'setup', 5);
		const form = await event.request.formData();
		const orgName = String(form.get('orgName') ?? '')
			.trim()
			.slice(0, 120);
		const name = String(form.get('name') ?? '')
			.trim()
			.slice(0, 120);
		const email = String(form.get('email') ?? '')
			.trim()
			.slice(0, 200);
		const password = String(form.get('password') ?? '');
		const values = { orgName, name, email };
		if (!orgName || !name || !/^[^@\s]+@[^@\s]+$/.test(email)) {
			return fail(400, { ...values, error: 'Organisation, name and a valid email are required.' });
		}
		const problem = passwordProblem(password);
		if (problem) return fail(400, { ...values, error: problem });

		const db = await getDb();
		const passwordHash = await hashPassword(password);
		const created = await db.transaction(async (tx) => {
			// Serialise concurrent bootstrap attempts; only the first can win.
			await tx.execute(sql`select pg_advisory_xact_lock(71000002)`);
			const [{ n }] = await tx
				.select({ n: realUsers })
				.from(users)
				.where(sql`${users.passwordHash} is not null`);
			if (n > 0) return null;
			const [org] = await tx
				.insert(organizations)
				.values({
					name: orgName,
					slug: `${slugify(orgName)}-${crypto.randomUUID().slice(0, 6)}`,
					settings: {}
				})
				.returning();
			const [user] = await tx.insert(users).values({ email, name, passwordHash }).returning();
			await tx.insert(memberships).values({ userId: user.id, orgId: org.id, role: 'admin' });
			return { user, org };
		});
		if (!created) error(409, 'Setup has already been completed.');
		log.info('bootstrap administrator created', { userId: created.user.id, orgId: created.org.id });
		await createSession(
			db,
			created.user.id,
			created.org.id,
			event.cookies,
			event.url.protocol === 'https:'
		);
		redirect(303, '/settings');
	}
};
