<script lang="ts">
	import CommandCenter from '$lib/components/dashboard/CommandCenter.svelte';
	import type { PageProps } from './$types';

	let { data }: PageProps = $props();
</script>

<svelte:head><title>New incident — SENTINEL</title></svelte:head>

{#key data.scenarioId}
	<CommandCenter
		initialView={null}
		scenarioId={data.scenarioId}
		voiceConfigured={data.voiceConfigured}
	/>
{/key}
