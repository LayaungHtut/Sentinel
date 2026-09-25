import {
	error,
	redirect,
	type Handle,
	type HandleServerError,
	type ServerInit
} from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { getDb, getDbHandle } from '$lib/server/db';
import { seedDatabase } from '$lib/server/demo/seed';
import { resolveSession, SESSION_COOKIE } from '$lib/server/auth';
import { log, metrics } from '$lib/server/observability';
import { startScheduler } from '$lib/server/jobs/scheduler';
import { installRelay } from '$lib/server/voice/relay-server';
import { voiceBus } from '$lib/server/voice/bus';

export const init: ServerInit = async () => {
	try {
		const { db, driver } = await getDbHandle();
		if (env.SEED_DEMO_DATA !== 'false') {
			const { seeded } = await seedDatabase(db);
			if (seeded) log.info('seeded demo organisation (fictional data)');
		}
		log.info('database ready', { driver });
		// The voice relay attaches to the HTTP server's upgrade event (see server/ and vite.config.ts).
		installRelay();
		if (env.SCHEDULER_ENABLED !== 'false') startScheduler();
		else {
			// Still end live voice sessions cleanly (session.end stops billing) on shutdown.
			globalThis.__sentinelShutdown = async () => {
				voiceBus.closeAll('server shutting down');
				await new Promise((r) => setTimeout(r, 1500));
			};
		}
	} catch (e) {
		// Keep serving: pages show a clear database error instead of crashing the process.
		log.error('initialisation failed', { err: e });
	}
};

/** Routes reachable without a signed-in user. */
const PUBLIC_PREFIXES = [
	'/login',
	'/setup',
	'/ack/',
	'/api/health',
	'/api/ready',
	'/api/metrics', // token-protected in the handler
	'/api/webhooks/', // signature-verified in the handler
	'/api/observations', // API-key authenticated in the handler
	'/api/auth/'
];

function isPublic(path: string) {
	return PUBLIC_PREFIXES.some((p) => path === p || path.startsWith(p));
}

export const handle: Handle = async ({ event, resolve }) => {
	event.locals.requestId = crypto.randomUUID();
	event.locals.auth = null;
	const path = event.url.pathname;
	const token = event.cookies.get(SESSION_COOKIE);
	if (token) {
		try {
			event.locals.auth = await resolveSession(await getDb(), token);
		} catch (e) {
			log.error('session lookup failed', { err: e, requestId: event.locals.requestId });
		}
	}

	if (
		!event.locals.auth &&
		!isPublic(path) &&
		!path.startsWith('/_app/') &&
		path !== '/favicon.ico'
	) {
		if (path.startsWith('/api/')) error(401, 'Sign in required.');
		redirect(303, `/login?next=${encodeURIComponent(path + event.url.search)}`);
	}

	const started = Date.now();
	const response = await resolve(event);
	response.headers.set('X-Request-Id', event.locals.requestId);
	response.headers.set('X-Content-Type-Options', 'nosniff');
	response.headers.set('Referrer-Policy', 'strict-origin-when-cross-origin');
	response.headers.set('X-Frame-Options', 'DENY');
	response.headers.set('Permissions-Policy', 'microphone=(self), camera=(self), geolocation=()');
	if (event.url.protocol === 'https:') {
		response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
	}
	if (response.status >= 500) {
		metrics.httpErrors.inc({ route: event.route.id ?? 'unknown' });
	}
	if (path.startsWith('/api/') && Date.now() - started > 2000) {
		log.warn('slow request', { path, ms: Date.now() - started, requestId: event.locals.requestId });
	}
	return response;
};

export const handleError: HandleServerError = ({ error: err, event, status }) => {
	if (status !== 404) {
		log.error('unhandled server error', {
			err,
			status,
			path: event.url.pathname,
			requestId: event.locals.requestId
		});
	}
	return {
		message: status === 404 ? 'Not found' : 'Something went wrong.',
		requestId: event.locals.requestId
	};
};
