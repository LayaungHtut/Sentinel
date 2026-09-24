<script lang="ts">
	import { invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { ArrowLeft, Download, Printer, RefreshCw } from '@lucide/svelte';
	import Brand from '$lib/components/dashboard/Brand.svelte';
	import ReportDocument from '$lib/components/reports/ReportDocument.svelte';
	import type { IncidentReport } from '$lib/domain/report';
	import { fmtDateTime } from '$lib/utils/format';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
	let busy = $state(false);
	let errorText = $state<string | null>(null);

	async function regenerate() {
		busy = true;
		errorText = null;
		try {
			const res = await fetch('/api/tools/generate_incident_report', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ incidentId: data.incidentId, arguments: {} })
			});
			const body = await res.json();
			if (!body.ok) errorText = body.error ?? 'Could not generate report';
			await invalidateAll();
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head><title>{data.code} report — SENTINEL</title></svelte:head>

<div class="mx-auto max-w-4xl px-5 pb-16 print:max-w-none print:px-0">
	<header class="no-print flex flex-wrap items-center justify-between gap-3 py-5">
		<div class="flex items-center gap-4">
			<Brand compact />
			<a href={resolve('/incidents/[id]', { id: data.incidentId })} class="btn-ghost text-xs"
				><ArrowLeft class="size-3.5" /> Back to incident</a
			>
		</div>
		<div class="flex items-center gap-2">
			{#if data.report}
				<span class="text-[11px] text-ink-500"
					>v{data.report.version} · {fmtDateTime(data.report.generatedAt)}</span
				>
				<a
					class="btn-ghost text-xs"
					href={resolve('/api/incidents/[id]/report', { id: data.incidentId })}
					download><Download class="size-3.5" /> Markdown</a
				>
				<button class="btn-ghost text-xs" onclick={() => window.print()}
					><Printer class="size-3.5" /> Print</button
				>
			{/if}
			<button class="btn-secondary text-xs" onclick={regenerate} disabled={busy}>
				<RefreshCw class={['size-3.5', busy && 'animate-spin']} />
				{data.report ? 'Regenerate from current state' : 'Generate report'}
			</button>
		</div>
	</header>
	{#if errorText}<p class="mb-4 text-sm text-crit">{errorText}</p>{/if}

	<div class="panel p-8 print:border-0 print:p-0">
		{#if data.report}
			<ReportDocument report={data.report.content as IncidentReport} />
		{:else}
			<p class="text-sm text-ink-400">No report has been generated for {data.code} yet.</p>
		{/if}
	</div>
</div>
