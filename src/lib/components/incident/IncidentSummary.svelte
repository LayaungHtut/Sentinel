<script lang="ts">
	import { ChevronDown, CircleHelp } from '@lucide/svelte';
	import SeverityBadge from './SeverityBadge.svelte';
	import EpistemicBadge from '$lib/components/evidence/EpistemicBadge.svelte';
	import { classifyFact, formatFactValue } from '$lib/domain/evidence';
	import { getPlaybook } from '$lib/domain/playbooks';
	import type { IncidentView, FactView } from '$lib/domain/view';
	import { fmtClock, fmtRelative } from '$lib/utils/format';

	let {
		view,
		now,
		onSelectFact
	}: { view: IncidentView; now: number; onSelectFact: (id: string) => void } = $props();

	const incident = $derived(view.incident);
	const sev = $derived(view.severityAssessment);
	const current = $derived(view.facts.filter((f) => f.status === 'current'));
	const byKey = $derived(new Map(current.map((f) => [f.key, f])));
	const headline = $derived(current.find((f) => f.category === 'measurement') ?? null);
	const previousHeadline = $derived(
		headline?.supersedesId ? (view.facts.find((f) => f.id === headline.supersedesId) ?? null) : null
	);
	const affected = $derived(
		byKey.get('affected_inventory') ??
			byKey.get('impact') ??
			byKey.get('affected_terminals') ??
			null
	);
	const startFact = $derived(byKey.get('incident_start') ?? null);
	const drivers = $derived(sev.signals.filter((s) => s.rule !== 'incident_type_baseline'));
	/** The reporter's own first words: the "before" of the transformation. */
	const rawReport = $derived.by(() => {
		// Live STT often splits one report into several utterances: join the
		// reporter's words up to SENTINEL's first reply.
		const start = view.transcripts.findIndex((t) => t.speaker === 'user');
		if (start < 0) return null;
		const parts: string[] = [];
		for (const t of view.transcripts.slice(start)) {
			if (t.speaker !== 'user') break;
			parts.push(t.text);
		}
		return { text: parts.join(' '), channel: view.transcripts[start].channel };
	});
	const currentCount = $derived(current.length);
	let showWhy = $state(true);

	const cls = (f: FactView) => classifyFact(f);
</script>

<div class="flex h-full flex-col panel">
	<div class="panel-header">
		<span class="eyebrow">Incident</span>
		<span class="mono text-xs text-ink-400">{incident.code}</span>
	</div>

	<div class="flex flex-1 flex-col gap-5 p-5">
		{#if rawReport}
			<figure class="rounded-md border border-dashed border-ink-600 bg-ink-850/60 px-3 py-2.5">
				<figcaption class="mb-1 flex items-center justify-between eyebrow text-[10px]">
					<span>Raw report · what was said</span>
					<span class="font-normal tracking-normal text-ink-500 normal-case">
						{rawReport.channel === 'typed' ? 'typed' : 'voice → AssemblyAI transcript'}
					</span>
				</figcaption>
				<blockquote class="line-clamp-3 text-[13.5px] leading-relaxed text-ink-300 italic">
					“{rawReport.text}”
				</blockquote>
				<p class="mt-2 flex items-center gap-2 text-[11px] text-voice" aria-hidden="true">
					<span>↓</span>
					<span class="tracking-[0.14em] uppercase">
						Structured by SENTINEL: {currentCount} facts · {view.actions.length} actions · {view.checklist.filter(
							(c) => c.state === 'open'
						).length} unknowns
					</span>
				</p>
			</figure>
		{/if}
		<div>
			<h1 class="text-2xl leading-tight font-semibold tracking-tight text-ink-100">
				{incident.title}
			</h1>
			<p class="mt-1 text-sm text-ink-300">
				{getPlaybook(incident.type).label}
				{#if incident.location}
					<span class="text-ink-500">·</span> {incident.location}
				{:else}
					<span class="text-ink-500">· location unknown</span>
				{/if}
			</p>
		</div>

		<div class="grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3">
			<div>
				<p class="mb-1.5 eyebrow">Severity</p>
				<SeverityBadge level={sev.level} provisional={sev.provisional} size="lg" />
			</div>
			<div>
				<p class="mb-1.5 eyebrow">Started</p>
				{#if incident.startedAt}
					<p class="text-sm text-ink-100">
						{incident.startedAtPrecision === 'approximate' ? '~' : ''}{fmtRelative(
							incident.startedAt,
							now
						)}
					</p>
					<p class="mono text-[11px] text-ink-400">
						{incident.startedAtPrecision === 'approximate' ? '≈ ' : ''}{fmtClock(
							incident.startedAt,
							false
						)}
						{#if startFact}
							<button
								class="ml-1 underline decoration-ink-600 underline-offset-2 hover:text-ink-200"
								onclick={() => onSelectFact(startFact.id)}
							>
								{incident.startedAtPrecision}
							</button>
						{/if}
					</p>
				{:else}
					<p class="flex items-center gap-1 text-sm text-ink-400">
						<CircleHelp class="size-3.5" /> Unknown
					</p>
				{/if}
			</div>
			<div>
				<p class="mb-1.5 eyebrow">Reported</p>
				<p class="mono text-sm text-ink-100">{fmtClock(incident.reportedAt)}</p>
				<p class="text-[11px] text-ink-400">{fmtRelative(incident.reportedAt, now)}</p>
			</div>
		</div>

		{#if headline || affected}
			<div class="grid gap-3 sm:grid-cols-2">
				{#if headline}
					<button
						class="rounded-md border border-ink-700 bg-ink-850 p-3 text-left transition-colors hover:border-ink-500"
						onclick={() => onSelectFact(headline.id)}
					>
						<p class="mb-1 eyebrow">{headline.label}</p>
						<p class="mono text-3xl font-semibold text-ink-100">{formatFactValue(headline)}</p>
						<div class="mt-1.5 flex flex-wrap items-center gap-2">
							<EpistemicBadge cls={cls(headline)} />
							{#if previousHeadline}
								<span class="text-[11px] text-ink-400"
									>was <s>{formatFactValue(previousHeadline)}</s></span
								>
							{/if}
						</div>
					</button>
				{/if}
				{#if affected}
					<button
						class="rounded-md border border-ink-700 bg-ink-850 p-3 text-left transition-colors hover:border-ink-500"
						onclick={() => onSelectFact(affected.id)}
					>
						<p class="mb-1 eyebrow">{affected.label}</p>
						<p class="text-[15px] font-medium text-ink-100">{affected.value}</p>
						<div class="mt-1.5"><EpistemicBadge cls={cls(affected)} /></div>
					</button>
				{/if}
			</div>
		{/if}

		<div class="rounded-md border border-ink-700/80">
			<button
				class="flex w-full items-center justify-between px-3 py-2 text-left"
				onclick={() => (showWhy = !showWhy)}
				aria-expanded={showWhy}
			>
				<span class="text-xs font-medium text-ink-200">Why {sev.level.toUpperCase()}?</span>
				<ChevronDown
					class={['size-4 text-ink-400 transition-transform', showWhy && 'rotate-180']}
				/>
			</button>
			{#if showWhy}
				<div class="space-y-1.5 border-t border-ink-700/80 px-3 py-2.5 text-[13px]">
					{#if sev.override}
						<p class="text-ink-200">
							Set manually: {sev.override.reason}
							<span class="text-ink-500">(computed: {sev.computedLevel})</span>
						</p>
					{/if}
					{#each drivers as s (s.rule)}
						<p class="flex gap-2 text-ink-200">
							<span
								class={[
									'mt-px w-14 shrink-0 mono text-[10.5px] font-semibold uppercase',
									s.level === 'critical'
										? 'text-crit'
										: s.level === 'high'
											? 'text-high'
											: 'text-med'
								]}>{s.level}</span
							>
							<span>{s.reason}</span>
						</p>
					{:else}
						<p class="text-ink-400">Baseline for this incident type. No aggravating facts yet.</p>
					{/each}
					{#each sev.mitigations as m (m.reason)}
						<p class="flex gap-2 text-ink-300">
							<span class="mt-px w-14 shrink-0 mono text-[10.5px] font-semibold text-ok uppercase"
								>mitig.</span
							>{m.reason}
						</p>
					{/each}
					{#if sev.provisional}
						<p class="pt-1 text-[12px] text-warn">
							Provisional: {sev.openCriticalUnknowns.map((k) => k.replace(/_/g, ' ')).join(', ')} still
							unknown.
						</p>
					{/if}
					<p class="pt-1 text-[11px] text-ink-500">{sev.disclaimer}</p>
				</div>
			{/if}
		</div>
	</div>
</div>
