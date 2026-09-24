<script lang="ts">
	import { PencilLine } from '@lucide/svelte';
	import { INCIDENT_TYPES } from '$lib/domain/types';
	import { getPlaybook } from '$lib/domain/playbooks';

	let { onCreated }: { onCreated: (id: string) => void } = $props();

	let open = $state(false);
	let busy = $state(false);
	let errorText = $state<string | null>(null);
	let form = $state({ title: '', type: 'other' as (typeof INCIDENT_TYPES)[number], location: '' });

	/** Degraded path: create an incident without voice, through the same create_incident tool. */
	async function submit(e: SubmitEvent) {
		e.preventDefault();
		busy = true;
		errorText = null;
		try {
			const res = await fetch('/api/tools/create_incident', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					arguments: {
						title: form.title,
						type: form.type,
						facts: form.location
							? [{ key: 'location', value: form.location, certainty: 'exact', basis: 'stated' }]
							: []
					}
				})
			});
			const body = await res.json();
			if (!body.ok) throw new Error(body.error ?? body.message ?? 'Could not create incident');
			onCreated(body.incidentId);
		} catch (err) {
			errorText = err instanceof Error ? err.message : 'Could not create incident';
		} finally {
			busy = false;
		}
	}
</script>

{#if open}
	<form class="space-y-2 rounded-md border border-ink-700 bg-ink-850 p-3" onsubmit={submit}>
		<p class="eyebrow">Create manually (no voice)</p>
		<input
			class="input"
			placeholder="Title, e.g. Freezer not cooling"
			bind:value={form.title}
			required
			minlength="3"
			maxlength="120"
			aria-label="Title"
		/>
		<div class="grid grid-cols-2 gap-2">
			<select class="input" bind:value={form.type} aria-label="Incident type">
				{#each INCIDENT_TYPES as t (t)}<option value={t}>{getPlaybook(t).label}</option>{/each}
			</select>
			<input
				class="input"
				placeholder="Location"
				bind:value={form.location}
				maxlength="120"
				aria-label="Location"
			/>
		</div>
		{#if errorText}<p class="text-xs text-crit">{errorText}</p>{/if}
		<div class="flex justify-end gap-2">
			<button type="button" class="btn-ghost text-xs" onclick={() => (open = false)}>Cancel</button>
			<button class="btn-secondary text-xs" disabled={busy}>Create incident</button>
		</div>
	</form>
{:else}
	<button class="-ml-2 btn-ghost self-start text-xs" onclick={() => (open = true)}>
		<PencilLine class="size-3.5" /> Or create it manually without voice
	</button>
{/if}
