<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import Brand from '$lib/components/dashboard/Brand.svelte';
	import type { SubmitFunction } from '@sveltejs/kit';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();
	let busy = $state(false);
	const submit: SubmitFunction = () => {
		busy = true;
		return async ({ update }) => {
			await update();
			busy = false;
		};
	};
</script>

<svelte:head><title>Sign in — SENTINEL</title></svelte:head>

<main class="mx-auto flex min-h-screen max-w-sm flex-col justify-center gap-8 px-5 py-12">
	<Brand />
	<div class="panel p-6">
		<h1 class="text-lg font-semibold text-ink-100">Sign in</h1>
		<form method="POST" action="?/login" use:enhance={submit} class="mt-5 flex flex-col gap-4">
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
				Password
				<input
					class="input"
					name="password"
					type="password"
					autocomplete="current-password"
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
			<button class="btn-primary py-2" disabled={busy}>Sign in</button>
		</form>
		{#if data.needsSetup}
			<p class="mt-4 text-xs text-ink-400">
				No accounts exist yet.
				<a class="underline" href={resolve('/setup')}>Create the first administrator</a>.
			</p>
		{/if}
	</div>
	{#if data.demoLoginEnabled}
		<form method="POST" action="?/demo" use:enhance={submit} class="panel p-5">
			<p class="text-sm text-ink-300">
				Explore the fictional <strong class="text-ink-100">Golden Fork</strong> demo organisation. Demo
				data is shared, and notifications there are simulated, never sent.
			</p>
			<button class="mt-3 btn-secondary w-full py-2" disabled={busy}>Continue with demo</button>
		</form>
	{/if}
</main>
