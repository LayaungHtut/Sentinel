import { defineConfig } from 'drizzle-kit';

// Migrations are generated from the schema and are driver-agnostic SQL.
// `npm run db:generate` only needs the schema; applying happens at app start
// (or via `npm run db:migrate`) against PGlite or DATABASE_URL.
export default defineConfig({
	schema: './src/lib/server/db/schema.ts',
	out: './drizzle',
	dialect: 'postgresql',
	...(process.env.DATABASE_URL ? { dbCredentials: { url: process.env.DATABASE_URL } } : {})
});
