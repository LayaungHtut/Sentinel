<script lang="ts">
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import {
		ArrowRight,
		AudioLines,
		Cpu,
		Database,
		FileText,
		ListChecks,
		Mic,
		RotateCcw,
		ShieldCheck,
		Siren,
		Workflow
	} from '@lucide/svelte';
	import Brand from '$lib/components/dashboard/Brand.svelte';
	import SeverityBadge from '$lib/components/incident/SeverityBadge.svelte';
	import StatusBadge from '$lib/components/incident/StatusBadge.svelte';
	import { DEMO_SCENARIOS } from '$lib/demo/scenarios';
	import { getPlaybook } from '$lib/domain/playbooks';
	import { fmtDateTime } from '$lib/utils/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let resetting = $state(false);

	const loop = [
		{ icon: Mic, label: 'Voice' },
		{ icon: AudioLines, label: 'Transcript' },
		{ icon: Database, label: 'Evidence' },
		{ icon: ListChecks, label: 'Action' },
		{ icon: Workflow, label: 'Escalation' },
		{ icon: Cpu, label: 'Report' }
	];

	async function resetDemo() {
		if (!confirm('Delete all incidents and restore the demo seed data?')) return;
		resetting = true;
		try {
			const res = await fetch('/api/demo/reset', { method: 'POST' });
			if (!res.ok) alert((await res.json()).message ?? 'Reset failed');
			await invalidateAll();
		} finally {
			resetting = false;
		}
	}
</script>

<div class="mx-auto flex min-h-screen max-w-6xl flex-col px-5 pb-16">
	<header class="flex items-center justify-between py-5">
		<Brand />
		<div class="flex items-center gap-3 text-xs text-ink-400">
			<span class="flex items-center gap-1.5">
				<span class={['size-1.5 rounded-full', data.voiceConfigured ? 'bg-ok' : 'bg-warn']}></span>
				Voice {data.voiceConfigured ? 'ready' : 'not configured'}
			</span>
			<span class="flex items-center gap-1.5">
				<span class={['size-1.5 rounded-full', data.dbDriver ? 'bg-ok' : 'bg-crit']}></span>
				{data.dbDriver
					? `PostgreSQL (${data.dbDriver === 'pglite' ? 'embedded' : 'server'})`
					: 'Database offline'}
			</span>
		</div>
	</header>

	<section class="grid gap-10 pt-10 pb-12 lg:grid-cols-[1.25fr_1fr] lg:items-center">
		<div>
			<p class="mb-4 eyebrow text-high">Voice-operated incident response</p>
			<h1
				class="text-4xl leading-[1.08] font-semibold tracking-tight text-balance text-ink-100 sm:text-5xl"
			>
				Turn a messy spoken incident<br />
				<span class="text-ink-400">into evidence-backed action.</span>
			</h1>
			<p class="mt-5 max-w-xl text-[15px] leading-relaxed text-ink-300">
				Tell SENTINEL what happened, in your own words. It asks only the questions that matter,
				records every fact with where it came from and how certain it is, keeps what's unknown
				visible, tracks the actions, escalates when nobody responds, and hands you a report built
				from the record.
			</p>

			<div class="mt-8 flex flex-wrap items-center gap-3">
				<a
					href="{resolve('/incidents/new')}?scenario=refrigeration"
					class="btn-primary px-5 py-2.5 text-[15px]"
					data-sveltekit-preload-data="off"
				>
					<Siren class="size-4" /> Run live demo
				</a>
				<a href={resolve('/incidents/new')} class="btn-secondary px-4 py-2.5">
					Start a real incident <ArrowRight class="size-4" />
				</a>
			</div>
			{#if !data.voiceConfigured}
				<p
					class="mt-4 max-w-xl rounded-md border border-warn/30 bg-warn/5 px-3 py-2 text-xs text-warn"
				>
					Voice needs <code class="mono">ASSEMBLYAI_API_KEY</code> in
					<code class="mono">.env</code>. Until it is set, you can still create and manage incidents
					manually.
				</p>
			{/if}
			{#if data.dbError}
				<p class="mt-4 rounded-md border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit">
					{data.dbError}
				</p>
			{/if}
		</div>

		<div class="panel p-5">
			<p class="mb-4 eyebrow">Every word becomes accountable state</p>
			<ol class="grid grid-cols-3 gap-2">
				{#each loop as step, i (step.label)}
					{@const Icon = step.icon}
					<li
						class="relative flex flex-col items-center gap-2 rounded-md border border-ink-700 bg-ink-850 px-2 py-3 text-center"
					>
						<span class="absolute top-1.5 left-2 mono text-[10px] text-ink-500">{i + 1}</span>
						<Icon
							class={[
								'size-5',
								step.label === 'Voice' || step.label === 'Transcript'
									? 'text-voice'
									: 'text-ink-300'
							]}
						/>
						<span class="text-xs font-medium text-ink-200">{step.label}</span>
					</li>
				{/each}
			</ol>
			<p class="mt-2 text-[11px] text-ink-500">
				<span class="text-voice">Blue stages</span> run on the AssemblyAI Voice Agent API (speech, turn-taking,
				tool calls). The rest is SENTINEL: validated tools, PostgreSQL, rules.
			</p>
			<div class="mt-4 space-y-2 border-t border-ink-700 pt-4 text-[13px] text-ink-300">
				<p class="flex gap-2">
					<ShieldCheck class="mt-0.5 size-4 shrink-0 text-ok" /> Every fact links back to the words it
					came from.
				</p>
				<p class="flex gap-2">
					<span class="mt-px w-4 shrink-0 text-center mono text-warn">≈</span> “About twenty minutes”
					is kept approximate, never rounded into certainty.
				</p>
				<p class="flex gap-2">
					<span class="mt-px w-4 shrink-0 text-center mono text-ink-400">?</span> Unknowns are first-class,
					so you can see what still needs asking.
				</p>
				<p class="flex gap-2">
					<span class="mt-px w-4 shrink-0 text-center mono text-high">!</span> Nothing is shown as sent
					unless it really was.
				</p>
			</div>
		</div>
	</section>

	<section class="grid gap-6 lg:grid-cols-[1fr_1.6fr]">
		<div>
			<h2 class="mb-3 eyebrow">Demo scenarios</h2>
			<div class="space-y-3">
				{#each DEMO_SCENARIOS as s (s.id)}
					<a
						href="{resolve('/incidents/new')}?scenario={s.id}"
						class="group block panel p-4 transition-colors hover:border-ink-500"
					>
						<div class="flex items-start justify-between gap-3">
							<div>
								<p class="font-medium text-ink-100">{s.title}</p>
								<p class="mt-0.5 text-xs text-ink-400">{s.organization} · {s.site}</p>
							</div>
							<ArrowRight
								class="size-4 text-ink-500 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-200"
							/>
						</div>
						<p class="mt-2 text-[13px] text-ink-300">{s.blurb}</p>
					</a>
				{/each}
				<p class="text-[11.5px] leading-relaxed text-ink-500">
					Demo organisations and people are fictional. In demo mode, replies from maintenance and
					managers are simulated and labelled as simulated.
				</p>
				{#if data.demoResetEnabled}
					<button class="btn-ghost text-xs" onclick={resetDemo} disabled={resetting}>
						<RotateCcw class="size-3.5" /> Reset demo data
					</button>
				{/if}
			</div>
		</div>

		<div>
			<h2 class="mb-3 eyebrow">Incidents</h2>
			<div class="overflow-hidden panel">
				{#if data.incidents.length === 0}
					<p class="p-6 text-sm text-ink-400">No incidents yet. Start one by voice.</p>
				{:else}
					<ul class="divide-y divide-ink-700/70">
						{#each data.incidents as inc (inc.id)}
							<li>
								<button
									class="grid w-full grid-cols-[auto_1fr_auto] items-center gap-4 px-4 py-3 text-left hover:bg-ink-850"
									onclick={() => goto(resolve('/incidents/[id]', { id: inc.id }))}
								>
									<span class="mono text-xs text-ink-400">{inc.code}</span>
									<span class="min-w-0">
										<span class="block truncate text-sm font-medium text-ink-100">{inc.title}</span>
										<span class="block truncate text-xs text-ink-400">
											{getPlaybook(inc.type).label}{inc.location ? ` · ${inc.location}` : ''} · {fmtDateTime(
												inc.reportedAt
											)}
											{#if inc.isDemo}<span class="ml-1 text-ink-500">· demo</span>{/if}
										</span>
									</span>
									<span class="flex items-center gap-2">
										{#if inc.openEscalations}
											<span class="mono text-[11px] text-crit">{inc.openEscalations} esc</span>
										{/if}
										{#if inc.severity}<SeverityBadge level={inc.severity} size="sm" />{/if}
										<StatusBadge status={inc.status} size="sm" />
									</span>
								</button>
							</li>
						{/each}
					</ul>
				{/if}
			</div>
			<p class="mt-3 flex items-center gap-1.5 text-xs text-ink-500">
				<FileText class="size-3.5" /> Reports are compiled from the incident record, not written from
				an AI's memory.
			</p>
		</div>
	</section>
</div>
