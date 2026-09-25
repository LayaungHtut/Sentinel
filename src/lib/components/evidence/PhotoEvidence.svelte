<script lang="ts">
	import { resolve } from '$app/paths';
	import { Camera, ImagePlus, LoaderCircle } from '@lucide/svelte';
	import type { IncidentView } from '$lib/domain/view';
	import { fmtClock } from '$lib/utils/format';

	let {
		view,
		readOnly,
		onUploaded
	}: { view: IncidentView; readOnly: boolean; onUploaded: (message: string, ok: boolean) => void } =
		$props();

	let uploading = $state(false);
	let caption = $state('');
	let input: HTMLInputElement | undefined = $state();

	const MAX = 5 * 1024 * 1024;

	async function upload(e: Event & { currentTarget: HTMLInputElement }) {
		const file = e.currentTarget.files?.[0];
		e.currentTarget.value = '';
		if (!file) return;
		if (file.size > MAX) {
			onUploaded('Photos must be 5 MB or smaller.', false);
			return;
		}
		uploading = true;
		try {
			const body = new FormData();
			body.set('file', file);
			if (caption.trim()) body.set('caption', caption.trim());
			const res = await fetch(`/api/incidents/${view.incident.id}/attachments`, {
				method: 'POST',
				body
			});
			const json = await res.json().catch(() => ({}));
			if (!res.ok) {
				onUploaded(json.message ?? 'Upload failed.', false);
				return;
			}
			caption = '';
			onUploaded('Photo added to the record.', true);
		} catch {
			onUploaded('Server unreachable. The photo was not saved.', false);
		} finally {
			uploading = false;
		}
	}
</script>

<div class="flex h-full flex-col panel">
	<div class="panel-header">
		<span class="flex items-center gap-1.5 eyebrow"><Camera class="size-3.5" /> Photo evidence</span
		>
		<span class="text-[11px] text-ink-400">{view.attachments.length}</span>
	</div>
	{#if !readOnly}
		<div class="flex gap-2 border-b border-ink-700/60 px-4 py-2">
			<input
				class="input py-1 text-xs"
				placeholder="Caption (optional)"
				maxlength="200"
				bind:value={caption}
				aria-label="Photo caption"
			/>
			<input
				bind:this={input}
				type="file"
				accept="image/jpeg,image/png,image/webp"
				capture="environment"
				class="hidden"
				onchange={upload}
			/>
			<button
				class="btn-secondary shrink-0 px-2.5 text-xs"
				onclick={() => input?.click()}
				disabled={uploading}
			>
				{#if uploading}<LoaderCircle class="size-3.5 animate-spin" />{:else}<ImagePlus
						class="size-3.5"
					/>{/if}
				Add photo
			</button>
		</div>
	{/if}
	{#if view.attachments.length}
		<ul class="grid grid-cols-2 gap-2 p-3 sm:grid-cols-3">
			{#each view.attachments as a (a.id)}
				<li class="overflow-hidden rounded-md border border-ink-700 bg-ink-850">
					<a href={resolve('/api/attachments/[id]', { id: a.id })} target="_blank" rel="noopener">
						<img
							src="/api/attachments/{a.id}"
							alt={a.caption ?? `Photo added ${fmtClock(a.createdAt)}`}
							loading="lazy"
							class="aspect-[4/3] w-full object-cover"
						/>
					</a>
					<div class="px-2 py-1.5 text-[11px]">
						{#if a.caption}<p class="truncate text-ink-200">{a.caption}</p>{/if}
						<p class="text-ink-500">
							{a.uploadedBy ?? 'Unknown'} · {fmtClock(a.createdAt)}
						</p>
						<p class="truncate mono text-[10px] text-ink-600" title="SHA-256 {a.sha256}">
							{a.sha256.slice(0, 16)}…
						</p>
					</div>
				</li>
			{/each}
		</ul>
	{:else}
		<p class="px-4 py-6 text-[13px] text-ink-500">
			Photos of the scene are stored with the incident, hashed (SHA-256) and logged on the timeline.
		</p>
	{/if}
</div>
