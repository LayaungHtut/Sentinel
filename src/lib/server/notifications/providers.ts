import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '$lib/server/env';
import type { NotificationChannel } from '$lib/domain/types';

/**
 * Outbound notification providers. Each is enabled only when its credentials
 * are present; otherwise the channel reports `not_configured` and nothing is
 * claimed as sent. Secrets come from the environment and are never logged.
 */

export interface SendRequest {
	channel: NotificationChannel;
	to: string | null;
	body: string;
	/** Absolute URL Twilio calls with delivery status (optional). */
	statusCallbackUrl?: string;
}

export interface SendResult {
	ok: boolean;
	status: 'sent' | 'failed';
	providerMessageId?: string;
	error?: string;
}

export function channelConfigured(channel: NotificationChannel): boolean {
	switch (channel) {
		case 'sms':
		case 'voice_call':
			return !!(env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.TWILIO_FROM_NUMBER);
		case 'email':
			return !!(env.SMTP_URL && env.EMAIL_FROM);
		case 'slack':
			return !!env.SLACK_WEBHOOK_URL;
		case 'webhook':
			return !!env.NOTIFY_WEBHOOK_URL;
	}
}

export function configuredChannels(): NotificationChannel[] {
	return (['sms', 'voice_call', 'email', 'slack', 'webhook'] as const).filter(channelConfigured);
}

type Fetch = typeof fetch;

export async function send(req: SendRequest, fetchImpl: Fetch = fetch): Promise<SendResult> {
	try {
		switch (req.channel) {
			case 'sms':
				return await twilio(
					'Messages',
					{ To: req.to!, From: env.TWILIO_FROM_NUMBER!, Body: req.body },
					req,
					fetchImpl
				);
			case 'voice_call': {
				const say = req.body.replace(/https?:\/\/\S+/g, '').replace(/[<>&]/g, ' ');
				return await twilio(
					'Calls',
					{
						To: req.to!,
						From: env.TWILIO_FROM_NUMBER!,
						Twiml: `<Response><Say>${say}</Say><Pause length="1"/><Say>${say}</Say></Response>`
					},
					req,
					fetchImpl
				);
			}
			case 'slack': {
				const res = await fetchImpl(env.SLACK_WEBHOOK_URL!, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					body: JSON.stringify({ text: req.body })
				});
				return res.ok
					? { ok: true, status: 'sent' }
					: { ok: false, status: 'failed', error: `Slack HTTP ${res.status}` };
			}
			case 'webhook': {
				const payload = JSON.stringify({
					type: 'sentinel.notification',
					to: req.to,
					body: req.body,
					sentAt: new Date().toISOString()
				});
				const sig = env.NOTIFY_WEBHOOK_SECRET
					? createHmac('sha256', env.NOTIFY_WEBHOOK_SECRET).update(payload).digest('hex')
					: undefined;
				const res = await fetchImpl(env.NOTIFY_WEBHOOK_URL!, {
					method: 'POST',
					headers: {
						'content-type': 'application/json',
						...(sig ? { 'x-sentinel-signature': `sha256=${sig}` } : {})
					},
					body: payload
				});
				return res.ok
					? { ok: true, status: 'sent' }
					: { ok: false, status: 'failed', error: `Webhook HTTP ${res.status}` };
			}
			case 'email': {
				const nodemailer = await import('nodemailer');
				const transport = nodemailer.createTransport(env.SMTP_URL!);
				const info = await transport.sendMail({
					from: env.EMAIL_FROM!,
					to: req.to!,
					subject: req.body.split('\n')[0].slice(0, 120),
					text: req.body
				});
				return { ok: true, status: 'sent', providerMessageId: info.messageId };
			}
		}
	} catch (e) {
		return {
			ok: false,
			status: 'failed',
			error: e instanceof Error ? e.message.slice(0, 200) : 'send failed'
		};
	}
}

async function twilio(
	resource: 'Messages' | 'Calls',
	params: Record<string, string>,
	req: SendRequest,
	fetchImpl: Fetch
): Promise<SendResult> {
	if (!req.to) return { ok: false, status: 'failed', error: 'No phone number for this contact.' };
	const body = new URLSearchParams(params);
	if (req.statusCallbackUrl) body.set('StatusCallback', req.statusCallbackUrl);
	const sid = env.TWILIO_ACCOUNT_SID!;
	const res = await fetchImpl(
		`https://api.twilio.com/2010-04-01/Accounts/${sid}/${resource}.json`,
		{
			method: 'POST',
			headers: {
				Authorization: `Basic ${Buffer.from(`${sid}:${env.TWILIO_AUTH_TOKEN}`).toString('base64')}`,
				'content-type': 'application/x-www-form-urlencoded'
			},
			body
		}
	);
	const json = (await res.json().catch(() => ({}))) as { sid?: string; message?: string };
	if (!res.ok)
		return {
			ok: false,
			status: 'failed',
			error: `Twilio ${res.status}: ${json.message ?? 'error'}`.slice(0, 200)
		};
	return { ok: true, status: 'sent', providerMessageId: json.sid };
}

/**
 * Twilio request validation: base64(HMAC-SHA1(authToken, url + sorted key+value pairs)).
 * Used for delivery-status callbacks so nobody can forge "delivered".
 */
export function validTwilioSignature(
	url: string,
	params: Record<string, string>,
	signature: string | null
): boolean {
	const token = env.TWILIO_AUTH_TOKEN;
	if (!token || !signature) return false;
	const data =
		url +
		Object.keys(params)
			.sort()
			.map((k) => k + params[k])
			.join('');
	const expected = createHmac('sha1', token).update(data).digest('base64');
	const a = Buffer.from(expected);
	const b = Buffer.from(signature);
	return a.length === b.length && timingSafeEqual(a, b);
}
