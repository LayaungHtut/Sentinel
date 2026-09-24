<script lang="ts">
	import { goto, replaceState } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { CircleAlert, FileText, FlaskConical, LoaderCircle, WifiOff } from '@lucide/svelte';
	import Brand from './Brand.svelte';
	import ManualCreate from './ManualCreate.svelte';
	import IncidentSummary from '$lib/components/incident/IncidentSummary.svelte';
	import SeverityBadge from '$lib/components/incident/SeverityBadge.svelte';
	import StatusBadge from '$lib/components/incident/StatusBadge.svelte';
	import VoicePanel from '$lib/components/voice/VoicePanel.svelte';
	import EvidencePanel from '$lib/components/evidence/EvidencePanel.svelte';
	import ProvenanceDrawer from '$lib/components/evidence/ProvenanceDrawer.svelte';
	import OperationalState from '$lib/components/incident/OperationalState.svelte';
	import ActionPanel from '$lib/components/actions/ActionPanel.svelte';
	import TimelinePanel from '$lib/components/timeline/TimelinePanel.svelte';
	import { VoiceAgent } from '$lib/voice/agent.svelte';
	import { getScenario } from '$lib/demo/scenarios';
	import { INCIDENT_TRANSITIONS } from '$lib/domain/state-machine';
	import type { IncidentView } from '$lib/domain/view';

	let {
		initialView,
		scenarioId,
		voiceConfigured
	}: { initialView: IncidentView | null; scenarioId: string | null; voiceConfigured: boolean } =
		$props();

	// Seeded once from the load data; the page re-keys this component per incident.
	// svelte-ignore state_referenced_locally
	let view = $state.raw<IncidentView | null>(initialView);
	let now = $state(Date.now());
	let selectedFactId = $state<string | null>(null);
	/** Transcript text to highlight in the conversation (fact → source navigation). */
	let highlightText = $state<string | null>(null);
	let toast = $state<{ text: string; tone: 'ok' | 'error' | 'info' } | null>(null);
	let loadError = $state<string | null>(null);
	let checking = false;
	let refreshSeq = 0;

	const placeholders = [
		{
			title: 'Evidence',
			text: 'Each fact you mention shows up here with its source, how certain it is, and whether it has been verified. Missing information is listed separately.'
		},
		{
			title: 'Actions',
			text: 'Response actions appear here once SENTINEL understands the risk. Each has an owner, a status and a response timer.'
		},
		{
			title: 'Evidence timeline',
			text: 'A timestamped record of everything that was said, recorded and done, with no invented events.'
		}
	];

	const agent = new VoiceAgent();
	// svelte-ignore state_referenced_locally
	const scenario = getScenario(scenarioId);

	const incidentId = $derived(view?.incident.id ?? agent.incidentId);
	const status = $derived(view?.incident.status ?? null);
	const finished = $derived(status === 'closed');
	const isDemo = $derived(view?.incident.isDemo ?? !!scenario);
	const nextStatuses = $derived(
		status ? INCIDENT_TRANSITIONS[status].filter((s) => s !== 'closed') : []
	);

	agent.onIncidentChanged = (id) => {
		if (!id) return;
		void refresh(id);
		if (page.url.pathname === '/incidents/new') {
			// Shallow URL update: keep this component (and the live voice session) mounted.
			replaceState(resolve('/incidents/[id]', { id }), {});
		}
	};

	async function refresh(id = incidentId) {
		if (!id) return;
		const seq = ++refreshSeq;
		try {
			const res = await fetch(`/api/incidents/${id}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const next = (await res.json()) as IncidentView;
			if (seq === refreshSeq) {
				view = next;
				loadError = null;
			}
		} catch {
			loadError = 'Lost contact with the SENTINEL server. Retrying…';
		}
	}

	function flash(text: string, tone: 'ok' | 'error' | 'info' = 'info') {
		toast = { text, tone };
		const current = toast;
		setTimeout(() => {
			if (toast === current) toast = null;
		}, 5000);
	}

	/** Operator path: same server tools the voice agent uses, origin "operator". */
	async function runTool(name: string, args: Record<string, unknown>): Promise<boolean> {
		try {
			const res = await fetch(`/api/tools/${name}`, {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ incidentId, arguments: args })
			});
			const body = await res.json().catch(() => ({}));
			if (!res.ok || !body.ok) {
				flash(body.error ?? body.message ?? `Could not ${name.replace(/_/g, ' ')}`, 'error');
				return false;
			}
			flash(body.message ?? 'Saved', 'ok');
			await refresh(body.incidentId ?? incidentId);
			agent.refreshContext();
			return true;
		} catch {
			flash('Server unreachable — nothing was saved.', 'error');
			return false;
		}
	}

	async function simulate(kind: 'contact_responds' | 'escalation_acknowledged') {
		if (!incidentId) return;
		const res = await fetch(`/api/incidents/${incidentId}/simulate`, {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ kind })
		});
		const body = await res.json().catch(() => ({}));
		if (!res.ok || !body.ok) {
			flash(body.message ?? body.error ?? 'Simulation failed', 'error');
			return;
		}
		await refresh();
		const latest = view?.timeline.at(-1)?.description ?? body.message;
		flash(`Demo simulation: ${latest}`, 'info');
		if (agent.active) agent.notifySystemEvent(`${latest}`);
	}

	/** Response-timeout rule: ask the server to evaluate once something is due. */
	async function checkEscalations() {
		if (!incidentId || !view || checking) return;
		const due = view.actions.some(
			(a) =>
				a.requiresResponse &&
				a.status === 'in_progress' &&
				!a.responseReceivedAt &&
				a.responseDueAt &&
				new Date(a.responseDueAt).getTime() <= Date.now()
		);
		if (!due) return;
		checking = true;
		try {
			const res = await fetch(`/api/incidents/${incidentId}/escalation-check`, { method: 'POST' });
			const body = (await res.json()) as {
				created?: { target: string; reason: string; simulated: boolean }[];
			};
			await refresh();
			for (const c of body.created ?? []) {
				const text = `${c.reason}. Escalated to ${c.target}${c.simulated ? ' (demo simulation, no real message sent)' : ' (no notification channel is configured, so someone must contact them directly)'}.`;
				flash(text, 'error');
				if (agent.active) agent.notifySystemEvent(text);
			}
		} finally {
			checking = false;
		}
	}

	// Clock + rule evaluation tick.
	$effect(() => {
		const tick = setInterval(() => {
			now = Date.now();
			void checkEscalations();
		}, 1000);
		return () => clearInterval(tick);
	});

	// Background refresh keeps the dashboard honest if another tab/operator changes the record.
	$effect(() => {
		const id = incidentId;
		if (!id) return;
		const poll = setInterval(() => refresh(id), 5000);
		return () => clearInterval(poll);
	});

	// Leaving the page ends the voice session cleanly (session.end stops billing).
	$effect(() => () => void agent.end());

	function startVoice() {
		void agent.start({ incidentId: view?.incident.id ?? null, scenario: scenarioId });
	}

	async function changeStatus(e: Event & { currentTarget: HTMLSelectElement }) {
		const to = e.currentTarget.value;
		e.currentTarget.value = '';
		if (!to) return;
		if (to === '__close') {
			const summary = prompt('Resolution summary');
			if (summary)
				await runTool('close_incident', { final_status: 'closed', resolution_summary: summary });
			return;
		}
		const reason = prompt(`Reason for moving to ${to.toUpperCase()}?`, 'Operator update');
		if (reason !== null)
			await runTool('update_incident', { status: to, reason: reason || 'Operator update' });
	}

	async function generateReport() {
		if (await runTool('generate_incident_report', {}))
			await goto(resolve('/incidents/[id]/report', { id: incidentId! }));
	}
</script>

<svelte:window onpagehide={() => agent.endOnPageHide()} />

<div class="min-h-screen">
	<header class="sticky top-0 z-30 border-b border-ink-700/80 bg-ink-950/90 backdrop-blur">
		<div class="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-5 gap-y-2 px-4 py-2.5">
			<Brand compact />
			<div class="flex min-w-0 flex-1 flex-wrap items-center gap-x-3 gap-y-1.5">
				{#if view}
					<span class="mono text-sm text-ink-300">{view.incident.code}</span>
					<StatusBadge status={view.incident.status} />
					<SeverityBadge
						level={view.severityAssessment.level}
						provisional={view.severityAssessment.provisional}
					/>
				{:else}
					<span class="text-sm text-ink-400">New incident, waiting for a report</span>
				{/if}
				{#if isDemo}
					<span
						class="flex items-center gap-1 rounded border border-voice/40 px-1.5 py-0.5 text-[10px] font-semibold tracking-[0.12em] text-voice uppercase"
					>
						<FlaskConical class="size-3" /> Demo data
					</span>
				{/if}
			</div>
			{#if view}
				<div class="flex items-center gap-2">
					{#if !finished}
						<select
							class="rounded-md border border-ink-600 bg-ink-800 py-1 pr-7 pl-2 text-xs text-ink-200 focus:border-voice focus:ring-0"
							aria-label="Change incident status"
							onchange={changeStatus}
						>
							<option value="">Set status…</option>
							{#each nextStatuses as s (s)}<option value={s}>→ {s.toUpperCase()}</option>{/each}
							<option value="__close">Close incident…</option>
						</select>
					{/if}
					<button
						class="btn-secondary text-xs"
						onclick={generateReport}
						disabled={finished && !!view.latestReport}
					>
						<FileText class="size-3.5" /> Generate report
					</button>
					{#if view.latestReport}
						<a
							class="btn-ghost text-xs"
							href={resolve('/incidents/[id]/report', { id: view.incident.id })}
							>View report v{view.latestReport.version}</a
						>
					{/if}
					<a
						class="btn-ghost text-xs"
						href={resolve('/incidents/[id]/replay', { id: view.incident.id })}>Replay</a
					>
				</div>
			{/if}
		</div>
		{#if agent.status === 'reconnecting'}
			<div
				class="flex items-center justify-center gap-2 border-t border-warn/30 bg-warn/10 py-1.5 text-xs font-medium text-warn"
			>
				<WifiOff class="size-3.5" /> VOICE CONNECTION LOST, reconnecting (attempt {agent.reconnectAttempt}).
				Incident data is safe.
				<LoaderCircle class="size-3.5 animate-spin" />
			</div>
		{/if}
		{#if loadError}
			<div
				class="flex items-center justify-center gap-2 border-t border-crit/30 bg-crit/10 py-1.5 text-xs text-crit"
			>
				<CircleAlert class="size-3.5" />
				{loadError}
			</div>
		{/if}
	</header>

	<main class="mx-auto grid max-w-[1600px] gap-4 p-4 xl:grid-cols-12">
		<section class="xl:col-span-5">
			{#if view}
				<IncidentSummary {view} {now} onSelectFact={(id) => (selectedFactId = id)} />
			{:else}
				<div class="flex h-full flex-col panel">
					<div class="panel-header">
						<span class="eyebrow">Incident</span><span class="mono text-xs text-ink-500"
							>not yet created</span
						>
					</div>
					<div class="flex flex-1 flex-col justify-center gap-4 p-6">
						<div>
							<p class="text-xl font-semibold text-ink-100">
								{agent.active ? 'Listening for the report…' : 'Describe what happened.'}
							</p>
							<p class="mt-2 max-w-md text-sm leading-relaxed text-ink-400">
								Press <span class="text-ink-200">Start incident</span> and speak naturally. SENTINEL opens
								the record as soon as it understands the problem, then fills in facts, unknowns and actions
								as you talk.
							</p>
						</div>
						{#if scenario}
							<p
								class="rounded-md border border-voice/30 bg-voice/5 px-3 py-2 text-[12.5px] text-ink-300"
							>
								<span class="font-medium text-voice">Demo:</span>
								{scenario.title}, {scenario.site} ({scenario.organization}). Suggested lines are in
								the voice panel.
							</p>
						{/if}
						{#if !agent.active}
							<ManualCreate onCreated={(id) => goto(resolve('/incidents/[id]', { id }))} />
						{/if}
					</div>
				</div>
			{/if}
		</section>

		<section class="xl:col-span-7">
			<VoicePanel
				{agent}
				{voiceConfigured}
				{scenario}
				{now}
				hasIncident={!!view}
				incidentClosed={finished}
				history={view?.transcripts ?? []}
				sessions={view?.voiceSessions ?? []}
				{highlightText}
				onStart={startVoice}
			/>
		</section>

		{#if view}
			<section class="xl:col-span-4">
				<OperationalState {view} onSelectFact={(id) => (selectedFactId = id)} />
			</section>
			<section class="xl:col-span-4">
				<EvidencePanel
					{view}
					onSelectFact={(id) => (selectedFactId = id)}
					{runTool}
					readOnly={finished}
				/>
			</section>
			<section class="xl:col-span-4">
				<ActionPanel
					{view}
					{now}
					{runTool}
					{simulate}
					readOnly={finished}
					onSelectFact={(id) => (selectedFactId = id)}
				/>
			</section>
			<section class="xl:col-span-12">
				<TimelinePanel {view} {runTool} readOnly={finished} />
			</section>
		{:else}
			{#each placeholders as p (p.title)}
				<section class={p.title === 'Evidence timeline' ? 'xl:col-span-12' : 'xl:col-span-4'}>
					<div class="h-full min-h-44 panel">
						<div class="panel-header"><span class="eyebrow">{p.title}</span></div>
						<p class="px-4 py-6 text-[13px] leading-relaxed text-ink-500">{p.text}</p>
					</div>
				</section>
			{/each}
		{/if}
	</main>

	{#if toast}
		<div
			class={[
				'enter fixed right-4 bottom-4 z-50 max-w-md rounded-md border px-4 py-2.5 text-[13px] shadow-xl',
				toast.tone === 'ok' && 'border-ok/40 bg-ink-850 text-ink-100',
				toast.tone === 'error' && 'border-crit/50 bg-ink-850 text-ink-100',
				toast.tone === 'info' && 'border-voice/40 bg-ink-850 text-ink-100'
			]}
			role="status"
		>
			{toast.text}
		</div>
	{/if}

	{#if view && selectedFactId}
		<ProvenanceDrawer
			{view}
			factId={selectedFactId}
			onClose={() => (selectedFactId = null)}
			onShowInConversation={(text) => {
				highlightText = text;
				selectedFactId = null;
				setTimeout(() => {
					if (highlightText === text) highlightText = null;
				}, 6000);
			}}
		/>
	{/if}
</div>
