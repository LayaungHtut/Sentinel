import { existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import * as schema from './schema';

/**
 * One Drizzle database, three PostgreSQL drivers:
 *  - DATABASE_URL set    → node-postgres against a real server (Neon, Supabase, Docker, …)
 *  - on Netlify          → Netlify Database (migrations are applied by the platform at deploy)
 *  - otherwise           → PGlite, an embedded PostgreSQL (WASM) persisted to .data/pglite
 * All speak the same SQL and run the same migrations.
 */
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>;

export interface DbHandle {
	db: Database;
	driver: 'postgres' | 'netlify' | 'pglite';
	close: () => Promise<void>;
}

let handlePromise: Promise<DbHandle> | null = null;

export function migrationsFolder(): string {
	const candidates = [
		resolve(process.cwd(), 'drizzle'),
		resolve(import.meta.dirname ?? '.', '../../../../drizzle')
	];
	return candidates.find((p) => existsSync(p)) ?? candidates[0];
}

/**
 * Netlify Database: the platform applies netlify/database/migrations before each deploy
 * is published, so no runtime migration happens here.
 */
async function createNetlifyDb(): Promise<DbHandle> {
	const { getDatabase } = await import('@netlify/database');
	const conn = getDatabase();
	if (conn.driver === 'serverless') {
		const { drizzle } = await import('drizzle-orm/neon-serverless');
		const db = drizzle(conn.pool, { schema });
		return { db: db as unknown as Database, driver: 'netlify', close: () => conn.pool.end() };
	}
	const { drizzle } = await import('drizzle-orm/node-postgres');
	const db = drizzle(conn.pool, { schema });
	return { db: db as unknown as Database, driver: 'netlify', close: () => conn.pool.end() };
}

export async function createDb(options: {
	databaseUrl?: string;
	/** Use Netlify Database (ignored when databaseUrl is set). */
	netlify?: boolean;
	pgliteDataDir?: string;
	migrate?: boolean;
	/** node-postgres pool size (default 10, or PG_POOL_MAX). */
	poolMax?: number;
}): Promise<DbHandle> {
	const doMigrate = options.migrate ?? true;
	if (options.databaseUrl) {
		const { default: pg } = await import('pg');
		const { drizzle } = await import('drizzle-orm/node-postgres');
		const pool = new pg.Pool({
			connectionString: options.databaseUrl,
			max: options.poolMax ?? (Number(process.env.PG_POOL_MAX) || 10)
		});
		const db = drizzle(pool, { schema });
		if (doMigrate) {
			const { migrate } = await import('drizzle-orm/node-postgres/migrator');
			await migrate(db, { migrationsFolder: migrationsFolder() });
		}
		return { db: db as unknown as Database, driver: 'postgres', close: () => pool.end() };
	}
	if (options.netlify) return createNetlifyDb();
	const { PGlite } = await import('@electric-sql/pglite');
	const { drizzle } = await import('drizzle-orm/pglite');
	const dataDir = options.pgliteDataDir ?? '.data/pglite';
	if (dataDir !== 'memory://') mkdirSync(resolve(dataDir), { recursive: true });
	const client = dataDir === 'memory://' ? new PGlite() : new PGlite(dataDir);
	const db = drizzle(client, { schema });
	if (doMigrate) {
		const { migrate } = await import('drizzle-orm/pglite/migrator');
		await migrate(db, { migrationsFolder: migrationsFolder() });
	}
	return { db: db as unknown as Database, driver: 'pglite', close: () => client.close() };
}

/** Lazily-initialised process-wide database (migrations applied on first use). */
export function getDbHandle(): Promise<DbHandle> {
	if (!handlePromise) {
		handlePromise = createDb({
			databaseUrl: process.env.DATABASE_URL || undefined,
			netlify: !!process.env.NETLIFY_DB_URL,
			pgliteDataDir: process.env.PGLITE_DATA_DIR || undefined
		}).catch((err) => {
			handlePromise = null;
			throw err;
		});
	}
	return handlePromise;
}

export async function getDb(): Promise<Database> {
	return (await getDbHandle()).db;
}

export { schema };
