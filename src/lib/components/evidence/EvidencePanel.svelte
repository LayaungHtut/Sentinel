<script lang="ts">
	import { ChevronRight, CircleHelp, Plus, Quote, ShieldCheck } from '@lucide/svelte';
	import EpistemicBadge from './EpistemicBadge.svelte';
	import { classifyFact, formatFactValue } from '$lib/domain/evidence';
	import type { IncidentView } from '$lib/domain/view';
	import { fmtClock } from '$lib/utils/format';

	let {
		view,
		onSelectFact,
		runTool,
		readOnly
	}: {
		view: IncidentView;
		onSelectFact: (id: string) => void;
		runTool: (name: string, args: Record<string, unknown>) => Promise<boolean>;
		readOnly: boolean;
	} = $props();

	const current = $derived(view.facts.filter((f) => f.status === 'current'));
	const factsById = $derived(new Map(view.facts.map((f) => [f.id, f])));
	const supersededCount = $derived(view.facts.filter((f) => f.status === 'superseded').length);
	const known = $derived(view.checklist.filter((c) => c.state === 'known'));
	const open = $derived(view.checklist.filter((c) => c.state === 'open'));
	const unavailable = $derived(view.checklist.filter((c) => c.state === 'unavailable'));

	// Highlight only records that arrive while the page is open.
	const loadedAt = Date.now();
	const isNew = (iso: string) => new Date(iso).getTime() > loadedAt;

	let adding = $state(false);
	let form = $state({ key: '', value: '', certainty: 'exact' as 'exact' | 'approximate' });

	async function submit(e: SubmitEvent) {
		e.preventDefault();
		const ok = await runTool('add_fact', {
			facts: [{ key: form.key, value: form.value, certainty: form.certainty, basis: 'stated' }]
		});
		if (ok) {
			form = { key: '', value: '', certainty: 'exact' };
			adding = false;
		}
	}

	async function markUnknown(key: string, question: string) {
		await runTool('request_information', {
			key,
			question,
			status: 'unavailable',
			note: 'Marked unknown by operator'
		});
	}
</script>

<div class="flex h-full flex-col panel">
	<div class="panel-header">
		<span class="flex items-center gap-1.5 eyebrow"><ShieldCheck class="size-3.5" /> Evidence</span>
		<span class="text-[11px] text-ink-400">
			{current.length} facts{#if supersededCount}
				· {supersededCount} superseded{/if}
		</span>
	</div>

	<ul class="divide-y divide-ink-700/60">
		{#each current as fact (fact.id)}
			{@const cls = classifyFact(fact)}
			<li class={isNew(fact.createdAt) ? 'fresh' : undefined}>
				<button
					class="group grid w-full grid-cols-[1fr_auto] items-center gap-3 px-4 py-2.5 text-left hover:bg-ink-850"
					onclick={() => onSelectFact(fact.id)}
				>
					<span class="min-w-0">
						<span class="block eyebrow text-[10px]">{fact.label}</span>
						<span class="block truncate text-[14px] text-ink-100">{formatFactValue(fact)}</span>
						{#if fact.supersedesId && factsById.get(fact.supersedesId)}
							{@const prev = factsById.get(fact.supersedesId)!}
							<span class="block text-[11px] text-ink-400">
								was <s class="decoration-ink-500">{formatFactValue(prev)}</s>
								<span
									class="ml-1 rounded border border-ink-600 px-1 text-[9.5px] tracking-wider uppercase"
									>superseded</span
								>
							</span>
						{/if}
						<span class="mt-0.5 flex items-center gap-1.5 text-[11px] text-ink-500">
							{#if fact.evidenceQuote}
								<Quote class="size-3 {fact.quoteMatched ? 'text-ink-400' : 'text-warn'}" />
								<span class="truncate"
									>{fact.quoteMatched ? 'traced to transcript' : 'quote not traced'}</span
								>
							{:else}
								<span>{fact.sourceType.replace('_', ' ')}</span>
							{/if}
							<span class="mono">· {fmtClock(fact.observedAt)}</span>
						</span>
					</span>
					<span class="flex items-center gap-1.5">
						<EpistemicBadge {cls} />
						<ChevronRight class="size-3.5 text-ink-600 group-hover:text-ink-300" />
					</span>
				</button>
			</li>
		{:else}
			<li class="px-4 py-6 text-center text-[13px] text-ink-500">No facts recorded yet.</li>
		{/each}
	</ul>

	{#if !readOnly}
		<div class="border-t border-ink-700/60 px-4 py-2">
			{#if adding}
				<form class="space-y-2 py-1" onsubmit={submit}>
					<div class="grid grid-cols-2 gap-2">
						<input
							class="input"
							placeholder="key, e.g. temperature"
							bind:value={form.key}
							required
							maxlength="64"
							aria-label="Fact key"
						/>
						<input
							class="input"
							placeholder="value"
							bind:value={form.value}
							required
							maxlength="300"
							aria-label="Fact value"
						/>
					</div>
					<div class="flex items-center justify-between gap-2">
						<select
							class="input w-auto py-1 text-xs"
							bind:value={form.certainty}
							aria-label="Certainty"
						>
							<option value="exact">Exact</option>
							<option value="approximate">Approximate</option>
						</select>
						<span class="flex gap-1.5">
							<button type="button" class="btn-ghost text-xs" onclick={() => (adding = false)}
								>Cancel</button
							>
							<button type="submit" class="btn-secondary text-xs">Record fact</button>
						</span>
					</div>
					<p class="text-[11px] text-ink-500">
						Recorded as an operator entry, so it has no transcript quote.
					</p>
				</form>
			{:else}
				<button class="-ml-2 btn-ghost text-xs" onclick={() => (adding = true)}
					><Plus class="size-3.5" /> Add fact manually</button
				>
			{/if}
		</div>
	{/if}

	<div class="border-t border-ink-700/70">
		<div class="flex items-center justify-between px-4 pt-3 pb-1.5">
			<span class="eyebrow">Information needed</span>
			<span class="text-[11px] text-ink-400"
				>{known.length}/{view.checklist.length} established</span
			>
		</div>
		<ul class="space-y-0.5 px-4 pb-3 text-[13px]">
			{#each known as item (item.key)}
				<li class="flex items-center gap-2 text-ink-300">
					<span class="w-4 text-center mono text-ok">✓</span>
					<span class="flex-1 truncate">{item.label}</span>
				</li>
			{/each}
			{#each open as item (item.key)}
				<li class="group flex items-center gap-2">
					<span
						class={[
							'w-4 text-center mono',
							item.priority === 'critical' ? 'text-warn' : 'text-ink-500'
						]}>?</span
					>
					<span class="flex-1 truncate text-ink-100" title={item.question}>
						{item.label}
						{#if item.priority === 'critical'}<span class="ml-1 text-[10px] text-warn uppercase"
								>critical</span
							>{/if}
					</span>
					{#if !readOnly}
						<button
							class="hidden text-[10.5px] text-ink-500 group-hover:inline hover:text-ink-200"
							onclick={() => markUnknown(item.key, item.question)}
							title="Record that nobody knows this yet">mark unknown</button
						>
					{/if}
				</li>
			{/each}
			{#each unavailable as item (item.key)}
				<li class="flex items-center gap-2 text-ink-400">
					<CircleHelp class="size-3.5 w-4 text-ink-500" />
					<span class="flex-1 truncate">{item.label}</span>
					<span class="text-[10.5px] uppercase">unknown</span>
				</li>
			{/each}
		</ul>
	</div>
</div>
