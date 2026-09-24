<script lang="ts">
	import type { Severity } from '$lib/domain/types';
	import { SEVERITY_TONE } from '$lib/components/ui/tones';

	let {
		level,
		provisional = false,
		size = 'md'
	}: { level: Severity; provisional?: boolean; size?: 'sm' | 'md' | 'lg' } = $props();
</script>

<span
	class={[
		'inline-flex items-center gap-1.5 rounded border font-semibold tracking-[0.12em] uppercase',
		SEVERITY_TONE[level],
		size === 'sm' && 'px-1.5 py-0.5 text-[10px]',
		size === 'md' && 'px-2 py-0.5 text-[11px]',
		size === 'lg' && 'px-2.5 py-1 text-sm'
	]}
	title={provisional ? 'Provisional — critical information still unknown' : undefined}
>
	{#if level === 'critical' || level === 'high'}<span class="size-1.5 rounded-full bg-current"
		></span>{/if}
	{level}
	{#if provisional}<span class="font-normal tracking-normal normal-case opacity-75"
			>· assessing</span
		>{/if}
</span>
