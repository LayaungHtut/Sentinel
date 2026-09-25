import { error, redirect } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { voiceSessions } from '$lib/server/db/schema';
import { idParam, rateLimit, requireRole } from '$lib/server/http';
import { recordingUrl } from '$lib/server/assemblyai/reconcile';
import type { RequestHandler } from './$types';

/**
 * Play back the AssemblyAI session recording. SENTINEL fetches a fresh
 * pre-signed URL on demand (they expire quickly) and never stores it.
 */
export const GET: RequestHandler = async (event) => {
	const auth = requireRole(event, 'coordinator');
	await rateLimit(event, 'recording', 30);
	const id = idParam.parse(event.params.id);
	const [s] = await (
		await getDb()
	)
		.select()
		.from(voiceSessions)
		.where(and(eq(voiceSessions.id, id), eq(voiceSessions.orgId, auth.orgId)));
	if (!s) error(404, 'Voice session not found');
	if (s.providerDeletedAt) error(410, 'The recording was deleted under the retention policy.');
	if (!s.providerSessionId) error(404, 'No recording exists for this session.');
	const url = await recordingUrl(s.providerSessionId).catch(() => null);
	if (!url) error(404, 'AssemblyAI has no recording available for this session.');
	redirect(302, url);
};
