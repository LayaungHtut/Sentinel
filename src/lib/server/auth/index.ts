import { randomBytes, scrypt as scryptCb, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { and, eq, gt, lt, sql } from 'drizzle-orm';
import type { Cookies } from '@sveltejs/kit';
import type { Database } from '../db';
import * as t from '../db/schema';
import { sha256Hex } from '../db/crypto';
import { USER_ROLES, type UserRole } from '$lib/domain/types';

const scrypt = promisify(scryptCb) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;

export const SESSION_COOKIE = 'sentinel_session';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

// ─── Passwords ───────────────────────────────────────────────────────────────

export async function hashPassword(password: string): Promise<string> {
	const salt = randomBytes(16);
	const hash = await scrypt(password.normalize('NFKC'), salt, 64);
	return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}

export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
	if (!stored?.startsWith('scrypt$')) return false;
	const [, saltB64, hashB64] = stored.split('$');
	const expected = Buffer.from(hashB64, 'base64');
	const actual = await scrypt(
		password.normalize('NFKC'),
		Buffer.from(saltB64, 'base64'),
		expected.length
	);
	return timingSafeEqual(expected, actual);
}

export function passwordProblem(password: string): string | null {
	if (password.length < 12) return 'Use at least 12 characters.';
	if (password.length > 200) return 'Password is too long.';
	return null;
}

// ─── Roles & permissions ─────────────────────────────────────────────────────

export const ROLE_RANK: Record<UserRole, number> = Object.fromEntries(
	USER_ROLES.map((r, i) => [r, i])
) as Record<UserRole, number>;

export function atLeast(role: UserRole, min: UserRole): boolean {
	return ROLE_RANK[role] >= ROLE_RANK[min];
}

/**
 * Minimum role per tool. Voice tool calls run with the role of the person
 * speaking, so a reporter's voice session can describe an incident but cannot
 * close it or clear an escalation.
 */
export const TOOL_MIN_ROLE: Record<string, UserRole> = {
	create_incident: 'reporter',
	add_fact: 'reporter',
	mark_fact_uncertain: 'reporter',
	mark_fact_confirmed: 'reporter',
	request_information: 'reporter',
	add_timeline_event: 'reporter',
	record_response: 'reporter',
	generate_incident_report: 'reporter',
	add_action: 'coordinator',
	update_action: 'coordinator',
	update_incident: 'coordinator',
	create_escalation: 'coordinator',
	resolve_escalation: 'manager',
	close_incident: 'manager'
};

export const ROLE_LABELS: Record<UserRole, string> = {
	reporter: 'Reporter',
	coordinator: 'Coordinator',
	manager: 'Manager',
	admin: 'Administrator'
};

// ─── Sessions ────────────────────────────────────────────────────────────────

export interface AuthContext {
	userId: string;
	userName: string;
	email: string;
	orgId: string;
	orgName: string;
	orgIsDemo: boolean;
	role: UserRole;
	voiceConsentAt: Date | null;
	sessionId: string;
}

export async function createSession(
	db: Database,
	userId: string,
	orgId: string,
	cookies: Cookies,
	secure: boolean
) {
	const token = randomBytes(32).toString('base64url');
	const expiresAt = new Date(Date.now() + SESSION_TTL_MS);
	await db.insert(t.authSessions).values({ id: sha256Hex(token), userId, orgId, expiresAt });
	cookies.set(SESSION_COOKIE, token, {
		path: '/',
		httpOnly: true,
		sameSite: 'lax',
		secure,
		expires: expiresAt
	});
}

export async function destroySession(db: Database, token: string | undefined, cookies: Cookies) {
	if (token) await db.delete(t.authSessions).where(eq(t.authSessions.id, sha256Hex(token)));
	cookies.delete(SESSION_COOKIE, { path: '/' });
}

/** Resolve a session token to the user, active organisation and role. Slides expiry. */
export async function resolveSession(
	db: Database,
	token: string | undefined
): Promise<AuthContext | null> {
	if (!token || token.length > 200) return null;
	const id = sha256Hex(token);
	const [row] = await db
		.select({
			sessionId: t.authSessions.id,
			expiresAt: t.authSessions.expiresAt,
			userId: t.users.id,
			userName: t.users.name,
			email: t.users.email,
			disabledAt: t.users.disabledAt,
			voiceConsentAt: t.users.voiceConsentAt,
			orgId: t.organizations.id,
			orgName: t.organizations.name,
			orgIsDemo: t.organizations.isDemo,
			role: t.memberships.role
		})
		.from(t.authSessions)
		.innerJoin(t.users, eq(t.users.id, t.authSessions.userId))
		.innerJoin(t.organizations, eq(t.organizations.id, t.authSessions.orgId))
		.innerJoin(
			t.memberships,
			and(eq(t.memberships.userId, t.users.id), eq(t.memberships.orgId, t.organizations.id))
		)
		.where(and(eq(t.authSessions.id, id), gt(t.authSessions.expiresAt, new Date())));
	if (!row || row.disabledAt) return null;
	// Sliding expiry: extend when less than half the TTL remains.
	if (row.expiresAt.getTime() - Date.now() < SESSION_TTL_MS / 2) {
		await db
			.update(t.authSessions)
			.set({ expiresAt: new Date(Date.now() + SESSION_TTL_MS) })
			.where(eq(t.authSessions.id, id));
	}
	return {
		userId: row.userId,
		userName: row.userName,
		email: row.email,
		orgId: row.orgId,
		orgName: row.orgName,
		orgIsDemo: row.orgIsDemo,
		role: row.role as UserRole,
		voiceConsentAt: row.voiceConsentAt,
		sessionId: row.sessionId
	};
}

export async function purgeExpiredSessions(db: Database) {
	await db.delete(t.authSessions).where(lt(t.authSessions.expiresAt, new Date()));
}

export async function findUserByEmail(db: Database, email: string) {
	const [u] = await db
		.select()
		.from(t.users)
		.where(sql`lower(${t.users.email}) = lower(${email.trim()})`);
	return u ?? null;
}

/** First membership of a user (login lands in their first organisation). */
export async function firstMembership(db: Database, userId: string) {
	const [m] = await db
		.select()
		.from(t.memberships)
		.where(eq(t.memberships.userId, userId))
		.limit(1);
	return m ?? null;
}

// ─── API keys (sensors / integrations) ──────────────────────────────────────

export function newApiKey(): { key: string; prefix: string; hash: string } {
	const key = `snt_${randomBytes(24).toString('base64url')}`;
	return { key, prefix: key.slice(0, 10), hash: sha256Hex(key) };
}

export async function resolveApiKey(db: Database, header: string | null) {
	const key = header?.replace(/^Bearer\s+/i, '').trim();
	if (!key?.startsWith('snt_')) return null;
	const [row] = await db
		.select()
		.from(t.apiKeys)
		.where(and(eq(t.apiKeys.keyHash, sha256Hex(key)), sql`${t.apiKeys.revokedAt} is null`));
	if (!row) return null;
	await db.update(t.apiKeys).set({ lastUsedAt: new Date() }).where(eq(t.apiKeys.id, row.id));
	return row;
}
