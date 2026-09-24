<script lang="ts">
	import type { EpistemicClass } from '$lib/domain/types';
	import { EPISTEMIC_DESCRIPTIONS, EPISTEMIC_LABELS } from '$lib/domain/evidence';
	import { EPISTEMIC_TONE } from '$lib/components/ui/tones';

	let { cls, compact = false }: { cls: EpistemicClass; compact?: boolean } = $props();
</script>

<span
	class={[
		'inline-flex items-center gap-1 rounded border px-1.5 py-px text-[10.5px] font-medium tracking-wide uppercase',
		EPISTEMIC_TONE[cls].chip
	]}
	title={EPISTEMIC_DESCRIPTIONS[cls]}
>
	<span aria-hidden="true">{EPISTEMIC_TONE[cls].symbol}</span>
	{#if compact}<span class="sr-only">{EPISTEMIC_LABELS[cls]}</span>{:else}{EPISTEMIC_LABELS[
			cls
		]}{/if}
</span>
