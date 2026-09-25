import { error } from '@sveltejs/kit';
import { and, eq } from 'drizzle-orm';
import { getDb } from '$lib/server/db';
import { attachments } from '$lib/server/db/schema';
import { idParam, requireRole } from '$lib/server/http';
import type { RequestHandler } from './$types';

/** Serve a photo to members of the owning organisation only. */
export const GET: RequestHandler = async (event) => {
	const auth = requireRole(event, 'reporter');
	const id = idParam.parse(event.params.id);
	const [a] = await (
		await getDb()
	)
		.select()
		.from(attachments)
		.where(and(eq(attachments.id, id), eq(attachments.orgId, auth.orgId)));
	if (!a) error(404, 'Not found');
	return new Response(Buffer.from(a.data, 'base64'), {
		headers: {
			'content-type': a.mime,
			'content-length': String(a.sizeBytes),
			'cache-control': 'private, max-age=3600',
			'content-security-policy': "default-src 'none'",
			etag: `"${a.sha256}"`
		}
	});
};
