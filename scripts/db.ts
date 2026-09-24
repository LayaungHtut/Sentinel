/**
 * Database CLI: `npm run db:migrate` | `npm run db:seed` | `npm run db:reset`
 * Uses DATABASE_URL when set, otherwise the embedded PGlite database.
 */
import { createDb } from '../src/lib/server/db/index';
import { seedDatabase } from '../src/lib/server/demo/seed';

const command = process.argv[2] ?? 'migrate';
const handle = await createDb({
	databaseUrl: process.env.DATABASE_URL || undefined,
	pgliteDataDir: process.env.PGLITE_DATA_DIR || undefined
});
console.log(`[db] connected (${handle.driver}), migrations applied`);
if (command === 'seed') {
	console.log('[db] seed:', await seedDatabase(handle.db));
} else if (command === 'reset') {
	console.log('[db] reset + seed:', await seedDatabase(handle.db, { reset: true }));
}
await handle.close();
