<script lang="ts">
	import { enhance } from '$app/forms';
	import Brand from '$lib/components/dashboard/Brand.svelte';
	import UserMenu from '$lib/components/ui/UserMenu.svelte';
	import { fmtDateTime } from '$lib/utils/format';
	import type { PageProps } from './$types';

	let { data, form }: PageProps = $props();

	const isAdmin = $derived(data.role === 'admin');
	const canContacts = $derived(data.role === 'admin' || data.role === 'manager');
	let editing = $state<string | null>(null);
	let newChannel = $state('none');

	const CHANNEL_LABELS: Record<string, string> = {
		none: 'None (staff call directly)',
		sms: 'SMS (Twilio)',
		voice_call: 'Phone call (Twilio)',
		email: 'Email (SMTP)',
		slack: 'Slack',
		webhook: 'Webhook'
	};
	const configured = (ch: string) => ch === 'none' || data.configuredChannels.includes(ch as never);
</script>

<svelte:head><title>Settings — SENTINEL</title></svelte:head>

{#snippet feedback(section: string)}
	{#if form?.section === section && 'error' in form && form.error}
		<p role="alert" class="rounded-md border border-crit/40 bg-crit/10 px-3 py-2 text-sm text-crit">
			{form.error}
		</p>
	{:else if form?.section === section && 'ok' in form && form.ok}
		<p role="status" class="rounded-md border border-ok/40 bg-ok/10 px-3 py-2 text-sm text-ok">
			{form.ok}
		</p>
	{/if}
{/snippet}

<div class="mx-auto flex min-h-screen max-w-5xl flex-col gap-6 px-5 pb-16">
	<header class="flex items-center justify-between py-5">
		<Brand />
		<UserMenu />
	</header>

	<div>
		<p class="eyebrow">{data.orgName}{data.orgIsDemo ? ' · demo organisation' : ''}</p>
		<h1 class="mt-1 text-2xl font-semibold text-ink-100">Settings</h1>
	</div>

	{#if isAdmin}
		<section class="panel" aria-labelledby="policy-h">
			<div class="panel-header"><h2 id="policy-h" class="eyebrow">Response policy</h2></div>
			<form method="POST" action="?/policy" use:enhance class="grid gap-4 p-4 sm:grid-cols-2">
				<label class="flex flex-col gap-1.5 text-sm text-ink-300">
					Escalate when a contact hasn't responded after (minutes)
					<input
						class="input"
						name="responseTimeoutMinutes"
						type="number"
						step="0.5"
						min="0.5"
						value={data.settings.responseTimeoutSeconds / 60}
					/>
				</label>
				<label class="flex flex-col gap-1.5 text-sm text-ink-300">
					Redact transcripts after (days, 0 = keep)
					<input
						class="input"
						name="retentionDays"
						type="number"
						min="0"
						value={data.settings.retentionDays}
					/>
				</label>
				<label class="flex flex-col gap-1.5 text-sm text-ink-300">
					Max concurrent voice sessions
					<input
						class="input"
						name="voiceMaxConcurrent"
						type="number"
						min="0"
						value={data.settings.voiceMaxConcurrent}
					/>
				</label>
				<label class="flex flex-col gap-1.5 text-sm text-ink-300">
					Voice minutes per day
					<input
						class="input"
						name="voiceDailyMinutes"
						type="number"
						min="0"
						value={data.settings.voiceDailyMinutes}
					/>
				</label>
				<label class="flex items-center gap-2 text-sm text-ink-300 sm:col-span-2">
					<input
						type="checkbox"
						name="deleteProviderRecordings"
						checked={data.settings.deleteProviderRecordings}
						class="rounded border-ink-600 bg-ink-850"
					/>
					Also delete AssemblyAI's stored recording when transcripts are redacted
				</label>
				<div class="flex flex-col gap-3 sm:col-span-2">
					{@render feedback('policy')}
					<button class="btn-primary self-start">Save policy</button>
				</div>
			</form>
		</section>
	{/if}

	{#if canContacts}
		<section class="panel" aria-labelledby="contacts-h">
			<div class="panel-header">
				<h2 id="contacts-h" class="eyebrow">Contacts &amp; on-call</h2>
				<span class="text-xs text-ink-500">
					Channels configured on this server:
					{data.configuredChannels.length ? data.configuredChannels.join(', ') : 'none'}
				</span>
			</div>
			<div class="flex flex-col gap-3 p-4">
				{@render feedback('contacts')}
				{#if data.orgIsDemo}
					<p class="text-xs text-warn">
						Demo organisation: notifications here are always simulated, never sent.
					</p>
				{/if}
				<ul class="divide-y divide-ink-700/70">
					{#each data.contacts as c (c.id)}
						<li class="py-3">
							{#if editing === c.id}
								{@render contactForm(c)}
							{:else}
								<div class="flex flex-wrap items-center justify-between gap-3">
									<div>
										<p class="text-sm text-ink-100">
											{c.name}
											{#if c.onCall}<span
													class="ml-1 rounded bg-ok/15 px-1.5 py-0.5 text-[11px] text-ok"
													>on call</span
												>{/if}
										</p>
										<p class="text-xs text-ink-400">
											{c.roleLabel}{c.site ? ` · ${c.site}` : ''} · {CHANNEL_LABELS[c.channel] ??
												c.channel}
											{#if !configured(c.channel)}<span class="text-warn">
													(not configured on server)</span
												>{/if}
										</p>
									</div>
									<div class="flex gap-2">
										<button class="btn-ghost text-xs" onclick={() => (editing = c.id)}>Edit</button>
										<form method="POST" action="?/deleteContact" use:enhance>
											<input type="hidden" name="id" value={c.id} />
											<button class="btn-ghost text-xs text-crit">Remove</button>
										</form>
									</div>
								</div>
							{/if}
						</li>
					{:else}
						<li class="py-3 text-sm text-ink-400">No contacts yet.</li>
					{/each}
				</ul>
				<details class="rounded-md border border-ink-700 p-3">
					<summary class="cursor-pointer text-sm text-ink-200">Add contact</summary>
					<div class="mt-3">{@render contactForm(null)}</div>
				</details>
			</div>
		</section>
	{/if}

	{#snippet contactForm(c: (typeof data.contacts)[number] | null)}
		<form
			method="POST"
			action="?/saveContact"
			use:enhance={() =>
				async ({ update, result }) => {
					await update({ reset: !c });
					if (result.type === 'success') editing = null;
				}}
			class="grid gap-3 sm:grid-cols-3"
		>
			{#if c}<input type="hidden" name="id" value={c.id} />{/if}
			<label class="flex flex-col gap-1 text-xs text-ink-400">
				Name <input class="input" name="name" required maxlength="80" value={c?.name ?? ''} />
			</label>
			<label class="flex flex-col gap-1 text-xs text-ink-400">
				Role
				<select class="input" name="role">
					{#each data.contactRoles as r (r.id)}
						<option value={r.id} selected={c?.role === r.id}>{r.label}</option>
					{/each}
				</select>
			</label>
			<label class="flex flex-col gap-1 text-xs text-ink-400">
				Site <input class="input" name="site" maxlength="120" value={c?.site ?? ''} />
			</label>
			<label class="flex flex-col gap-1 text-xs text-ink-400">
				Notify by
				<select
					class="input"
					name="channel"
					value={c?.channel ?? newChannel}
					onchange={(e) => {
						if (!c) newChannel = e.currentTarget.value;
					}}
				>
					{#each data.channels as ch (ch)}
						<option value={ch}
							>{CHANNEL_LABELS[ch]}{configured(ch) ? '' : ' — not configured'}</option
						>
					{/each}
				</select>
			</label>
			<label class="flex flex-col gap-1 text-xs text-ink-400">
				Phone (E.164)
				<input class="input" name="phone" placeholder="+14155550100" value={c?.phone ?? ''} />
			</label>
			<label class="flex flex-col gap-1 text-xs text-ink-400">
				Email <input class="input" name="email" type="email" value={c?.email ?? ''} />
			</label>
			<label class="flex items-center gap-2 text-sm text-ink-300">
				<input
					type="checkbox"
					name="onCall"
					checked={c?.onCall ?? false}
					class="rounded border-ink-600 bg-ink-850"
				/>
				On call
			</label>
			<div class="flex gap-2 sm:col-span-2 sm:justify-end">
				{#if c}<button type="button" class="btn-ghost" onclick={() => (editing = null)}
						>Cancel</button
					>{/if}
				<button class="btn-secondary">{c ? 'Save' : 'Add contact'}</button>
			</div>
		</form>
	{/snippet}

	{#if isAdmin}
		<section class="panel" aria-labelledby="members-h">
			<div class="panel-header"><h2 id="members-h" class="eyebrow">Members &amp; roles</h2></div>
			<div class="flex flex-col gap-3 p-4">
				{@render feedback('members')}
				{#if form?.section === 'members' && 'tempPassword' in form && form.tempPassword}
					<p class="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-sm">
						One-time password: <code class="mono text-ink-100 select-all">{form.tempPassword}</code>
					</p>
				{/if}
				<ul class="divide-y divide-ink-700/70">
					{#each data.members as m (m.userId)}
						<li class="flex flex-wrap items-center justify-between gap-3 py-2.5">
							<div>
								<p class="text-sm text-ink-100">{m.name}</p>
								<p class="text-xs text-ink-400">{m.email}</p>
							</div>
							{#if m.userId === data.userId}
								<span class="text-xs text-ink-400">{m.role} (you)</span>
							{:else}
								<div class="flex items-center gap-2">
									<form method="POST" action="?/setRole" use:enhance>
										<input type="hidden" name="userId" value={m.userId} />
										<label class="sr-only" for="role-{m.userId}">Role for {m.name}</label>
										<select
											id="role-{m.userId}"
											name="role"
											class="input w-auto py-1 text-xs"
											onchange={(e) => e.currentTarget.form?.requestSubmit()}
										>
											{#each data.userRoles as r (r)}
												<option value={r} selected={m.role === r}>{r}</option>
											{/each}
										</select>
									</form>
									<form method="POST" action="?/removeMember" use:enhance>
										<input type="hidden" name="userId" value={m.userId} />
										<button class="btn-ghost text-xs text-crit">Remove</button>
									</form>
								</div>
							{/if}
						</li>
					{/each}
				</ul>
				<form method="POST" action="?/addMember" use:enhance class="grid gap-3 sm:grid-cols-4">
					<input
						class="input"
						name="email"
						type="email"
						placeholder="email"
						required
						aria-label="Email"
					/>
					<input class="input" name="name" placeholder="name (new accounts)" aria-label="Name" />
					<select class="input" name="role" aria-label="Role">
						{#each data.userRoles as r (r)}<option value={r} selected={r === 'reporter'}>{r}</option
							>{/each}
					</select>
					<button class="btn-secondary">Add member</button>
				</form>
				<p class="text-xs text-ink-500">
					Reporters describe incidents. Coordinators also run actions and escalations. Managers can
					resolve escalations, close incidents and export. Administrators manage members, policy and
					keys.
				</p>
			</div>
		</section>

		<section class="panel" aria-labelledby="keys-h">
			<div class="panel-header">
				<h2 id="keys-h" class="eyebrow">API keys (sensors &amp; integrations)</h2>
			</div>
			<div class="flex flex-col gap-3 p-4">
				{@render feedback('keys')}
				{#if form?.section === 'keys' && 'apiKey' in form && form.apiKey}
					<p class="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-sm">
						<code class="mono break-all text-ink-100 select-all">{form.apiKey}</code>
					</p>
				{/if}
				<ul class="divide-y divide-ink-700/70">
					{#each data.apiKeys as k (k.id)}
						<li class="flex items-center justify-between gap-3 py-2.5">
							<div>
								<p class="text-sm text-ink-100">
									{k.name} <span class="mono text-xs text-ink-500">{k.prefix}…</span>
								</p>
								<p class="text-xs text-ink-400">
									Created {fmtDateTime(k.createdAt)} · {k.lastUsedAt
										? `last used ${fmtDateTime(k.lastUsedAt)}`
										: 'never used'}
								</p>
							</div>
							<form method="POST" action="?/revokeKey" use:enhance>
								<input type="hidden" name="id" value={k.id} />
								<button class="btn-ghost text-xs text-crit">Revoke</button>
							</form>
						</li>
					{:else}
						<li class="py-2.5 text-sm text-ink-400">No keys.</li>
					{/each}
				</ul>
				<form method="POST" action="?/createKey" use:enhance class="flex gap-3">
					<input
						class="input"
						name="name"
						placeholder="e.g. Walk-in freezer probe"
						aria-label="Key name"
						maxlength="80"
					/>
					<button class="btn-secondary shrink-0">Create key</button>
				</form>
				<p class="text-xs text-ink-500">
					Sensors post readings to <code class="mono">POST /api/observations</code> with
					<code class="mono">Authorization: Bearer &lt;key&gt;</code>. See docs/OPERATIONS.md.
				</p>
			</div>
		</section>
	{/if}

	{#if !data.orgIsDemo || data.role !== 'admin'}
		<section class="panel" aria-labelledby="account-h">
			<div class="panel-header"><h2 id="account-h" class="eyebrow">Your password</h2></div>
			<form method="POST" action="?/password" use:enhance class="grid gap-3 p-4 sm:grid-cols-3">
				<input
					class="input"
					name="current"
					type="password"
					autocomplete="current-password"
					placeholder="current"
					aria-label="Current password"
					required
				/>
				<input
					class="input"
					name="next"
					type="password"
					autocomplete="new-password"
					placeholder="new (12+ characters)"
					aria-label="New password"
					minlength="12"
					required
				/>
				<button class="btn-secondary">Change password</button>
				<div class="sm:col-span-3">{@render feedback('account')}</div>
			</form>
		</section>
	{/if}
</div>
