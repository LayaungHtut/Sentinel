<script lang="ts">
	/**
	 * Honest outreach status. Each label states only what a provider has
	 * confirmed: "sent" means accepted by the provider, "delivered" means a
	 * carrier/provider receipt arrived, never before.
	 */
	let { status }: { status: string | null } = $props();

	const LABELS: Record<string, { text: string; cls: string; title: string }> = {
		simulated: {
			text: 'demo simulation',
			cls: 'text-voice',
			title: 'Demo organisation: no real message is sent'
		},
		not_configured: {
			text: 'not auto-notified',
			cls: 'text-ink-500',
			title: 'No notification channel is set up for this contact; staff contact them directly'
		},
		queued: { text: 'message queued', cls: 'text-info', title: 'Waiting to be sent' },
		sent: {
			text: 'message sent',
			cls: 'text-info',
			title: 'Accepted by the provider; no delivery receipt yet'
		},
		delivered: { text: 'delivered', cls: 'text-ok', title: 'Provider confirmed delivery' },
		failed: {
			text: 'not delivered',
			cls: 'text-crit',
			title: 'The provider reported a failure; contact them directly'
		}
	};
	const label = $derived(status ? LABELS[status] : undefined);
</script>

{#if label}
	<span class={label.cls} title={label.title}>{label.text}</span>
{/if}
