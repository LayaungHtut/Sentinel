<script lang="ts">
	import { resolve } from '$app/paths';
	import { ArrowLeft, FileText, Pause, Play, SkipForward } from '@lucide/svelte';
	import Brand from '$lib/components/dashboard/Brand.svelte';
	import { fmtClock } from '$lib/utils/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();

	/** Number of turns revealed so far (all visible until the user presses play). */
	// svelte-ignore state_referenced_locally
	let shown = $state(data.turns.length);
	let playing = $state(false);
	let timer: ReturnType<typeof setTimeout> | null = null;

	function stop() {
		playing = false;
		if (timer) clearTimeout(timer);
		timer = null;
	}
	function tick() {
		if (shown >= data.turns.length) return stop();
		shown++;
		timer = setTimeout(tick, 2200);
	}
	function play() {
		stop();
		shown = 0;
		playing = true;
		timer = setTimeout(tick, 400);
	}
	$effect(() => stop);

	const STAGES = ['Voice', 'Transcript', 'Tool call', 'Record change', 'Reply'];
</script>

<svelte:head><title>{data.code} replay · SENTINEL</title></svelte:head>

<div class="mx-auto max-w-5xl px-5 pb-16">
	<header class="flex flex-wrap items-center justify-between gap-3 py-5">
		<div class="flex items-center gap-4">
			<Brand compact />
			<a href={resolve('/incidents/[id]', { id: data.incidentId })} class="btn-ghost text-xs"
				><ArrowLeft class="size-3.5" /> Back to incident</a
			>
		</div>
		<div class="flex items-center gap-2">
			{#if playing}
				<button class="btn-secondary text-xs" onclick={stop}
					><Pause class="size-3.5" /> Pause</button
				>
				<button
					class="btn-ghost text-xs"
					onclick={() => {
						stop();
						shown = data.turns.length;
					}}
				>
					<SkipForward class="size-3.5" /> Show all
				</button>
			{:else}
				<button class="btn-primary text-xs" onclick={play} disabled={!data.turns.length}>
					<Play class="size-3.5" /> Replay incident
				</button>
			{/if}
		</div>
	</header>

	<div class="mb-6">
		<p class="eyebrow">Incident replay · {data.code}{data.isDemo ? ' · demo data' : ''}</p>
		<h1 class="mt-1 text-2xl font-semibold text-ink-100">{data.title}</h1>
		<p class="mt-2 text-[13px] text-ink-400">
			Rebuilt from stored rows (transcripts, the tool-call audit log and the timeline). Each spoken
			turn is shown with what it caused.
		</p>
		<ol class="mt-3 flex flex-wrap items-center gap-1.5 text-[10.5px]" aria-label="Chain">
			{#each STAGES as stage, i (stage)}
				<li class="flex items-center gap-1.5">
					{#if i}<span class="text-ink-600" aria-hidden="true">→</span>{/if}
					<span
						class="rounded border border-ink-600 px-1.5 py-0.5 font-semibold tracking-wider text-ink-300 uppercase"
						>{stage}</span
					>
				</li>
			{/each}
		</ol>
	</div>

	<ol class="space-y-4">
		{#each data.turns.slice(0, shown) as turn (turn.index)}
			<li class="enter panel p-4">
				<div class="grid gap-4 md:grid-cols-[1fr_1.25fr]">
					<div>
						{#if turn.utterance}
							<p class="mb-1 flex items-center justify-between eyebrow text-[10px]">
								<span
									>{turn.utterance.channel === 'typed'
										? 'Typed'
										: 'Voice → AssemblyAI transcript'}</span
								>
								<span class="mono font-normal tracking-normal">{fmtClock(turn.utterance.at)}</span>
							</p>
							<blockquote class="text-[15px] leading-relaxed text-ink-100">
								“{turn.utterance.text}”
							</blockquote>
						{:else}
							<p class="eyebrow text-[10px]">Before any speech</p>
							<p class="text-[13px] text-ink-400">
								Records created without voice (operator or system).
							</p>
						{/if}
						{#each turn.replies as r, i (i)}
							<p class="mt-3 mb-0.5 eyebrow text-[10px] text-voice">
								SENTINEL replied{r.interrupted ? ' · ✋ interrupted' : ''}
							</p>
							<p class={['text-[13.5px] text-ink-300', r.interrupted && 'opacity-70']}>
								{r.text}{r.interrupted ? '—' : ''}
							</p>
						{/each}
					</div>
					<div class="space-y-3 border-ink-700 md:border-l md:pl-4">
						{#if turn.toolCalls.length}
							<div>
								<p class="mb-1 eyebrow text-[10px]">Tool calls</p>
								<ul class="space-y-0.5 text-[12px]">
									{#each turn.toolCalls as c (c.id)}
										<li class="flex items-baseline gap-2">
											<span class={['mono', c.ok ? 'text-ok' : 'text-crit']}
												>{c.ok ? '✓' : '✕'} {c.toolName}</span
											>
											<span class="text-ink-500"
												>{c.origin === 'voice' ? 'voice agent' : c.origin.replace('_', ' ')}</span
											>
											{#if c.error}<span class="truncate text-crit">{c.error}</span>{/if}
										</li>
									{/each}
								</ul>
							</div>
						{/if}
						{#if turn.changes.length}
							<div>
								<p class="mb-1 eyebrow text-[10px]">Record changes</p>
								<ul class="space-y-0.5 text-[12.5px]">
									{#each turn.changes as ch, i (i)}
										<li class="flex gap-2">
											<span class="shrink-0 mono text-[11px] text-ink-500">{fmtClock(ch.at)}</span>
											<span class={ch.source === 'demo_simulation' ? 'text-voice' : 'text-ink-200'}
												>{ch.description}</span
											>
										</li>
									{/each}
								</ul>
							</div>
						{:else if turn.utterance}
							<p class="text-[12px] text-ink-500">No record changes from this turn.</p>
						{/if}
					</div>
				</div>
			</li>
		{:else}
			<li class="panel p-6 text-sm text-ink-400">Nothing recorded yet.</li>
		{/each}
		{#if shown >= data.turns.length && data.report}
			<li class="enter flex items-center justify-between panel p-4">
				<span class="flex items-center gap-2 text-[13px] text-ink-200">
					<FileText class="size-4 text-ink-400" /> Report v{data.report.version} compiled from this record
				</span>
				<a
					class="btn-secondary text-xs"
					href={resolve('/incidents/[id]/report', { id: data.incidentId })}>Open report</a
				>
			</li>
		{/if}
	</ol>
</div>
