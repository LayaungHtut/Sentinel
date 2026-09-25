import { eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { memberships, organizations } from '$lib/server/db/schema';
import type { LayoutServerLoad } from './$types';

/** The signed-in user, their active organisation and role (null on public pages). */
export const load: LayoutServerLoad = async ({ locals }) => {
	const auth = locals.auth;
	if (!auth) return { user: null };
	const orgs = await (
		await getDb()
	)
		.select({ id: organizations.id, name: organizations.name, role: memberships.role })
		.from(memberships)
		.innerJoin(organizations, eq(organizations.id, memberships.orgId))
		.where(eq(memberships.userId, auth.userId));
	return {
		user: {
			id: auth.userId,
			name: auth.userName,
			email: auth.email,
			role: auth.role,
			orgId: auth.orgId,
			orgName: auth.orgName,
			orgIsDemo: auth.orgIsDemo,
			voiceConsented: auth.voiceConsentAt !== null,
			orgs
		}
	};
};
