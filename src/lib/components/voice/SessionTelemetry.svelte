<script lang="ts">
	import { Activity } from '@lucide/svelte';
	import type { IncidentView } from '$lib/domain/view';
	import { fmtCountdown } from '$lib/utils/format';

	let { session, count }: { session: IncidentView['voiceSessions'][number]; count: number } =
		$props();

	/** Every number here is counted from stored rows (transcripts, tool audit log, lifecycle). */
	const metrics = $derived([
		{
			label: 'Duration',
			value: session.durationSec != null ? fmtCountdown(session.durationSec) : '—'
		},
		{ label: 'User turns', value: String(session.userTurns) },
		{ label: 'Interruptions', value: String(session.interruptions) },
		{ label: 'Tool calls', value: String(session.toolCalls) },
		{ label: 'Tool errors', value: String(session.toolErrors) },
		{ label: 'Reconnects', value: String(session.reconnects) }
	]);
</script>

<div class="border-t border-ink-700/70 px-4 py-2.5">
	<div class="mb-1.5 flex items-center justify-between">
		<p class="flex items-center gap-1.5 eyebrow">
			<Activity class="size-3" /> Last voice session{count > 1 ? ` (of ${count})` : ''}
		</p>
		<span
			class={[
				'text-[10px] font-semibold tracking-wider uppercase',
				session.status === 'ended'
					? 'text-ok'
					: session.status === 'error'
						? 'text-crit'
						: 'text-ink-400'
			]}
		>
			{session.status === 'ended'
				? '✓ complete'
				: session.status === 'error'
					? '✕ error'
					: session.status}
		</span>
	</div>
	<dl class="grid grid-cols-3 gap-x-3 gap-y-1 text-[11.5px] sm:grid-cols-6">
		{#each metrics as m (m.label)}
			<div>
				<dt class="text-ink-500">{m.label}</dt>
				<dd class="mono text-ink-200">{m.value}</dd>
			</div>
		{/each}
	</dl>
</div>
