import { error, text } from '@sveltejs/kit';
import { getDb } from '$lib/server/db';
import { publicBaseUrl, recordDeliveryStatus } from '$lib/server/notifications/outbox';
import { validTwilioSignature } from '$lib/server/notifications/providers';
import { rateLimit } from '$lib/server/http';
import { log, metrics } from '$lib/server/observability';
import type { RequestHandler } from './$types';

/**
 * Twilio delivery receipts (SMS MessageStatus / voice CallStatus). The
 * X-Twilio-Signature is verified against the exact public URL Twilio was given,
 * so a forged request cannot mark a message as delivered.
 */
export const POST: RequestHandler = async (event) => {
	await rateLimit(event, 'twilio-webhook', 600);
	const raw = await event.request.text();
	if (raw.length > 16_000) error(413, 'Too large');
	const params = Object.fromEntries(new URLSearchParams(raw));
	const url = `${publicBaseUrl()}/api/webhooks/twilio/status`;
	if (!validTwilioSignature(url, params, event.request.headers.get('x-twilio-signature'))) {
		log.warn('twilio webhook rejected: bad signature');
		error(403, 'Invalid signature');
	}
	const sid = params.MessageSid ?? params.CallSid;
	const status = params.MessageStatus ?? params.CallStatus;
	if (sid && status) {
		const changed = await recordDeliveryStatus(await getDb(), sid, status);
		if (changed)
			metrics.notifications.inc({ channel: params.CallSid ? 'voice_call' : 'sms', status });
	}
	return text('', { status: 204 });
};
