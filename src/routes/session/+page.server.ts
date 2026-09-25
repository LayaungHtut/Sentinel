import { error, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { authSessions, memberships } from '$lib/server/db/schema';
import { destroySession, SESSION_COOKIE } from '$lib/server/auth';
import type { Actions, PageServerLoad } from './$types';

export const load: PageServerLoad = async () => redirect(303, '/');

export const actions: Actions = {
	logout: async ({ cookies }) => {
		await destroySession(await getDb(), cookies.get(SESSION_COOKIE), cookies);
		redirect(303, '/login');
	},
	/** Switch the active organisation (the user must be a member of it). */
	switch: async ({ request, locals }) => {
		const auth = locals.auth;
		if (!auth) redirect(303, '/login');
		const orgId = String((await request.formData()).get('orgId') ?? '');
		const db = await getDb();
		const [m] = await db
			.select()
			.from(memberships)
			.where(and(eq(memberships.userId, auth.userId), eq(memberships.orgId, orgId)));
		if (!m) error(403, 'You are not a member of that organisation.');
		await db.update(authSessions).set({ orgId }).where(eq(authSessions.id, auth.sessionId));
		redirect(303, '/');
	}
};
