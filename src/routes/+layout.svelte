<script lang="ts">
	import './layout.css';
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
	<title>SENTINEL — Voice incident response</title>
	<meta
		name="description"
		content="Evidence-first voice incident response, powered by the AssemblyAI Voice Agent API."
	/>
</svelte:head>

{@render children()}
