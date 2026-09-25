import { error, json } from '@sveltejs/kit';
import { createHash } from 'node:crypto';
import { getDb } from '$lib/server/db';
import { attachments } from '$lib/server/db/schema';
import { idParam, rateLimit, requireRole } from '$lib/server/http';
import { addTimeline, getIncidentInOrg, NotFoundError } from '$lib/server/incidents/repository';
import type { RequestHandler } from './$types';

const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** Identify the image type from its bytes; the client-declared type is not trusted. */
function sniffImage(b: Uint8Array): string | null {
	if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
	if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
	const ascii = (from: number, to: number) => String.fromCharCode(...b.subarray(from, to));
	if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
	return null;
}

/** Photo evidence: JPEG/PNG/WebP up to 5 MB, hashed (SHA-256) and logged on the audit chain. */
export const POST: RequestHandler = async (event) => {
	const auth = requireRole(event, 'reporter');
	await rateLimit(event, 'attachments', 30);
	const id = idParam.parse(event.params.id);
	const db = await getDb();
	const incident = await getIncidentInOrg(db, auth.orgId, id).catch((e) => {
		if (e instanceof NotFoundError) error(404, 'Incident not found');
		throw e;
	});
	const len = Number(event.request.headers.get('content-length') ?? 0);
	if (len > MAX_ATTACHMENT_BYTES + 64_000) error(413, 'Photos must be 5 MB or smaller.');
	const form = await event.request
		.formData()
		.catch(() => error(400, 'Expected multipart form data.'));
	const file = form.get('file');
	if (!(file instanceof File)) error(400, 'Attach a photo in the "file" field.');
	if (file.size > MAX_ATTACHMENT_BYTES) error(413, 'Photos must be 5 MB or smaller.');
	const bytes = new Uint8Array(await file.arrayBuffer());
	const mime = sniffImage(bytes);
	if (!mime) error(415, 'Only JPEG, PNG or WebP photos are accepted.');
	const caption =
		String(form.get('caption') ?? '')
			.trim()
			.slice(0, 200) || null;
	const sha256 = createHash('sha256').update(bytes).digest('hex');

	const row = await db.transaction(async (tx) => {
		const [a] = await tx
			.insert(attachments)
			.values({
				orgId: auth.orgId,
				incidentId: incident.id,
				mime,
				sizeBytes: bytes.length,
				sha256,
				data: Buffer.from(bytes).toString('base64'),
				caption,
				uploadedBy: auth.userName
			})
			.returning({ id: attachments.id, createdAt: attachments.createdAt });
		await addTimeline(tx, {
			incidentId: incident.id,
			eventType: 'attachment_added',
			description: `Photo added by ${auth.userName}${caption ? `: "${caption}"` : ''} (SHA-256 ${sha256.slice(0, 12)}…)`,
			source: 'operator',
			actor: auth.userName,
			refType: 'attachment',
			refId: a.id,
			metadata: { sha256, mime, sizeBytes: bytes.length }
		});
		return a;
	});
	return json({ id: row.id, sha256, mime, sizeBytes: bytes.length }, { status: 201 });
};
