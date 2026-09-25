import { error, fail } from '@sveltejs/kit';
import { randomBytes } from 'node:crypto';
import { and, asc, desc, eq, isNull, ne } from 'drizzle-orm';
import { z } from 'zod';
import { getDb } from '$lib/server/db';
import {
	apiKeys,
	authSessions,
	contacts,
	memberships,
	organizations,
	users
} from '$lib/server/db/schema';
import {
	atLeast,
	findUserByEmail,
	hashPassword,
	newApiKey,
	passwordProblem,
	verifyPassword
} from '$lib/server/auth';
import { configuredChannels } from '$lib/server/notifications/providers';
import { getOrg, getOrgSettings } from '$lib/server/incidents/repository';
import { rateLimit } from '$lib/server/http';
import { log } from '$lib/server/observability';
import { orgSettingsSchema } from '$lib/domain/org-settings';
import { CONTACT_ROLE_LABELS } from '$lib/domain/playbooks';
import { CONTACT_ROLES, USER_ROLES, type UserRole } from '$lib/domain/types';
import type { Actions, PageServerLoad, RequestEvent } from './$types';

const CONTACT_CHANNELS = ['none', 'sms', 'voice_call', 'email', 'slack', 'webhook'] as const;

function need(event: RequestEvent, min: UserRole) {
	const auth = event.locals.auth;
	if (!auth) error(401, 'Sign in required.');
	if (!atLeast(auth.role, min)) error(403, `This needs the ${min} role or higher.`);
	return auth;
}

function fields(form: FormData) {
	return Object.fromEntries(
		[...form.entries()].map(([k, v]) => [k, typeof v === 'string' ? v.trim() : ''])
	);
}

export const load: PageServerLoad = async (event) => {
	const auth = need(event, 'reporter');
	const db = await getDb();
	const isAdmin = auth.role === 'admin';
	const canContacts = atLeast(auth.role, 'manager');
	const [org, settings, members, contactRows, keys] = await Promise.all([
		getOrg(db, auth.orgId),
		getOrgSettings(db, auth.orgId),
		isAdmin
			? db
					.select({
						userId: users.id,
						name: users.name,
						email: users.email,
						role: memberships.role,
						disabled: users.disabledAt
					})
					.from(memberships)
					.innerJoin(users, eq(users.id, memberships.userId))
					.where(eq(memberships.orgId, auth.orgId))
					.orderBy(asc(users.name))
			: [],
		canContacts
			? db.select().from(contacts).where(eq(contacts.orgId, auth.orgId)).orderBy(asc(contacts.name))
			: [],
		isAdmin
			? db
					.select({
						id: apiKeys.id,
						name: apiKeys.name,
						prefix: apiKeys.prefix,
						lastUsedAt: apiKeys.lastUsedAt,
						createdAt: apiKeys.createdAt
					})
					.from(apiKeys)
					.where(and(eq(apiKeys.orgId, auth.orgId), isNull(apiKeys.revokedAt)))
					.orderBy(desc(apiKeys.createdAt))
			: []
	]);
	return {
		role: auth.role,
		userId: auth.userId,
		orgName: org?.name ?? auth.orgName,
		orgIsDemo: auth.orgIsDemo,
		settings,
		members: members.map((m) => ({ ...m, disabled: m.disabled !== null })),
		contacts: contactRows.map((c) => ({
			id: c.id,
			name: c.name,
			role: c.role,
			roleLabel: c.roleLabel,
			site: c.site,
			organization: c.organization,
			channel: c.notificationChannel,
			phone: c.phone,
			email: c.email,
			onCall: c.onCall
		})),
		apiKeys: keys.map((k) => ({
			...k,
			lastUsedAt: k.lastUsedAt?.toISOString() ?? null,
			createdAt: k.createdAt.toISOString()
		})),
		configuredChannels: configuredChannels(),
		contactRoles: CONTACT_ROLES.map((r) => ({ id: r, label: CONTACT_ROLE_LABELS[r] })),
		userRoles: USER_ROLES,
		channels: CONTACT_CHANNELS
	};
};

const policyForm = z.object({
	responseTimeoutMinutes: z.coerce
		.number()
		.min(0.5)
		.max(24 * 60),
	retentionDays: z.coerce.number().int().min(0).max(3650),
	voiceMaxConcurrent: z.coerce.number().int().min(0).max(100),
	voiceDailyMinutes: z.coerce.number().int().min(0).max(100000),
	deleteProviderRecordings: z.string().optional()
});

const contactForm = z.object({
	id: z.string().max(64).optional(),
	name: z.string().min(1).max(80),
	role: z.enum(CONTACT_ROLES),
	site: z.string().max(120).optional(),
	organization: z.string().max(120).optional(),
	channel: z.enum(CONTACT_CHANNELS),
	phone: z
		.string()
		.regex(/^(\+[1-9]\d{6,14})?$/, 'Phone must be in international format, e.g. +14155550100')
		.optional(),
	email: z.union([z.literal(''), z.email()]).optional(),
	onCall: z.string().optional()
});

export const actions: Actions = {
	policy: async (event) => {
		const auth = need(event, 'admin');
		const parsed = policyForm.safeParse(fields(await event.request.formData()));
		if (!parsed.success)
			return fail(400, { section: 'policy', error: parsed.error.issues[0].message });
		const db = await getDb();
		const org = await getOrg(db, auth.orgId);
		const next = orgSettingsSchema.parse({
			...(org?.settings ?? {}),
			responseTimeoutSeconds: Math.round(parsed.data.responseTimeoutMinutes * 60),
			retentionDays: parsed.data.retentionDays,
			voiceMaxConcurrent: parsed.data.voiceMaxConcurrent,
			voiceDailyMinutes: parsed.data.voiceDailyMinutes,
			deleteProviderRecordings: parsed.data.deleteProviderRecordings === 'on'
		});
		await db.update(organizations).set({ settings: next }).where(eq(organizations.id, auth.orgId));
		log.info('org policy updated', { orgId: auth.orgId, userId: auth.userId });
		return { section: 'policy', ok: 'Policy saved.' };
	},

	addMember: async (event) => {
		const auth = need(event, 'admin');
		await rateLimit(event, 'add-member', 20);
		const f = fields(await event.request.formData());
		const email = (f.email ?? '').slice(0, 200);
		const name = (f.name ?? '').slice(0, 120);
		const role = f.role as UserRole;
		if (!/^[^@\s]+@[^@\s]+$/.test(email) || !USER_ROLES.includes(role)) {
			return fail(400, { section: 'members', error: 'A valid email and role are required.' });
		}
		const db = await getDb();
		let user = await findUserByEmail(db, email);
		let tempPassword: string | null = null;
		if (!user) {
			if (!name)
				return fail(400, { section: 'members', error: 'Name is required for a new account.' });
			tempPassword = randomBytes(12).toString('base64url');
			[user] = await db
				.insert(users)
				.values({ email, name, passwordHash: await hashPassword(tempPassword) })
				.returning();
		}
		const inserted = await db
			.insert(memberships)
			.values({ userId: user.id, orgId: auth.orgId, role })
			.onConflictDoNothing()
			.returning();
		if (!inserted.length)
			return fail(409, { section: 'members', error: `${email} is already a member.` });
		log.info('member added', { orgId: auth.orgId, by: auth.userId, userId: user.id, role });
		return {
			section: 'members',
			ok: tempPassword
				? `Account created for ${email}. Give them this one-time password over a secure channel; it is shown only once and they should change it after signing in.`
				: `${email} added.`,
			tempPassword
		};
	},

	setRole: async (event) => {
		const auth = need(event, 'admin');
		const f = fields(await event.request.formData());
		const role = f.role as UserRole;
		if (!USER_ROLES.includes(role))
			return fail(400, { section: 'members', error: 'Unknown role.' });
		if (f.userId === auth.userId)
			return fail(400, { section: 'members', error: "You can't change your own role." });
		await (
			await getDb()
		)
			.update(memberships)
			.set({ role })
			.where(and(eq(memberships.orgId, auth.orgId), eq(memberships.userId, f.userId ?? '')));
		return { section: 'members', ok: 'Role updated.' };
	},

	removeMember: async (event) => {
		const auth = need(event, 'admin');
		const f = fields(await event.request.formData());
		if (f.userId === auth.userId)
			return fail(400, { section: 'members', error: "You can't remove yourself." });
		await (
			await getDb()
		)
			.delete(memberships)
			.where(and(eq(memberships.orgId, auth.orgId), eq(memberships.userId, f.userId ?? '')));
		return { section: 'members', ok: 'Member removed.' };
	},

	saveContact: async (event) => {
		const auth = need(event, 'manager');
		const parsed = contactForm.safeParse(fields(await event.request.formData()));
		if (!parsed.success)
			return fail(400, { section: 'contacts', error: parsed.error.issues[0].message });
		const c = parsed.data;
		if ((c.channel === 'sms' || c.channel === 'voice_call') && !c.phone) {
			return fail(400, { section: 'contacts', error: 'SMS and phone calls need a phone number.' });
		}
		if (c.channel === 'email' && !c.email) {
			return fail(400, {
				section: 'contacts',
				error: 'Email notifications need an email address.'
			});
		}
		const values = {
			name: c.name,
			role: c.role,
			roleLabel: CONTACT_ROLE_LABELS[c.role],
			site: c.site || null,
			organization: c.organization || auth.orgName,
			notificationChannel: c.channel,
			phone: c.phone || null,
			email: c.email || null,
			onCall: c.onCall === 'on',
			isDemo: auth.orgIsDemo
		};
		const db = await getDb();
		if (c.id) {
			await db
				.update(contacts)
				.set(values)
				.where(and(eq(contacts.id, c.id), eq(contacts.orgId, auth.orgId)));
		} else {
			await db.insert(contacts).values({ ...values, orgId: auth.orgId });
		}
		return { section: 'contacts', ok: `${c.name} saved.` };
	},

	deleteContact: async (event) => {
		const auth = need(event, 'manager');
		const f = fields(await event.request.formData());
		await (
			await getDb()
		)
			.delete(contacts)
			.where(and(eq(contacts.id, f.id ?? ''), eq(contacts.orgId, auth.orgId)));
		return { section: 'contacts', ok: 'Contact removed.' };
	},

	createKey: async (event) => {
		const auth = need(event, 'admin');
		await rateLimit(event, 'api-keys', 10);
		const name = fields(await event.request.formData()).name?.slice(0, 80);
		if (!name)
			return fail(400, { section: 'keys', error: 'Name the key after the device or integration.' });
		const k = newApiKey();
		await (await getDb()).insert(apiKeys).values({
			orgId: auth.orgId,
			name,
			keyHash: k.hash,
			prefix: k.prefix,
			createdBy: auth.userId
		});
		log.info('api key created', { orgId: auth.orgId, by: auth.userId, prefix: k.prefix });
		return { section: 'keys', ok: 'Copy this key now. It will not be shown again.', apiKey: k.key };
	},

	revokeKey: async (event) => {
		const auth = need(event, 'admin');
		const f = fields(await event.request.formData());
		await (
			await getDb()
		)
			.update(apiKeys)
			.set({ revokedAt: new Date() })
			.where(and(eq(apiKeys.id, f.id ?? ''), eq(apiKeys.orgId, auth.orgId)));
		return { section: 'keys', ok: 'Key revoked.' };
	},

	password: async (event) => {
		const auth = need(event, 'reporter');
		await rateLimit(event, 'password', 5);
		const f = fields(await event.request.formData());
		const db = await getDb();
		const [u] = await db.select().from(users).where(eq(users.id, auth.userId));
		if (!u?.passwordHash)
			return fail(400, { section: 'account', error: 'This account has no password.' });
		if (!(await verifyPassword(f.current ?? '', u.passwordHash))) {
			return fail(400, { section: 'account', error: 'Current password is incorrect.' });
		}
		const problem = passwordProblem(f.next ?? '');
		if (problem) return fail(400, { section: 'account', error: problem });
		await db
			.update(users)
			.set({ passwordHash: await hashPassword(f.next!) })
			.where(eq(users.id, u.id));
		// Sign out every other session for this user.
		await db
			.delete(authSessions)
			.where(and(eq(authSessions.userId, u.id), ne(authSessions.id, auth.sessionId)));
		return { section: 'account', ok: 'Password changed.' };
	}
};
