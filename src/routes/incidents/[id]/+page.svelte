<script lang="ts">
	import CommandCenter from '$lib/components/dashboard/CommandCenter.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>{data.view.incident.code} — SENTINEL</title></svelte:head>

{#key data.view.incident.id}
	<CommandCenter
		initialView={data.view}
		scenarioId={data.view.incident.scenario}
		voiceConfigured={data.voiceConfigured}
	/>
{/key}
