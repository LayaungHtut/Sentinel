<script lang="ts">
	import { History, ListChecks, MessageSquareText, Quote, TriangleAlert, X } from '@lucide/svelte';
	import EpistemicBadge from './EpistemicBadge.svelte';
	import { classifyFact, EPISTEMIC_DESCRIPTIONS, formatFactValue } from '$lib/domain/evidence';
	import { sourceLabel } from '$lib/domain/report';
	import type { FactView, IncidentView } from '$lib/domain/view';
	import { fmtClock, fmtCountdown } from '$lib/utils/format';

	let {
		view,
		factId,
		onClose,
		onShowInConversation
	}: {
		view: IncidentView;
		factId: string;
		onClose: () => void;
		onShowInConversation: (text: string) => void;
	} = $props();

	const byId = $derived(new Map(view.facts.map((f) => [f.id, f])));
	const fact = $derived(byId.get(factId) ?? null);
	const cls = $derived(fact ? classifyFact(fact) : null);
	const transcript = $derived(
		fact?.transcriptId ? (view.transcripts.find((t) => t.id === fact.transcriptId) ?? null) : null
	);

	/** Older values this fact superseded, newest first. */
	const history = $derived.by(() => {
		const out: FactView[] = [];
		let cursor = fact?.supersedesId ? byId.get(fact.supersedesId) : undefined;
		while (cursor && out.length < 20) {
			out.push(cursor);
			cursor = cursor.supersedesId ? byId.get(cursor.supersedesId) : undefined;
		}
		return out;
	});
	const newer = $derived(fact?.supersededById ? (byId.get(fact.supersededById) ?? null) : null);
	const events = $derived(view.timeline.filter((e) => e.refId === factId));
	/** Evidence → action: actions whose recorded reason is this fact (or an earlier value of it). */
	const drivenActions = $derived(
		view.actions.filter(
			(a) =>
				a.reasonFactId &&
				(a.reasonFactId === factId || history.some((h) => h.id === a.reasonFactId))
		)
	);

	/** Split the utterance around the quote so it can be highlighted (best effort, case-insensitive). */
	const highlighted = $derived.by(() => {
		if (!transcript) return null;
		const text = transcript.text;
		const quote = fact?.evidenceQuote?.trim();
		if (!quote) return { before: text, match: '', after: '' };
		const i = text.toLowerCase().indexOf(quote.toLowerCase().replace(/[.,!?]+$/, ''));
		if (i < 0) return { before: text, match: '', after: '' };
		const len = quote.replace(/[.,!?]+$/, '').length;
		return { before: text.slice(0, i), match: text.slice(i, i + len), after: text.slice(i + len) };
	});
</script>

<svelte:window onkeydown={(e) => e.key === 'Escape' && onClose()} />

<div class="fixed inset-0 z-40 bg-black/50" role="presentation" onclick={onClose}></div>
<aside
	class="fixed inset-y-0 right-0 z-50 flex w-full max-w-md flex-col border-l border-ink-700 bg-ink-900 shadow-2xl"
	aria-label="Fact provenance"
>
	<div class="panel-header">
		<span class="eyebrow">Provenance</span>
		<button class="btn-ghost p-1" onclick={onClose} aria-label="Close"><X class="size-4" /></button>
	</div>

	{#if fact && cls}
		<div class="flex-1 space-y-6 overflow-y-auto p-5">
			<div>
				<p class="mb-1 eyebrow">
					{fact.label}
					<span class="ml-1 mono font-normal tracking-normal text-ink-500 normal-case"
						>{fact.key}</span
					>
				</p>
				<p class="mono text-3xl font-semibold text-ink-100">{formatFactValue(fact)}</p>
				<div class="mt-2 flex items-center gap-2">
					<EpistemicBadge {cls} />
					{#if fact.status !== 'current'}
						<span
							class="rounded border border-ink-600 px-1.5 py-px text-[10.5px] text-ink-400 uppercase"
							>{fact.status}</span
						>
					{/if}
				</div>
				<p class="mt-2 text-[13px] text-ink-300">{EPISTEMIC_DESCRIPTIONS[cls]}</p>
				{#if newer}
					<p class="mt-2 text-[12px] text-warn">
						Superseded by {formatFactValue(newer)} at {fmtClock(newer.observedAt)}.
					</p>
				{/if}
			</div>

			<dl class="grid grid-cols-2 gap-x-4 gap-y-3 text-[13px]">
				<div>
					<dt class="mb-0.5 eyebrow text-[10px]">Source</dt>
					<dd class="text-ink-100">{sourceLabel(fact.sourceType)}</dd>
				</div>
				<div>
					<dt class="mb-0.5 eyebrow text-[10px]">Speaker</dt>
					<dd class="text-ink-100">{fact.speaker ?? '—'}</dd>
				</div>
				<div>
					<dt class="mb-0.5 eyebrow text-[10px]">Recorded</dt>
					<dd class="mono text-ink-100">{fmtClock(fact.observedAt)}</dd>
				</div>
				<div>
					<dt class="mb-0.5 eyebrow text-[10px]">Basis</dt>
					<dd class="text-ink-100">
						{fact.basis === 'stated' ? 'Stated directly' : 'Inferred by SENTINEL'}
					</dd>
				</div>
				<div>
					<dt class="mb-0.5 eyebrow text-[10px]">Precision</dt>
					<dd class="text-ink-100 capitalize">{fact.certainty}</dd>
				</div>
				<div>
					<dt class="mb-0.5 eyebrow text-[10px]">Verification</dt>
					<dd class="text-ink-100 capitalize">
						{fact.verification}{#if fact.confirmedAt}<span
								class="ml-1 mono text-ink-400 normal-case">{fmtClock(fact.confirmedAt)}</span
							>{/if}
					</dd>
				</div>
				{#if fact.confirmationNote}
					<div class="col-span-2">
						<dt class="mb-0.5 eyebrow text-[10px]">Confirmation</dt>
						<dd class="text-ink-100">{fact.confirmationNote}</dd>
					</div>
				{/if}
				{#if fact.note}
					<div class="col-span-2">
						<dt class="mb-0.5 eyebrow text-[10px]">Note</dt>
						<dd class="text-ink-100">{fact.note}</dd>
					</div>
				{/if}
			</dl>

			<section>
				<p class="mb-2 flex items-center gap-1.5 eyebrow"><Quote class="size-3.5" /> Evidence</p>
				{#if transcript && highlighted}
					<figure class="rounded-md border border-ink-700 bg-ink-850 p-3">
						<figcaption class="mb-1.5 flex items-center justify-between text-[11px] text-ink-400">
							<span
								>Reporter · {transcript.channel === 'typed'
									? 'typed message'
									: 'voice transcript (AssemblyAI)'}</span
							>
							<span class="mono">
								{fmtClock(transcript.receivedAt)}{#if transcript.offsetMs != null}
									· +{fmtCountdown(transcript.offsetMs / 1000)}{/if}
							</span>
						</figcaption>
						<blockquote class="text-[14px] leading-relaxed text-ink-200">
							“{highlighted.before}<mark class="rounded bg-voice/25 px-0.5 text-ink-100"
								>{highlighted.match}</mark
							>{highlighted.after}”
						</blockquote>
						<button
							class="mt-2 flex items-center gap-1.5 text-[12px] text-voice hover:underline"
							onclick={() => onShowInConversation(transcript.text)}
						>
							<MessageSquareText class="size-3.5" /> Show in conversation
						</button>
					</figure>
				{:else if fact.evidenceQuote}
					<div class="rounded-md border border-warn/40 bg-warn/5 p-3 text-[13px]">
						<p class="flex items-center gap-1.5 font-medium text-warn">
							<TriangleAlert class="size-4" /> Quote not found in the transcript
						</p>
						<p class="mt-1 text-ink-300">
							SENTINEL cited “{fact.evidenceQuote}”, but no reporter utterance matches it. Treat
							this provenance as weak.
						</p>
					</div>
				{:else}
					<p class="text-[13px] text-ink-400">
						{fact.sourceType === 'operator_entry'
							? 'Entered manually by an operator. No transcript evidence.'
							: fact.basis === 'inferred'
								? 'Inferred by SENTINEL. Nobody said this directly.'
								: 'No quote was captured for this fact.'}
					</p>
				{/if}
			</section>

			<section>
				<p class="mb-2 eyebrow">Evidence chain</p>
				<ol class="flex flex-wrap items-center gap-1.5 text-[11px]">
					{#each [{ label: 'Voice', on: fact.sourceType === 'voice_transcript' }, { label: 'Transcript', on: !!transcript }, { label: 'Fact', on: true }, { label: `Action${drivenActions.length === 1 ? '' : 's'} (${drivenActions.length})`, on: drivenActions.length > 0 }, { label: `Timeline (${events.length})`, on: events.length > 0 }, { label: view.latestReport ? 'Report' : 'Report (not yet)', on: !!view.latestReport }] as step, i (step.label)}
						<li class="flex items-center gap-1.5">
							{#if i}<span class="text-ink-600" aria-hidden="true">→</span>{/if}
							<span
								class={[
									'rounded border px-1.5 py-0.5 font-semibold tracking-wide uppercase',
									step.on ? 'border-voice/50 text-voice' : 'border-ink-700 text-ink-500'
								]}
							>
								{step.on ? '' : '○ '}{step.label}
							</span>
						</li>
					{/each}
				</ol>
				{#if drivenActions.length}
					<ul class="mt-2 space-y-1 text-[12.5px]">
						{#each drivenActions as a (a.id)}
							<li class="flex items-center gap-2 text-ink-200">
								<ListChecks class="size-3.5 text-ink-400" /> A{a.seq}
								{a.title}
								<span class="text-[10.5px] tracking-wide text-ink-400 uppercase"
									>{a.status.replace('_', ' ')}</span
								>
							</li>
						{/each}
					</ul>
				{/if}
			</section>

			{#if history.length}
				<section>
					<p class="mb-2 flex items-center gap-1.5 eyebrow">
						<History class="size-3.5" /> Earlier values (kept, not deleted)
					</p>
					<ol class="space-y-2">
						{#each history as h (h.id)}
							<li class="rounded-md border border-ink-700 px-3 py-2 text-[13px]">
								<div class="flex items-center justify-between">
									<span class="mono text-ink-300 line-through decoration-ink-500"
										>{formatFactValue(h)}</span
									>
									<span class="mono text-[11px] text-ink-500">{fmtClock(h.observedAt)}</span>
								</div>
								<div class="mt-1 flex items-center gap-2 text-[11px] text-ink-400">
									<EpistemicBadge cls={classifyFact(h)} />
									{sourceLabel(h.sourceType)}
									{#if h.evidenceQuote}· “{h.evidenceQuote}”{/if}
								</div>
							</li>
						{/each}
					</ol>
				</section>
			{/if}

			{#if events.length}
				<section>
					<p class="mb-2 eyebrow">Audit trail</p>
					<ol class="space-y-1 text-[12px]">
						{#each events as e (e.id)}
							<li class="flex gap-2 text-ink-300">
								<span class="shrink-0 mono text-ink-500">{fmtClock(e.occurredAt)}</span
								>{e.description}
							</li>
						{/each}
					</ol>
				</section>
			{/if}
		</div>
	{:else}
		<p class="p-5 text-sm text-ink-400">Fact not found.</p>
	{/if}
</aside>
