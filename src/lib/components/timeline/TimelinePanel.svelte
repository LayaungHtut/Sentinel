<script lang="ts">
	import { Clock, Plus, ShieldAlert, ShieldCheck } from '@lucide/svelte';
	import type { IncidentView, TimelineView } from '$lib/domain/view';
	import { fmtClock } from '$lib/utils/format';

	let {
		view,
		runTool,
		readOnly
	}: {
		view: IncidentView;
		runTool: (name: string, args: Record<string, unknown>) => Promise<boolean>;
		readOnly: boolean;
	} = $props();

	const events = $derived([...view.timeline].reverse());
	let note = $state('');
	const loadedAt = Date.now();

	const SOURCE: Record<TimelineView['source'], { label: string; cls: string }> = {
		agent_tool: { label: 'voice agent', cls: 'text-voice' },
		voice: { label: 'voice', cls: 'text-voice' },
		operator: { label: 'operator', cls: 'text-ink-300' },
		system: { label: 'system', cls: 'text-ink-400' },
		demo_simulation: { label: 'demo sim', cls: 'text-voice' },
		external: { label: 'recipient', cls: 'text-ok' },
		sensor: { label: 'sensor', cls: 'text-info' }
	};

	function tone(type: string): string {
		if (
			type.startsWith('escalation_created') ||
			type === 'voice_error' ||
			type === 'notification_failed'
		)
			return 'bg-crit';
		if (type === 'notification_delivered' || type === 'notification_acknowledged') return 'bg-ok';
		if (type.startsWith('notification')) return 'bg-info';
		if (type.startsWith('escalation')) return 'bg-warn';
		if (type === 'severity_assessed') return 'bg-high';
		if (type === 'fact_superseded' || type === 'fact_uncertain') return 'bg-warn';
		if (type === 'fact_confirmed' || type === 'response_received') return 'bg-ok';
		if (type.startsWith('fact')) return 'bg-ink-300';
		if (type.startsWith('action') || type === 'contact_initiated') return 'bg-info';
		return 'bg-ink-500';
	}

	const TYPE_LABELS: Record<string, string> = {
		incident_created: 'Incident reported',
		status_changed: 'Status change',
		severity_assessed: 'Severity',
		fact_recorded: 'Fact recorded',
		fact_superseded: 'Fact corrected',
		fact_confirmed: 'Fact confirmed',
		fact_uncertain: 'Fact in doubt',
		information_requested: 'Info needed',
		information_unavailable: 'Unknown',
		action_created: 'Action added',
		action_updated: 'Action update',
		contact_initiated: 'Contact started',
		response_received: 'Response',
		escalation_created: 'Escalation',
		escalation_acknowledged: 'Escalation ack',
		escalation_resolved: 'Escalation closed',
		report_generated: 'Report',
		incident_updated: 'Incident update',
		voice_ready: 'Voice connected',
		voice_ended: 'Voice ended',
		voice_error: 'Voice error',
		voice_disconnected: 'Voice lost',
		voice_resumed: 'Voice restored',
		notification_sent: 'Message sent',
		notification_delivered: 'Delivered',
		notification_failed: 'Not delivered',
		notification_acknowledged: 'Acknowledged',
		attachment_added: 'Photo',
		transcript_redacted: 'Redaction',
		retention_redaction: 'Retention',
		transcript_reconciled: 'Transcript check'
	};
	const typeLabel = (t: string) => TYPE_LABELS[t] ?? t.replace(/_/g, ' ');

	async function addNote(e: SubmitEvent) {
		e.preventDefault();
		if (await runTool('add_timeline_event', { event_type: 'note', description: note })) note = '';
	}
</script>

<div class="flex h-full flex-col panel">
	<div class="panel-header">
		<span class="flex items-center gap-1.5 eyebrow"
			><Clock class="size-3.5" /> Evidence timeline</span
		>
		<span class="flex items-center gap-2 text-[11px] text-ink-400">
			{#if view.audit.ok}
				<span
					class="flex items-center gap-1 text-ok"
					title="Every event is hash-chained (SHA-256) and the database rejects edits and deletions. Chain head {view.audit.headHash?.slice(
						0,
						16
					) ?? '—'}…"
				>
					<ShieldCheck class="size-3.5" /> chain verified
				</span>
			{:else}
				<span
					class="flex items-center gap-1 text-crit"
					role="alert"
					title={view.audit.reason ?? ''}
				>
					<ShieldAlert class="size-3.5" /> integrity check failed: {view.audit.reason}
				</span>
			{/if}
			<span>{view.timeline.length} events</span>
		</span>
	</div>

	{#if !readOnly}
		<form class="flex gap-2 border-b border-ink-700/60 px-4 py-2" onsubmit={addNote}>
			<input
				class="input py-1 text-xs"
				placeholder="Add a note to the record…"
				bind:value={note}
				minlength="3"
				maxlength="400"
				aria-label="Timeline note"
			/>
			<button class="btn-ghost px-2 text-xs" disabled={note.trim().length < 3} aria-label="Add note"
				><Plus class="size-3.5" /></button
			>
		</form>
	{/if}

	<ol
		class="max-h-[420px] flex-1 divide-y divide-ink-800 overflow-y-auto px-4 py-1"
		aria-label="Timeline events"
	>
		{#each events as e (e.id)}
			<li
				class={[
					'grid grid-cols-[56px_12px_1fr] items-baseline gap-x-2 py-1.5 sm:grid-cols-[64px_14px_132px_1fr] lg:grid-cols-[64px_14px_150px_1fr_150px]',
					new Date(e.occurredAt).getTime() > loadedAt && 'fresh'
				]}
			>
				<span class="mono text-[11px] text-ink-400">{fmtClock(e.occurredAt)}</span>
				<span class={['size-2 self-center rounded-full', tone(e.eventType)]} aria-hidden="true"
				></span>
				<span
					class="col-start-3 truncate text-[10.5px] font-semibold tracking-[0.1em] text-ink-300 uppercase sm:col-start-auto"
				>
					{typeLabel(e.eventType)}
				</span>
				<span class="col-start-3 min-w-0 text-[13px] leading-snug text-ink-200 sm:col-start-auto"
					>{e.description}</span
				>
				<span
					class={[
						'col-start-3 text-[10px] font-semibold tracking-[0.12em] uppercase sm:col-start-4 lg:col-start-auto lg:text-right',
						SOURCE[e.source]?.cls
					]}
				>
					{SOURCE[e.source]?.label ?? e.source}{#if e.toolName}<span
							class="tracking-normal text-ink-500 normal-case"
						>
							· {e.toolName}</span
						>{/if}
				</span>
			</li>
		{:else}
			<li class="py-6 text-center text-[13px] text-ink-500">
				The timeline starts when the incident is created.
			</li>
		{/each}
	</ol>
</div>
