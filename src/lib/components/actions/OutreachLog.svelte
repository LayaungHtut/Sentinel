<script lang="ts">
	import { Send } from '@lucide/svelte';
	import type { IncidentView } from '$lib/domain/view';
	import { fmtClock } from '$lib/utils/format';
	import NotificationBadge from './NotificationBadge.svelte';

	let { view }: { view: IncidentView } = $props();

	const CHANNEL: Record<string, string> = {
		sms: 'SMS',
		voice_call: 'Phone call',
		email: 'Email',
		slack: 'Slack',
		webhook: 'Webhook'
	};
</script>

<div class="flex h-full flex-col panel">
	<div class="panel-header">
		<span class="flex items-center gap-1.5 eyebrow"><Send class="size-3.5" /> Outreach log</span>
		<span class="text-[11px] text-ink-400">{view.notifications.length}</span>
	</div>
	{#if view.notifications.length}
		<ul class="divide-y divide-ink-800 px-4 py-1">
			{#each view.notifications as n (n.id)}
				<li class="py-2 text-[12.5px]">
					<div class="flex items-center justify-between gap-2">
						<span class="text-ink-100">
							{CHANNEL[n.channel] ?? n.channel} → {n.contactName ?? 'contact'}
							{#if n.to}<span class="mono text-[11px] text-ink-500">{n.to}</span>{/if}
						</span>
						<span class="text-[11px]"><NotificationBadge status={n.status} /></span>
					</div>
					<p class="mt-0.5 flex flex-wrap gap-x-3 text-[11px] text-ink-500">
						<span>queued {fmtClock(n.createdAt)}</span>
						{#if n.updatedAt !== n.createdAt}<span>updated {fmtClock(n.updatedAt)}</span>{/if}
						{#if n.acknowledgedAt}<span class="text-ok"
								>acknowledged {fmtClock(n.acknowledgedAt)}</span
							>{/if}
					</p>
					{#if n.error}<p class="mt-0.5 text-[11px] text-crit">{n.error}</p>{/if}
				</li>
			{/each}
		</ul>
	{:else}
		<p class="px-4 py-6 text-[13px] text-ink-500">
			{view.incident.isDemo
				? 'Demo organisation: outreach is simulated and never sent.'
				: 'Real messages to contacts appear here with their provider-confirmed status.'}
		</p>
	{/if}
</div>
