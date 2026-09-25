<script lang="ts">
	import { BellRing, FlaskConical, ListChecks, MessageSquareReply, Plus } from '@lucide/svelte';
	import { ACTION_TRANSITIONS } from '$lib/domain/state-machine';
	import { ACTION_TONE } from '$lib/components/ui/tones';
	import NotificationBadge from './NotificationBadge.svelte';
	import type { ActionStatus } from '$lib/domain/types';
	import type { ActionView, IncidentView } from '$lib/domain/view';
	import { fmtClock, fmtCountdown } from '$lib/utils/format';

	let {
		view,
		now,
		runTool,
		simulate,
		readOnly,
		onSelectFact
	}: {
		view: IncidentView;
		now: number;
		runTool: (name: string, args: Record<string, unknown>) => Promise<boolean>;
		simulate: (kind: 'contact_responds' | 'escalation_acknowledged') => Promise<void>;
		readOnly: boolean;
		onSelectFact: (id: string) => void;
	} = $props();

	const factsById = $derived(new Map(view.facts.map((f) => [f.id, f])));

	const STATUS_ICON: Record<ActionStatus, string> = {
		pending: '○',
		in_progress: '●',
		completed: '✓',
		blocked: '✕',
		escalated: '!',
		cancelled: '–'
	};

	const awaiting = (a: ActionView) =>
		a.requiresResponse && a.status === 'in_progress' && a.responseDueAt && !a.responseReceivedAt;
	const hasAwaiting = $derived(view.actions.some(awaiting));
	const openEscalations = $derived(view.escalations.filter((e) => e.status === 'open'));

	const loadedAt = Date.now();
	const isNew = (iso: string) => new Date(iso).getTime() > loadedAt;

	let adding = $state(false);
	let newAction = $state({ title: '', priority: 'high', contact_role: '' });
	let responding = $state<number | null>(null);
	let response = $state({ responder: '', text: '' });

	async function setStatus(a: ActionView, status: string) {
		if (status === a.status) return;
		const args: Record<string, unknown> = { action: a.seq, status };
		if (status === 'blocked') {
			const reason = prompt(`What is blocking “${a.title}”?`);
			if (!reason) return;
			args.blocked_reason = reason;
		}
		await runTool('update_action', args);
	}

	async function addAction(e: SubmitEvent) {
		e.preventDefault();
		const ok = await runTool('add_action', {
			actions: [
				{
					title: newAction.title,
					priority: newAction.priority,
					...(newAction.contact_role ? { contact_role: newAction.contact_role } : {})
				}
			]
		});
		if (ok) {
			newAction = { title: '', priority: 'high', contact_role: '' };
			adding = false;
		}
	}

	async function submitResponse(e: SubmitEvent, seq: number) {
		e.preventDefault();
		const ok = await runTool('record_response', {
			action: seq,
			responder: response.responder,
			response: response.text
		});
		if (ok) {
			responding = null;
			response = { responder: '', text: '' };
		}
	}
</script>

<div class="flex h-full flex-col panel">
	<div class="panel-header">
		<span class="flex items-center gap-1.5 eyebrow"><ListChecks class="size-3.5" /> Actions</span>
		<span class="text-[11px] text-ink-400">
			{view.actions.filter((a) => a.status === 'completed').length}/{view.actions.length} done
		</span>
	</div>

	<ol class="divide-y divide-ink-700/60">
		{#each view.actions as a (a.id)}
			{@const due = a.responseDueAt ? (new Date(a.responseDueAt).getTime() - now) / 1000 : 0}
			{@const total =
				a.responseDueAt && a.startedAt
					? (new Date(a.responseDueAt).getTime() - new Date(a.startedAt).getTime()) / 1000
					: 30}
			<li class={['px-4 py-2.5', isNew(a.createdAt) && 'fresh']}>
				<div class="flex items-start gap-3">
					<span class={['mt-0.5 w-4 text-center mono text-sm', ACTION_TONE[a.status].split(' ')[0]]}
						>{STATUS_ICON[a.status]}</span
					>
					<div class="min-w-0 flex-1">
						<p
							class={[
								'text-[14px] leading-snug',
								a.status === 'completed' || a.status === 'cancelled'
									? 'text-ink-400'
									: 'text-ink-100'
							]}
						>
							<span class="mr-1 mono text-[11px] text-ink-500">A{a.seq}</span>{a.title}
						</p>
						<p class="mt-0.5 flex flex-wrap items-center gap-x-2 text-[11px] text-ink-400">
							<span
								class={[
									'rounded border px-1 py-px text-[10px] font-semibold tracking-wider uppercase',
									ACTION_TONE[a.status]
								]}
							>
								{a.status.replace('_', ' ')}
							</span>
							{#if a.priority === 'immediate'}<span class="text-high">immediate</span>{/if}
							{#if a.contactName}<span>contact: {a.contactName}</span>{/if}
							<NotificationBadge status={a.notificationStatus} />
						</p>
						{#if awaiting(a)}
							<div class="mt-1.5">
								<div class="flex items-center justify-between text-[11px]">
									<span class={due > 0 ? 'text-info' : 'text-crit'}>
										{due > 0
											? `Awaiting response from ${a.contactName}`
											: 'No response received — escalating'}
									</span>
									<span class="mono text-ink-300">{fmtCountdown(Math.max(0, due))}</span>
								</div>
								<div class="mt-1 h-1 overflow-hidden rounded-full bg-ink-700">
									<div
										class={[
											'h-full transition-[width] duration-1000 ease-linear',
											due > 0 ? 'bg-info' : 'bg-crit'
										]}
										style:width="{Math.max(0, Math.min(100, (due / total) * 100))}%"
									></div>
								</div>
							</div>
						{/if}
						{#if a.responseSummary}
							<p class="mt-1 text-[12px] text-ok">
								↩ {a.responseSummary}
								<span class="mono text-ink-500">{fmtClock(a.responseReceivedAt)}</span>
							</p>
						{/if}
						{#if a.reasonFactId && factsById.get(a.reasonFactId)}
							{@const rf = factsById.get(a.reasonFactId)!}
							<button
								class="mt-1 block text-left text-[11.5px] text-ink-400 hover:text-ink-200"
								onclick={() => onSelectFact(rf.id)}
								title="Open the evidence behind this action"
							>
								<span class="text-ink-500">because</span>
								<span class="underline decoration-ink-600 underline-offset-2"
									>{rf.label}: {rf.value}</span
								>
							</button>
						{/if}
						{#if a.blockedReason && a.status === 'blocked'}
							<p class="mt-1 text-[12px] text-crit">Blocked: {a.blockedReason}</p>
						{/if}
						{#if responding === a.seq}
							<form class="mt-2 space-y-1.5" onsubmit={(e) => submitResponse(e, a.seq)}>
								<input
									class="input py-1 text-xs"
									placeholder="Who responded"
									bind:value={response.responder}
									required
									maxlength="80"
								/>
								<input
									class="input py-1 text-xs"
									placeholder="What they said"
									bind:value={response.text}
									required
									maxlength="400"
								/>
								<div class="flex justify-end gap-1.5">
									<button
										type="button"
										class="btn-ghost text-xs"
										onclick={() => (responding = null)}>Cancel</button
									>
									<button class="btn-secondary text-xs">Record</button>
								</div>
							</form>
						{/if}
					</div>
					{#if !readOnly && ACTION_TRANSITIONS[a.status].length}
						<div class="flex shrink-0 items-center gap-1">
							{#if a.contactName && !a.responseReceivedAt}
								<button
									class="btn-ghost p-1"
									title="Record a response"
									aria-label="Record a response"
									onclick={() => (responding = a.seq)}
								>
									<MessageSquareReply class="size-3.5" />
								</button>
							{/if}
							<select
								class="rounded border border-ink-700 bg-ink-850 py-0.5 pr-6 pl-1.5 text-[11px] text-ink-300 focus:border-voice focus:ring-0"
								aria-label="Change status of A{a.seq}"
								value={a.status}
								onchange={(e) => setStatus(a, e.currentTarget.value)}
							>
								<option value={a.status} disabled>{a.status.replace('_', ' ')}</option>
								{#each ACTION_TRANSITIONS[a.status].filter((s) => s !== 'escalated') as s (s)}
									<option value={s}>→ {s.replace('_', ' ')}</option>
								{/each}
							</select>
						</div>
					{/if}
				</div>
			</li>
		{:else}
			<li class="px-4 py-6 text-center text-[13px] text-ink-500">
				No actions yet. SENTINEL proposes them once the risk is clear.
			</li>
		{/each}
	</ol>

	{#if !readOnly}
		<div class="border-t border-ink-700/60 px-4 py-2">
			{#if adding}
				<form class="space-y-2 py-1" onsubmit={addAction}>
					<input
						class="input"
						placeholder="Action, e.g. Move dairy to bar fridge"
						bind:value={newAction.title}
						required
						minlength="3"
						maxlength="120"
						aria-label="Action title"
					/>
					<div class="flex items-center gap-2">
						<select
							class="input w-auto py-1 text-xs"
							bind:value={newAction.priority}
							aria-label="Priority"
						>
							<option value="immediate">Immediate</option>
							<option value="high">High</option>
							<option value="normal">Normal</option>
						</select>
						<select
							class="input w-auto py-1 text-xs"
							bind:value={newAction.contact_role}
							aria-label="Contact role"
						>
							<option value="">No contact</option>
							<option value="maintenance">Maintenance</option>
							<option value="branch_manager">Branch manager</option>
							<option value="operations_manager">Operations manager</option>
							<option value="it_support">IT support</option>
							<option value="food_safety">Food safety</option>
						</select>
						<span class="flex-1"></span>
						<button type="button" class="btn-ghost text-xs" onclick={() => (adding = false)}
							>Cancel</button
						>
						<button class="btn-secondary text-xs">Add</button>
					</div>
				</form>
			{:else}
				<button class="-ml-2 btn-ghost text-xs" onclick={() => (adding = true)}
					><Plus class="size-3.5" /> Add action manually</button
				>
			{/if}
		</div>
	{/if}

	{#if view.escalations.length}
		<div class="border-t border-ink-700/70 px-4 py-3">
			<p class="mb-2 flex items-center gap-1.5 eyebrow">
				<BellRing class="size-3.5 text-crit" /> Escalations
			</p>
			<ul class="space-y-2">
				{#each view.escalations as e (e.id)}
					<li
						class={[
							'rounded-md border px-3 py-2 text-[13px]',
							isNew(e.createdAt) && 'fresh',
							e.status === 'open' ? 'border-crit/40 bg-crit/5' : 'border-ink-700 bg-ink-850'
						]}
					>
						<div class="flex items-center justify-between gap-2">
							<span class="font-medium text-ink-100"
								><span class="mr-1 mono text-[11px] text-ink-500">E{e.seq}</span>→ {e.targetName}</span
							>
							<span
								class={[
									'text-[10px] font-semibold tracking-wider uppercase',
									e.status === 'open'
										? 'text-crit'
										: e.status === 'acknowledged'
											? 'text-warn'
											: 'text-ok'
								]}>{e.status}</span
							>
						</div>
						<p class="mt-0.5 text-[12px] text-ink-300">{e.reason}</p>
						<p class="mt-1 flex items-center gap-2 text-[11px]">
							{#if e.simulated}
								<span
									class="rounded border border-voice/40 px-1 text-[10px] font-semibold tracking-wider text-voice uppercase"
									>Demo simulation</span
								>
								<span class="text-ink-500">no real message sent</span>
							{:else}
								<NotificationBadge status={e.notificationStatus} />
							{/if}
							<span class="ml-auto mono text-ink-500">{fmtClock(e.createdAt)}</span>
						</p>
						{#if e.resolutionNote}<p class="mt-1 text-[12px] text-ok">↩ {e.resolutionNote}</p>{/if}
						{#if !readOnly && e.status !== 'resolved' && !e.simulated}
							<div class="mt-1.5 flex gap-1.5">
								{#if e.status === 'open'}
									<button
										class="btn-ghost px-2 py-0.5 text-[11px]"
										onclick={() => {
											const note = prompt('Acknowledgement note');
											if (note)
												runTool('resolve_escalation', {
													escalation: e.seq,
													status: 'acknowledged',
													note
												});
										}}>Acknowledge</button
									>
								{/if}
								<button
									class="btn-ghost px-2 py-0.5 text-[11px]"
									onclick={() => {
										const note = prompt('Resolution note');
										if (note)
											runTool('resolve_escalation', {
												escalation: e.seq,
												status: 'resolved',
												note
											});
									}}>Resolve</button
								>
							</div>
						{/if}
					</li>
				{/each}
			</ul>
		</div>
	{/if}

	{#if view.incident.isDemo && !readOnly}
		<div class="mt-auto border-t border-dashed border-voice/30 bg-voice/[0.03] px-4 py-3">
			<p class="mb-1 flex items-center gap-1.5 eyebrow text-voice">
				<FlaskConical class="size-3.5" /> Demo simulation
			</p>
			<p class="mb-2 text-[11.5px] text-ink-400">
				Stands in for people outside the call. Everything done here is labelled as simulated. With
				no input, a contact that doesn't reply escalates after 30 s (real organisations set their
				own timeout in Settings).
			</p>
			<div class="flex flex-wrap gap-2">
				<button
					class="btn-secondary px-2.5 py-1 text-xs"
					disabled={!hasAwaiting &&
						!view.actions.some((a) => a.status === 'escalated' && !a.responseReceivedAt)}
					onclick={() => simulate('contact_responds')}
				>
					Contact replies
				</button>
				<button
					class="btn-secondary px-2.5 py-1 text-xs"
					disabled={!openEscalations.length}
					onclick={() => simulate('escalation_acknowledged')}
				>
					Manager acknowledges
				</button>
			</div>
		</div>
	{/if}
</div>
