<script lang="ts">
	import { resolve } from '$app/paths';
	let { compact = false }: { compact?: boolean } = $props();
</script>

<a href={resolve('/')} class="group flex items-center gap-2.5" aria-label="SENTINEL home">
	<svg viewBox="0 0 32 32" class="size-7 shrink-0" aria-hidden="true">
		<path
			d="M16 4 6.5 8.2v7c0 6 4 10.4 9.5 12.3 5.5-1.9 9.5-6.3 9.5-12.3v-7L16 4Z"
			fill="none"
			stroke="currentColor"
			stroke-width="2"
			stroke-linejoin="round"
			class="text-ink-100"
		/>
		<circle cx="16" cy="15.5" r="3.4" class="fill-high" />
	</svg>
	<span class="flex flex-col leading-none">
		<span class="text-[15px] font-semibold tracking-[0.22em] text-ink-100">SENTINEL</span>
		{#if !compact}
			<span class="mt-1 text-[10.5px] tracking-wide text-ink-400"
				>Evidence-first voice incident response</span
			>
		{/if}
	</span>
</a>
