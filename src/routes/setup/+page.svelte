<script lang="ts">
	import { enhance } from '$app/forms';
	import Brand from '$lib/components/dashboard/Brand.svelte';
	import type { PageProps } from './$types';

	let { form }: PageProps = $props();
	let busy = $state(false);
</script>

<svelte:head><title>Set up — SENTINEL</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-md flex-col justify-center gap-8 px-5 py-12">
	<Brand />
	<form
		method="POST"
		class="flex flex-col gap-4 panel p-6"
		use:enhance={() => {
			busy = true;
			return async ({ update }) => {
				await update();
				busy = false;
			};
		}}
	>
		<div>
			<h1 class="text-lg font-semibold text-ink-100">Create your organisation</h1>
			<p class="mt-1 text-sm text-ink-400">
				This creates the first administrator account. It is only available once.
			</p>
		</div>
		<label class="flex flex-col gap-1.5 text-sm text-ink-300">
			Organisation name
			<input class="input" name="orgName" required maxlength="120" value={form?.orgName ?? ''} />
		</label>
		<label class="flex flex-col gap-1.5 text-sm text-ink-300">
			Your name
			<input
				class="input"
				name="name"
				autocomplete="name"
				required
				maxlength="120"
				value={form?.name ?? ''}
			/>
		</label>
		<label class="flex flex-col gap-1.5 text-sm text-ink-300">
			Email
			<input
				class="input"
				name="email"
				type="email"
				autocomplete="username"
				required
				value={form?.email ?? ''}
			/>
		</label>
		<label class="flex flex-col gap-1.5 text-sm text-ink-300">
			<span>Password <span class="text-xs text-ink-500">(at least 12 characters)</span></span>
			<input
				class="input"
				name="password"
				type="password"
				autocomplete="new-password"
				minlength="12"
				required
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
		<button class="btn-primary py-2" disabled={busy}>Create administrator</button>
	</form>
</main>
