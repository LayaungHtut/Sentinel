/**
 * Server environment for library code. Reads `process.env` directly, which
 * adapter-node, the Vite dev server, Vitest and the tsx CLI scripts
 * (`npm run db:*`) all provide, so these modules also work outside SvelteKit.
 * Routes and hooks may keep using `$env/dynamic/private`.
 */
export const env: Record<string, string | undefined> = process.env;
