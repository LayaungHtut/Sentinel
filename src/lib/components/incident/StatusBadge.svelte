<script lang="ts">
	import type { IncidentStatus } from '$lib/domain/types';
	import { STATUS_TONE } from '$lib/components/ui/tones';

	let { status, size = 'md' }: { status: IncidentStatus; size?: 'sm' | 'md' } = $props();
	const live = $derived(
		['active', 'mitigating', 'escalated', 'blocked', 'assessing'].includes(status)
	);
</script>

<span
	class={[
		'inline-flex items-center gap-1.5 rounded border bg-ink-850 font-semibold tracking-[0.12em] uppercase',
		STATUS_TONE[status],
		size === 'sm' ? 'px-1.5 py-0.5 text-[10px]' : 'px-2 py-0.5 text-[11px]'
	]}
>
	{#if live}<span class="pulse-dot size-1.5 rounded-full bg-current"></span>{/if}
	{status}
</span>
