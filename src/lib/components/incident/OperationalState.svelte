<script lang="ts">
	import { Crosshair, Gauge } from '@lucide/svelte';
	import EpistemicBadge from '$lib/components/evidence/EpistemicBadge.svelte';
	import type { IncidentView } from '$lib/domain/view';

	let { view, onSelectFact }: { view: IncidentView; onSelectFact: (id: string) => void } = $props();

	const op = $derived(view.operational);
	const RISK_TONE: Record<string, string> = {
		critical: 'text-crit',
		high: 'text-high',
		medium: 'text-med',
		low: 'text-ink-300',
		watch: 'text-info'
	};
</script>

<section class="flex h-full flex-col panel" aria-label="Operational state">
	<div class="panel-header">
		<span class="flex items-center gap-1.5 eyebrow"
			><Gauge class="size-3.5" /> Operational state</span
		>
		<span class="text-[11px] text-ink-500">from the incident record</span>
	</div>

	<div class="space-y-4 p-4 text-[13px]">
		<div>
			<p class="mb-1 eyebrow text-[10px]">Current situation</p>
			<p class="text-[15px] font-medium text-ink-100">{op.situation}</p>
		</div>

		{#if op.priority}
			<div class="rounded-md border border-high/40 bg-high/5 px-3 py-2">
				<p class="mb-0.5 flex items-center gap-1.5 eyebrow text-[10px] text-high">
					<Crosshair class="size-3" /> Current priority
				</p>
				<p class="text-ink-100">{op.priority}</p>
			</div>
		{/if}

		<div>
			<p class="mb-1.5 eyebrow text-[10px]">
				Known <span class="font-normal tracking-normal text-ink-500 normal-case">(facts)</span>
			</p>
			<ul class="space-y-1">
				{#each op.known as k (k.factId)}
					<li>
						<button
							class="group flex w-full items-center gap-2 text-left"
							onclick={() => onSelectFact(k.factId)}
						>
							<span class="w-28 shrink-0 truncate text-ink-400">{k.label}</span>
							<span class="min-w-0 flex-1 truncate text-ink-100 group-hover:underline"
								>{k.display}</span
							>
							<EpistemicBadge cls={k.class} compact />
						</button>
					</li>
				{:else}
					<li class="text-ink-500">Nothing established yet.</li>
				{/each}
			</ul>
		</div>

		{#if op.unknown.length}
			<div>
				<p class="mb-1.5 eyebrow text-[10px]">Unknown</p>
				<ul class="space-y-0.5">
					{#each op.unknown as u (u.key)}
						<li class="flex items-center gap-2">
							<span
								class={[
									'w-3 text-center mono',
									u.priority === 'critical' ? 'text-warn' : 'text-ink-500'
								]}
								aria-hidden="true">?</span
							>
							<span class={u.priority === 'critical' ? 'text-ink-100' : 'text-ink-300'}
								>{u.label}</span
							>
							{#if u.priority === 'critical'}<span
									class="text-[10px] tracking-wide text-warn uppercase">critical</span
								>{/if}
							{#if u.reporterDoesNotKnow}<span
									class="text-[10px] tracking-wide text-ink-500 uppercase"
									>reporter doesn't know</span
								>{/if}
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		<div>
			<p class="mb-1.5 eyebrow text-[10px]">
				Risk signals <span class="font-normal tracking-normal text-ink-500 normal-case"
					>(system assessment, not facts)</span
				>
			</p>
			<ul class="space-y-1.5">
				{#each op.risks as r (r.text)}
					<li class="flex gap-2" title={r.basis}>
						<span
							class={[
								'mt-px w-12 shrink-0 mono text-[10px] font-semibold uppercase',
								RISK_TONE[r.level]
							]}
						>
							{r.level === 'watch' ? '◷ watch' : `⚠ ${r.level}`}
						</span>
						<span class="text-ink-200">
							{r.text}
							<span class="block text-[10.5px] text-ink-500">{r.basis}</span>
						</span>
					</li>
				{:else}
					<li class="text-ink-500">No risk signals from the current record.</li>
				{/each}
			</ul>
		</div>
	</div>
</section>
