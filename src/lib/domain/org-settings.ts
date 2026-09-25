import { z } from 'zod';
import { CONTACT_ROLES } from './types';

/**
 * Per-organisation operational policy. Stored as JSON on the organisation and
 * always read through `parseOrgSettings`, so missing keys fall back to safe defaults.
 */
const role = z.enum(CONTACT_ROLES);

export const orgSettingsSchema = z.object({
	/** How long an awaited contact has to respond before automatic escalation. */
	responseTimeoutSeconds: z
		.number()
		.int()
		.min(10)
		.max(24 * 3600)
		.default(15 * 60),
	/** Who a non-responding role escalates to. Missing roles fall back to the playbook chain. */
	escalationChain: z.partialRecord(role, role).default({}),
	/** Transcripts older than this are redacted by the retention job (0 = keep forever). */
	retentionDays: z.number().int().min(0).max(3650).default(365),
	/** Also delete AssemblyAI's stored recording/timeline when retention redacts a session. */
	deleteProviderRecordings: z.boolean().default(false),
	/** Voice cost controls. */
	voiceMaxConcurrent: z.number().int().min(0).max(100).default(3),
	voiceDailyMinutes: z.number().int().min(0).max(100000).default(180)
});

export type OrgSettings = z.infer<typeof orgSettingsSchema>;

export function parseOrgSettings(raw: unknown): OrgSettings {
	const parsed = orgSettingsSchema.safeParse(raw ?? {});
	return parsed.success ? parsed.data : orgSettingsSchema.parse({});
}

/** Demo organisations compress the timeout so escalation is visible live. */
export const DEMO_ORG_SETTINGS: Partial<OrgSettings> = {
	responseTimeoutSeconds: 30,
	retentionDays: 30
};
