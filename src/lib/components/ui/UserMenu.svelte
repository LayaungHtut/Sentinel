<script lang="ts">
	import { page } from '$app/state';
	import { resolve } from '$app/paths';
	import { LogOut, Settings } from '@lucide/svelte';

	const user = $derived(page.data.user as App.PageData['user']);
	const ROLE_LABELS: Record<string, string> = {
		reporter: 'Reporter',
		coordinator: 'Coordinator',
		manager: 'Manager',
		admin: 'Administrator'
	};
</script>

{#if user}
	<div class="flex items-center gap-2 text-xs">
		<div class="hidden flex-col items-end leading-tight sm:flex">
			<span class="text-ink-200">{user.name}</span>
			<span class="text-ink-500">{ROLE_LABELS[user.role]} · {user.orgName}</span>
		</div>
		{#if user.orgs.length > 1}
			<form method="POST" action="/session?/switch" class="hidden md:block">
				<label class="sr-only" for="org-switch">Organisation</label>
				<select
					id="org-switch"
					name="orgId"
					class="input w-auto py-1 text-xs"
					onchange={(e) => e.currentTarget.form?.requestSubmit()}
				>
					{#each user.orgs as o (o.id)}
						<option value={o.id} selected={o.id === user.orgId}>{o.name}</option>
					{/each}
				</select>
			</form>
		{/if}
		<a href={resolve('/settings')} class="btn-ghost px-2" aria-label="Settings" title="Settings">
			<Settings class="size-4" />
		</a>
		<form method="POST" action="/session?/logout">
			<button class="btn-ghost px-2" aria-label="Sign out" title="Sign out">
				<LogOut class="size-4" />
			</button>
		</form>
	</div>
{/if}
