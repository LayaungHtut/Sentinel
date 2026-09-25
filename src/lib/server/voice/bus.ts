/**
 * In-process registry of live voice relays, keyed by incident. The scheduler
 * (escalations), notification receipts and the demo simulator use it to tell
 * an active caller about something that happened outside the conversation.
 *
 * Single-process by design; with several app instances, route voice
 * WebSockets with sticky sessions or publish events through Postgres
 * LISTEN/NOTIFY (see docs/OPERATIONS.md).
 */
export interface RelayHandle {
	voiceSessionId: string;
	incidentId: string | null;
	systemEvent(text: string): void;
	/** Rebuild the agent's incident snapshot (after an operator edit). */
	refreshContext(): void;
	close(reason: string): void;
}

const relays = new Set<RelayHandle>();

export const voiceBus = {
	register(r: RelayHandle) {
		relays.add(r);
	},
	unregister(r: RelayHandle) {
		relays.delete(r);
	},
	/** Deliver a SENTINEL event to every live voice session on the incident. Returns how many received it. */
	notify(incidentId: string, text: string): number {
		let n = 0;
		for (const r of relays) {
			if (r.incidentId === incidentId) {
				r.systemEvent(text);
				n++;
			}
		}
		return n;
	},
	/** Push the latest incident record into every live session's prompt. */
	refresh(incidentId: string) {
		for (const r of relays) if (r.incidentId === incidentId) r.refreshContext();
	},
	activeCount(): number {
		return relays.size;
	},
	closeAll(reason: string) {
		for (const r of [...relays]) r.close(reason);
	}
};
