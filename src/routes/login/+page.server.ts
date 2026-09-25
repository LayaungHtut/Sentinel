import { fail, redirect } from '@sveltejs/kit';
import { and, eq, sql } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import { getDb } from '$lib/server/db';
import { memberships, users } from '$lib/server/db/schema';
import { createSession, findUserByEmail, firstMembership, verifyPassword } from '$lib/server/auth';
import { DEMO_ORG_ID } from '$lib/server/demo/seed';
import { rateLimit } from '$lib/server/http';
import { log } from '$lib/server/observability';
import type { Actions, PageServerLoad } from './$types';

const DEMO_EMAIL = 'demo@sentinel.invalid';
/** Well-formed but unmatchable hash, so unknown emails cost the same scrypt time. */
const DUMMY_HASH = `scrypt$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;

/** Only allow same-site relative redirects after sign-in. */
function safeNext(next: string | null): string {
	return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\')
		? next
		: '/';
}

export const load: PageServerLoad = async ({ locals, url }) => {
	if (locals.auth) redirect(303, safeNext(url.searchParams.get('next')));
	const db = await getDb();
	const [{ n }] = await db
		.select({ n: sql<number>`count(*)::int` })
		.from(users)
		.where(sql`${users.passwordHash} is not null`);
	const demoLoginEnabled = env.DEMO_LOGIN_ENABLED === 'true';
	if (n === 0 && !demoLoginEnabled) redirect(303, '/setup');
	return { demoLoginEnabled, needsSetup: n === 0 };
};

export const actions: Actions = {
	login: async (event) => {
		await rateLimit(event, 'login', 10);
		const form = await event.request.formData();
		const email = String(form.get('email') ?? '').slice(0, 200);
		const password = String(form.get('password') ?? '').slice(0, 200);
		const db = await getDb();
		const user = await findUserByEmail(db, email);
		const ok = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
		if (!user || !ok || user.disabledAt) {
			log.info('sign-in failed', { requestId: event.locals.requestId });
			return fail(400, { email, error: 'Email or password is incorrect.' });
		}
		const m = await firstMembership(db, user.id);
		if (!m) return fail(403, { email, error: 'This account is not a member of any organisation.' });
		await createSession(db, user.id, m.orgId, event.cookies, event.url.protocol === 'https:');
		log.info('signed in', { userId: user.id, orgId: m.orgId });
		redirect(303, safeNext(event.url.searchParams.get('next')));
	},

	/** Opt-in (DEMO_LOGIN_ENABLED=true): a shared account inside the fictional demo organisation only. */
	demo: async (event) => {
		if (env.DEMO_LOGIN_ENABLED !== 'true')
			return fail(403, { email: '', error: 'Demo sign-in is disabled.' });
		await rateLimit(event, 'login', 10);
		const db = await getDb();
		let user = await findUserByEmail(db, DEMO_EMAIL);
		if (!user) {
			await db
				.insert(users)
				.values({ email: DEMO_EMAIL, name: 'Demo operator', passwordHash: null })
				.onConflictDoNothing();
			user = (await findUserByEmail(db, DEMO_EMAIL))!;
		}
		const [m] = await db
			.select()
			.from(memberships)
			.where(and(eq(memberships.userId, user.id), eq(memberships.orgId, DEMO_ORG_ID)));
		if (!m) {
			await db
				.insert(memberships)
				.values({ userId: user.id, orgId: DEMO_ORG_ID, role: 'admin' })
				.onConflictDoNothing();
		}
		await createSession(db, user.id, DEMO_ORG_ID, event.cookies, event.url.protocol === 'https:');
		redirect(303, safeNext(event.url.searchParams.get('next')));
	}
};
