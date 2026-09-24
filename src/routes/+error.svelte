<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import Brand from '$lib/components/dashboard/Brand.svelte';
</script>

<div class="mx-auto max-w-xl px-5 py-10">
	<Brand />
	<div class="mt-10 panel p-6">
		<p class="mb-2 eyebrow">Error {page.status}</p>
		<p class="text-lg text-ink-100">{page.error?.message ?? 'Something went wrong.'}</p>
		<p class="mt-4 text-sm text-ink-400">
			Incident data is stored in the database and is not affected by this page error.
		</p>
		<a class="mt-5 btn-secondary" href={resolve('/')}>Back to SENTINEL</a>
	</div>
</div>
