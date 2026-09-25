import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Application-level encryption at rest for sensitive free text (transcripts,
 * evidence quotes). AES-256-GCM, key derived from DATA_ENCRYPTION_KEY.
 * Values are stored as `enc:v1:<iv>:<tag>:<ciphertext>` (base64). Without a key,
 * values are stored as plain text, and existing encrypted values still decrypt
 * as long as the key is present at read time.
 */
const PREFIX = 'enc:v1:';

function key(): Buffer | null {
	const raw = process.env.DATA_ENCRYPTION_KEY?.trim();
	if (!raw) return null;
	// Accept any strong secret; derive a fixed-length key.
	return createHash('sha256').update(raw).digest();
}

export function encryptionEnabled(): boolean {
	return key() !== null;
}

export function encrypt(plain: string): string {
	const k = key();
	if (!k) return plain;
	const iv = randomBytes(12);
	const cipher = createCipheriv('aes-256-gcm', k, iv);
	const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
	const tag = cipher.getAuthTag();
	return `${PREFIX}${iv.toString('base64')}:${tag.toString('base64')}:${data.toString('base64')}`;
}

export function decrypt(stored: string): string {
	if (!stored.startsWith(PREFIX)) return stored;
	const k = key();
	if (!k) return '[encrypted: DATA_ENCRYPTION_KEY not configured]';
	const [iv, tag, data] = stored.slice(PREFIX.length).split(':');
	try {
		const decipher = createDecipheriv('aes-256-gcm', k, Buffer.from(iv, 'base64'));
		decipher.setAuthTag(Buffer.from(tag, 'base64'));
		return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString(
			'utf8'
		);
	} catch {
		return '[encrypted: key mismatch]';
	}
}

export function sha256Hex(input: string | Buffer): string {
	return createHash('sha256').update(input).digest('hex');
}
