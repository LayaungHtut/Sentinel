<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';
	import { WifiOff } from '@lucide/svelte';

	let { children } = $props();
	let online = $state(typeof navigator === 'undefined' ? true : navigator.onLine);
</script>

<svelte:window ononline={() => (online = true)} onoffline={() => (online = false)} />

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>SENTINEL — Voice incident response</title>
	<meta
		name="description"
		content="Evidence-first voice incident response, powered by the AssemblyAI Voice Agent API."
	/>
</svelte:head>

{#if !online}
	<div
		role="alert"
		class="sticky top-0 z-50 flex items-center justify-center gap-2 border-b border-warn/40 bg-warn/15 px-4 py-2 text-center text-xs font-medium text-warn"
	>
		<WifiOff class="size-3.5 shrink-0" />
		You're offline. Nothing can be saved and voice is paused until the connection returns. Call the people
		you need directly.
	</div>
{/if}

{@render children()}
