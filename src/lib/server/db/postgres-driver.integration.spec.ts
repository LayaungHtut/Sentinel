import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PGlite } from '@electric-sql/pglite';
import { PGLiteSocketServer } from '@electric-sql/pglite-socket';
import { createDb, type DbHandle } from './index';
import { seedDatabase } from '../demo/seed';
import { executeTool } from '../tools/executor';
import { loadSnapshot } from '../incidents/repository';

/**
 * Exercises the DATABASE_URL path (node-postgres over the PostgreSQL wire
 * protocol) without needing Docker: PGlite is exposed on a local socket and
 * the app connects to it exactly as it would to a hosted PostgreSQL.
 */
let pglite: PGlite;
let server: PGLiteSocketServer;
let h: DbHandle;

beforeAll(async () => {
	pglite = await PGlite.create();
	server = new PGLiteSocketServer({ db: pglite, port: 0, host: '127.0.0.1' });
	await server.start();
	const port = Number(server.getServerConn().split(':').pop());
	// pglite-socket serves one connection at a time; a real server uses the default pool.
	h = await createDb({
		databaseUrl: `postgres://postgres@127.0.0.1:${port}/postgres?sslmode=disable`,
		poolMax: 1
	});
});

afterAll(async () => {
	await h?.close();
	await server?.stop();
	await pglite?.close();
});

describe('node-postgres driver (DATABASE_URL)', () => {
	it('applies migrations, seeds and runs the tool pipeline', async () => {
		expect(h.driver).toBe('postgres');
		expect((await seedDatabase(h.db)).seeded).toBe(true);
		const res = await executeTool(h.db, {
			name: 'create_incident',
			origin: 'operator',
			arguments: {
				title: 'Freezer down',
				type: 'refrigeration_failure',
				facts: [
					{
						key: 'temperature',
						value: '12°C',
						numeric_value: 12,
						unit: 'C',
						certainty: 'exact',
						basis: 'stated'
					}
				]
			}
		});
		expect(res.ok).toBe(true);
		const snap = await loadSnapshot(h.db, res.incidentId!);
		expect(snap.incident.code).toBe('INC-0042');
		expect(snap.facts[0].numericValue).toBe(12);
	});

	it('enforces CHECK constraints at the database layer', async () => {
		const { sql } = await import('drizzle-orm');
		await expect(h.db.execute(sql`update incidents set status = 'exploded'`)).rejects.toThrow();
	});
});
