import { error, text } from '@sveltejs/kit';
import { timingSafeEqual } from 'node:crypto';
import { env } from '$env/dynamic/private';
import { renderMetrics } from '$lib/server/observability';
import { voiceBus } from '$lib/server/voice/bus';
import type { RequestHandler } from './$types';

/** Prometheus scrape endpoint. Requires `Authorization: Bearer $METRICS_TOKEN`; disabled if unset. */
export const GET: RequestHandler = async ({ request }) => {
	const token = env.METRICS_TOKEN;
	if (!token) error(404, 'Not found');
	const given = Buffer.from(request.headers.get('authorization')?.replace(/^Bearer\s+/i, '') ?? '');
	const want = Buffer.from(token);
	if (given.length !== want.length || !timingSafeEqual(given, want)) error(401, 'Unauthorized');
	const gauge = `# HELP sentinel_voice_relays_active Live voice relays in this process\n# TYPE sentinel_voice_relays_active gauge\nsentinel_voice_relays_active ${voiceBus.activeCount()}\n`;
	return text(renderMetrics() + '\n' + gauge, {
		headers: { 'content-type': 'text/plain; version=0.0.4' }
	});
};
