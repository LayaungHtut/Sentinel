import tailwindcss from '@tailwindcss/vite';
import { defineConfig } from 'vitest/config';
import type { Plugin } from 'vite';
import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';

/** Dev server: forward WebSocket upgrades to the voice relay (production does this in server/index.js). */
const voiceRelayDev: Plugin = {
	name: 'sentinel-voice-relay',
	configureServer(server) {
		server.httpServer?.on('upgrade', (req, socket, head) => {
			if (!req.url?.startsWith('/api/voice/relay')) return;
			const relay = (
				globalThis as { __sentinelRelay?: { handleUpgrade: (...a: unknown[]) => boolean } }
			).__sentinelRelay;
			if (!relay?.handleUpgrade(req, socket, head)) socket.destroy();
		});
	}
};

export default defineConfig({
	plugins: [
		voiceRelayDev,
		tailwindcss(),
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},
			adapter: adapter()
		})
	],
	optimizeDeps: {
		// PGlite ships its own WASM bundle and must not be pre-bundled by Vite.
		exclude: ['@electric-sql/pglite']
	},
	ssr: {
		external: ['@electric-sql/pglite']
	},
	test: {
		expect: { requireAssertions: true },
		environment: 'node',
		include: ['src/**/*.{test,spec}.{js,ts}'],
		exclude: ['src/**/*.svelte.{test,spec}.{js,ts}', 'e2e/**'],
		testTimeout: 30_000,
		hookTimeout: 60_000
	}
});
