<script lang="ts">
	import type { IncidentReport, ReportAction, ReportFact } from '$lib/domain/report';
	import { fmtClock, fmtDateTime } from '$lib/utils/format';

	let { report }: { report: IncidentReport } = $props();
</script>

{#snippet factTable(facts: ReportFact[], empty: string)}
	{#if facts.length}
		<table class="w-full text-left text-[13px]">
			<tbody class="divide-y divide-ink-700/60 print:divide-gray-300">
				{#each facts as f (f.key)}
					<tr class="align-top">
						<th class="w-40 py-2 pr-3 font-medium text-ink-300 print:text-gray-600">{f.label}</th>
						<td class="py-2 pr-3">
							<span class="font-medium text-ink-100 tabular-nums print:text-black">{f.value}</span>
							{#if f.history.length}
								<span class="ml-1 text-[11px] text-ink-500"
									>(previously {f.history.map((h) => h.value).join(' → ')})</span
								>
							{/if}
							{#if f.quote}
								<p class="mt-0.5 text-[12px] text-ink-400 italic print:text-gray-600">
									“{f.quote}”{#if f.quoteMatched === false}<span class="text-warn not-italic">
											(not traced to transcript)</span
										>{/if}
								</p>
							{/if}
						</td>
						<td class="w-36 py-2 text-right text-[11px] text-ink-400 print:text-gray-600">
							<span class="font-semibold tracking-wide uppercase">{f.classLabel}</span><br
							/>{f.source} · {fmtClock(f.recordedAt)}
						</td>
					</tr>
				{/each}
			</tbody>
		</table>
	{:else}
		<p class="text-[13px] text-ink-500 italic">{empty}</p>
	{/if}
{/snippet}

{#snippet actionList(actions: ReportAction[], empty: string)}
	{#if actions.length}
		<ul class="space-y-1.5 text-[13px]">
			{#each actions as a (a.ref)}
				<li class="flex gap-3">
					<span class="w-8 shrink-0 mono text-ink-500">{a.ref}</span>
					<span class="flex-1 text-ink-100 print:text-black">
						{a.title}
						{#if a.contact}<span class="text-ink-400"> · contact {a.contact}</span>{/if}
						{#if a.response}<span class="block text-[12px] text-ok print:text-gray-700"
								>↩ {a.response}</span
							>{/if}
						{#if a.note}<span class="block text-[12px] text-ink-400">{a.note}</span>{/if}
						{#if a.because}<span class="block text-[12px] text-ink-500">because {a.because}</span
							>{/if}
					</span>
					<span class="shrink-0 text-[11px] font-semibold tracking-wide text-ink-300 uppercase"
						>{a.status.replace('_', ' ')}</span
					>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="text-[13px] text-ink-500 italic">{empty}</p>
	{/if}
{/snippet}

<article class="space-y-8">
	<header class="border-b border-ink-700 pb-6 print:border-gray-300">
		<p class="mb-2 eyebrow">Incident report · {report.code}</p>
		<h1 class="text-3xl font-semibold tracking-tight text-ink-100 print:text-black">
			{report.title}
		</h1>
		<p class="mt-1 text-sm text-ink-300 print:text-gray-700">
			{report.typeLabel}{report.location ? ` · ${report.location}` : ''}
		</p>
		{#if report.isDemo}
			<p
				class="mt-3 inline-block rounded border border-voice/40 px-2 py-0.5 text-[11px] font-semibold tracking-wider text-voice uppercase"
			>
				Demo data — fictional organisation, simulated external responses
			</p>
		{/if}
		<dl class="mt-5 grid grid-cols-2 gap-4 text-[13px] sm:grid-cols-4">
			<div>
				<dt class="mb-0.5 eyebrow">Status</dt>
				<dd class="font-semibold text-ink-100 uppercase print:text-black">{report.status}</dd>
			</div>
			<div>
				<dt class="mb-0.5 eyebrow">Severity</dt>
				<dd class="font-semibold text-ink-100 uppercase print:text-black">
					{report.severity.level}{report.severity.provisional ? ' (provisional)' : ''}
				</dd>
			</div>
			<div>
				<dt class="mb-0.5 eyebrow">Reported</dt>
				<dd class="text-ink-100 print:text-black">{fmtDateTime(report.reportedAt)}</dd>
			</div>
			<div>
				<dt class="mb-0.5 eyebrow">Started</dt>
				<dd class="text-ink-100 print:text-black">
					{report.startedAt
						? `${report.startedAtPrecision === 'approximate' ? '≈ ' : ''}${fmtDateTime(report.startedAt)}`
						: 'Unknown'}
				</dd>
			</div>
		</dl>
	</header>

	<section>
		<h2 class="mb-2 eyebrow">Executive summary</h2>
		<p class="text-[15px] leading-relaxed text-ink-200 print:text-black">
			{report.executiveSummary}
		</p>
	</section>

	<section>
		<h2 class="mb-2 eyebrow">Severity assessment</h2>
		<ul class="list-disc space-y-1 pl-5 text-[13px] text-ink-200 print:text-black">
			{#each report.severity.reasons as r (r)}<li>{r}</li>{/each}
			{#each report.severity.mitigations as m (m)}<li class="text-ok print:text-gray-700">
					Mitigating: {m}
				</li>{/each}
			{#if report.severity.override}<li>Override: {report.severity.override}</li>{/if}
		</ul>
		<p class="mt-2 text-[11px] text-ink-500">{report.severity.disclaimer}</p>
	</section>

	<section>
		<h2 class="mb-2 eyebrow">Confirmed facts</h2>
		{@render factTable(report.confirmedFacts, 'No facts independently confirmed yet.')}
	</section>
	<section>
		<h2 class="mb-2 eyebrow">Reported facts</h2>
		{@render factTable(report.reportedFacts, 'None.')}
	</section>
	<section>
		<h2 class="mb-2 eyebrow">Approximate facts</h2>
		{@render factTable(report.approximateFacts, 'None.')}
	</section>
	<section>
		<h2 class="mb-2 eyebrow">Unverified facts</h2>
		{@render factTable(report.unverifiedFacts, 'None: every stated reading has been confirmed.')}
	</section>
	{#if report.inferredFacts.length}
		<section>
			<h2 class="mb-2 eyebrow">Inferred by SENTINEL (not stated by anyone)</h2>
			{@render factTable(report.inferredFacts, 'None.')}
		</section>
	{/if}
	{#if report.observedFacts?.length}
		<section>
			<h2 class="mb-2 eyebrow">Sensor readings</h2>
			{@render factTable(report.observedFacts, 'None.')}
		</section>
	{/if}

	<section>
		<h2 class="mb-2 eyebrow">Unknown information</h2>
		{#if report.unknowns.length}
			<ul class="space-y-1 text-[13px]">
				{#each report.unknowns as u (u.label)}
					<li class="flex gap-3">
						<span class="w-4 mono text-warn">?</span><span
							class="flex-1 text-ink-100 print:text-black">{u.label}</span
						><span class="text-[12px] text-ink-400">{u.state}</span>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-[13px] text-ink-500 italic">Nothing outstanding.</p>
		{/if}
	</section>

	<div class="grid gap-8 md:grid-cols-2">
		<section>
			<h2 class="mb-2 eyebrow">Actions taken</h2>
			{@render actionList(report.actionsTaken, 'None completed.')}
		</section>
		<section>
			<h2 class="mb-2 eyebrow">Outstanding actions</h2>
			{@render actionList(report.outstandingActions, 'None.')}
		</section>
	</div>

	<section>
		<h2 class="mb-2 eyebrow">Escalations</h2>
		{#if report.escalations.length}
			<ul class="space-y-2 text-[13px]">
				{#each report.escalations as e (e.ref)}
					<li class="rounded border border-ink-700 px-3 py-2 print:border-gray-300">
						<span class="mono text-ink-500">{e.ref}</span> →
						<span class="text-ink-100 print:text-black">{e.target}</span>
						<span class="ml-2 text-[11px] font-semibold uppercase">{e.status}</span>
						<p class="text-ink-300 print:text-gray-700">{e.reason}</p>
						<p class="text-[11px] text-ink-500">
							{e.notification}{e.resolutionNote ? ` · ${e.resolutionNote}` : ''}
						</p>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="text-[13px] text-ink-500 italic">None.</p>
		{/if}
	</section>

	<section>
		<h2 class="mb-2 eyebrow">Evidence timeline</h2>
		<ol class="space-y-1 text-[12.5px]">
			{#each report.timeline as t, i (i)}
				<li class="grid grid-cols-[70px_1fr_auto] gap-3">
					<span class="mono text-ink-500">{fmtClock(t.at)}</span>
					<span class="text-ink-200 print:text-black">{t.description}</span>
					<span class="text-[10px] tracking-wider text-ink-500 uppercase"
						>{t.source.replace('_', ' ')}</span
					>
				</li>
			{/each}
		</ol>
	</section>

	<section>
		<h2 class="mb-2 eyebrow">Current status</h2>
		<p class="text-[14px] text-ink-100 print:text-black">
			<span class="font-semibold uppercase">{report.status}</span>
			· severity {report.severity.level.toUpperCase()}{report.severity.provisional
				? ' (provisional)'
				: ''}
			{#if report.resolvedAt}· resolved {fmtDateTime(report.resolvedAt)}{/if}
		</p>
	</section>

	<section>
		<h2 class="mb-2 eyebrow">Recommended next steps</h2>
		<ol class="list-decimal space-y-1 pl-5 text-[13px] text-ink-200 print:text-black">
			{#each report.recommendedNextSteps as s (s)}<li>{s}</li>{/each}
		</ol>
	</section>

	<footer class="border-t border-ink-700 pt-4 text-[11px] text-ink-500 print:border-gray-300">
		Built by SENTINEL from the incident record ({report.evidenceStats.facts} current facts, {report
			.evidenceStats.factsWithTracedQuote} traced to the transcript, {report.evidenceStats
			.supersededValues} superseded values, {report.evidenceStats.userUtterances} reporter utterances).
		No language model was used to write this report. Generated {fmtDateTime(report.generatedAt)}.
	</footer>
</article>
