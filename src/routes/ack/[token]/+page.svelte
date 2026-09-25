<script lang="ts">
	import { enhance } from '$app/forms';
	import Brand from '$lib/components/dashboard/Brand.svelte';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let busy = $state(false);
	const done = $derived(Boolean(data.acknowledgedAt || form?.ok));
</script>

<svelte:head><title>Acknowledge {data.code} — SENTINEL</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-8 px-5 py-12">
	<Brand />
	<div class="flex flex-col gap-4 panel p-6">
		<div>
			<p class="eyebrow">{data.code}</p>
			<h1 class="mt-1 text-lg font-semibold text-ink-100">{data.title}</h1>
		</div>
		<p
			class="rounded-md border border-ink-700 bg-ink-850 px-3 py-2 text-sm whitespace-pre-line text-ink-200"
		>
			{data.message}
		</p>
		{#if done}
			<p role="status" class="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">
				Thanks, {data.contactName}. Your acknowledgement is recorded on the incident timeline.
			</p>
		{:else}
			<form
				method="POST"
				class="flex flex-col gap-3"
				use:enhance={() => {
					busy = true;
					return async ({ update }) => {
						await update();
						busy = false;
					};
				}}
			>
				<label class="flex flex-col gap-1.5 text-sm text-ink-300">
					Note for the team (optional)
					<input
						class="input"
						name="note"
						maxlength="200"
						placeholder="e.g. On my way, 15 minutes"
					/>
				</label>
				{#if form?.error}
					<p
						role="alert"
						class="rounded-md border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit"
					>
						{form.error}
					</p>
				{/if}
				<button class="btn-primary py-2" disabled={busy}>Acknowledge as {data.contactName}</button>
			</form>
		{/if}
	</div>
</main>
