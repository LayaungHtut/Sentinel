<script lang="ts">
	import {
		AudioLines,
		CircleAlert,
		Hand,
		Keyboard,
		LoaderCircle,
		Mic,
		MicOff,
		PhoneOff,
		RefreshCw,
		ScrollText,
		Send,
		WifiOff,
		Wrench
	} from '@lucide/svelte';
	import VoiceMeter from './VoiceMeter.svelte';
	import SessionTelemetry from './SessionTelemetry.svelte';
	import type { VoiceAgent, VoiceStatus } from '$lib/voice/agent.svelte';
	import type { DemoScenario } from '$lib/demo/scenarios';
	import type { IncidentView, TranscriptView } from '$lib/domain/view';
	import { fmtCountdown } from '$lib/utils/format';

	let {
		agent,
		voiceConfigured,
		scenario,
		now,
		hasIncident,
		incidentClosed,
		history,
		sessions,
		highlightText,
		onStart
	}: {
		agent: VoiceAgent;
		voiceConfigured: boolean;
		scenario: DemoScenario | null;
		now: number;
		hasIncident: boolean;
		incidentClosed: boolean;
		history: TranscriptView[];
		sessions: IncidentView['voiceSessions'];
		highlightText: string | null;
		onStart: (consent?: boolean) => void;
	} = $props();

	let typed = $state('');
	let showTyping = $state(false);
	let showScript = $state(true);
	const spokenIndex = $derived.by(() => {
		let n = 0;
		return (scenario?.script ?? []).map((l) => (l.speaker === 'you' ? ++n : 0));
	});

	// Every state has a label, an icon and a hint — never colour alone.
	const STATES: Record<
		VoiceStatus,
		{ label: string; hint: string; tone: string; icon: typeof Mic }
	> = {
		idle: { label: 'Idle', hint: 'Voice is off.', tone: 'text-ink-400', icon: MicOff },
		connecting: {
			label: 'Connecting',
			hint: 'Opening a secure voice session through SENTINEL…',
			tone: 'text-ink-300',
			icon: LoaderCircle
		},
		listening: {
			label: 'Listening',
			hint: 'Speak naturally. You can interrupt SENTINEL at any time.',
			tone: 'text-ok',
			icon: Mic
		},
		processing: {
			label: 'Processing',
			hint: 'Understanding and updating the incident record…',
			tone: 'text-info',
			icon: LoaderCircle
		},
		speaking: {
			label: 'Speaking',
			hint: 'SENTINEL is talking. Just talk over it to interrupt.',
			tone: 'text-voice',
			icon: AudioLines
		},
		interrupted: {
			label: 'Interrupted',
			hint: 'Stopped mid-sentence. Listening to you.',
			tone: 'text-warn',
			icon: Hand
		},
		reconnecting: {
			label: 'Reconnecting',
			hint: 'Voice connection lost. Reconnecting… incident data is safe.',
			tone: 'text-warn',
			icon: WifiOff
		},
		ended: {
			label: 'Session ended',
			hint: 'Voice session closed cleanly.',
			tone: 'text-ink-400',
			icon: PhoneOff
		},
		error: { label: 'Voice unavailable', hint: '', tone: 'text-crit', icon: CircleAlert }
	};

	const s = $derived(STATES[agent.status]);
	const StatusIcon = $derived(s.icon);
	const displayLabel = $derived(
		agent.status === 'listening' && agent.muted
			? 'Muted'
			: agent.status === 'listening' && agent.userSpeaking
				? 'Hearing you'
				: s.label
	);
	const elapsed = $derived(agent.connectedAt ? (now - agent.connectedAt) / 1000 : 0);
	const lastSession = $derived(sessions.at(-1) ?? null);

	const ERROR_TITLES: Record<string, string> = {
		mic_denied: 'Microphone access required',
		mic_missing: 'No microphone found',
		mic_disconnected: 'Microphone disconnected',
		insecure: 'Secure connection required',
		unsupported: 'Browser not supported',
		mic_failed: 'Microphone could not start',
		not_configured: 'Voice not configured',
		quota: 'Voice limit reached',
		voice: 'Voice unavailable'
	};
	const ERROR_HELP: Record<string, string> = {
		mic_denied:
			'Allow microphone access for this site (the icon in the address bar), then try again.',
		mic_missing: 'Connect a microphone or headset, then try again.',
		mic_disconnected: 'Reconnect the microphone, then resume.',
		insecure:
			'Open SENTINEL on https:// or http://localhost; browsers block microphones elsewhere.',
		unsupported: 'Use a recent Chrome or Edge.',
		mic_failed: 'Close other apps using the microphone, then try again.',
		not_configured: 'Set ASSEMBLYAI_API_KEY on the server.',
		quota:
			"Your organisation's voice limit is reached (concurrent sessions or daily minutes). An administrator can change it in Settings.",
		voice: 'Your incident data is safe. Continue with the manual controls or try again.'
	};

	const shouldHighlight = (text: string) =>
		!!highlightText && text.trim().toLowerCase() === highlightText.trim().toLowerCase();

	function scrollToEnd(node: HTMLElement) {
		const observer = new MutationObserver(() => {
			if (node.querySelector('[data-highlight="true"]')) return;
			node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
		});
		observer.observe(node, { childList: true, subtree: true, characterData: true });
		return () => observer.disconnect();
	}

	function reveal(node: HTMLElement) {
		node.scrollIntoView({ block: 'center', behavior: 'smooth' });
	}

	function submitTyped(e: SubmitEvent) {
		e.preventDefault();
		agent.sendText(typed);
		typed = '';
	}

	const TOOL_LABELS: Record<string, string> = {
		create_incident: 'Opening incident',
		add_fact: 'Recording fact',
		mark_fact_confirmed: 'Confirming fact',
		mark_fact_uncertain: 'Marking uncertain',
		add_action: 'Adding actions',
		update_action: 'Updating action',
		request_information: 'Tracking unknown',
		record_response: 'Recording response',
		create_escalation: 'Escalating',
		resolve_escalation: 'Updating escalation',
		update_incident: 'Updating incident',
		generate_incident_report: 'Compiling report',
		close_incident: 'Closing incident'
	};
</script>

{#snippet line(
	speaker: string,
	text: string,
	opts: { typed?: boolean; interrupted?: boolean; muted?: boolean }
)}
	<p
		class={[
			'mb-0.5 text-[10.5px] font-semibold tracking-[0.14em] uppercase',
			speaker === 'user' ? 'text-ink-400' : 'text-voice'
		]}
	>
		{speaker === 'user' ? 'You' : 'Sentinel'}
		{#if opts.typed}<span class="ml-1 font-normal tracking-normal text-ink-500 normal-case"
				>typed</span
			>{/if}
		{#if opts.interrupted}<span class="ml-1 font-normal tracking-normal text-warn normal-case"
				>✋ interrupted</span
			>{/if}
	</p>
	<p
		class={[
			'text-[14.5px] leading-relaxed',
			speaker === 'user' ? 'text-ink-100' : 'text-ink-200',
			opts.muted && 'text-ink-300',
			opts.interrupted && 'opacity-70'
		]}
	>
		{text}{#if opts.interrupted}<span class="text-ink-500">—</span>{/if}
	</p>
{/snippet}

<section class="flex h-full min-h-[420px] flex-col panel" aria-label="Live voice">
	<div class="panel-header">
		<span class="flex items-center gap-2 eyebrow"
			><AudioLines class="size-3.5 text-voice" /> Live voice</span
		>
		<span class="flex items-center gap-3 text-[11px] text-ink-400">
			{#if agent.connectedAt && agent.active}<span class="mono" aria-label="Session time"
					>{fmtCountdown(elapsed)}</span
				>{/if}
			<span>AssemblyAI Voice Agent API</span>
		</span>
	</div>

	<div class="grid gap-4 border-b border-ink-700/70 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
		<div class="min-w-0">
			<div class="flex items-center gap-2.5" role="status" aria-live="polite">
				<span
					class={[
						'flex size-7 items-center justify-center rounded-full border',
						s.tone,
						agent.status === 'listening' && !agent.muted && 'border-ok/50 bg-ok/10',
						agent.status === 'speaking' && 'border-voice/50 bg-voice/10',
						agent.status === 'interrupted' && 'border-warn/50 bg-warn/10',
						agent.status === 'error' && 'border-crit/50 bg-crit/10',
						!['listening', 'speaking', 'interrupted', 'error'].includes(agent.status) &&
							'border-ink-600'
					]}
					aria-hidden="true"
				>
					{#if agent.muted && agent.status === 'listening'}
						<MicOff class="size-3.5 text-warn" />
					{:else}
						<StatusIcon
							class={[
								'size-3.5',
								(agent.status === 'connecting' || agent.status === 'processing') && 'animate-spin'
							]}
						/>
					{/if}
				</span>
				<span
					class={[
						'text-sm font-semibold tracking-[0.12em] uppercase',
						agent.muted && agent.status === 'listening' ? 'text-warn' : s.tone
					]}
				>
					{displayLabel}
				</span>
			</div>
			<p class="mt-1 text-[12.5px] text-ink-400">
				{#if agent.status === 'error'}
					{agent.errorMessage}
				{:else if agent.notice}
					{agent.notice}
				{:else if agent.muted && agent.active}
					Your microphone is muted; SENTINEL hears silence.
				{:else}
					{s.hint}
				{/if}
			</p>
			<div class="mt-3"><VoiceMeter {agent} /></div>
		</div>

		<div class="flex flex-col items-stretch gap-2 sm:w-44">
			{#if agent.active}
				<div class="grid grid-cols-2 gap-2">
					<button
						class={[
							agent.muted ? 'btn border border-warn/60 bg-warn/10 text-warn' : 'btn-secondary',
							'py-2'
						]}
						onclick={() => agent.toggleMute()}
						aria-pressed={agent.muted}
						disabled={agent.status === 'connecting'}
					>
						{#if agent.muted}<MicOff class="size-4" /> Unmute{:else}<Mic class="size-4" /> Mute{/if}
					</button>
					<button class="btn-danger py-2" onclick={() => agent.end()}>
						<PhoneOff class="size-4" /> End
					</button>
				</div>
			{:else if !voiceConfigured}
				<div class="rounded-md border border-warn/30 bg-warn/5 p-2.5 text-[12px] text-warn">
					Voice not configured. Set <code class="mono">ASSEMBLYAI_API_KEY</code>.
				</div>
			{:else if incidentClosed}
				<p class="text-[12px] text-ink-400">Incident closed.</p>
			{:else}
				<button class="btn-primary py-2.5 text-[15px]" onclick={() => onStart()}>
					{#if agent.status === 'error' || agent.status === 'ended'}
						<RefreshCw class="size-4" /> {hasIncident ? 'Resume by voice' : 'Try again'}
					{:else}
						<Mic class="size-4" /> {hasIncident ? 'Continue by voice' : 'Start incident'}
					{/if}
				</button>
			{/if}
			{#if agent.active && agent.status !== 'connecting'}
				<button
					class="btn-ghost text-xs"
					onclick={() => (showTyping = !showTyping)}
					aria-expanded={showTyping}
				>
					<Keyboard class="size-3.5" />
					{showTyping ? 'Hide typing' : 'Type instead'}
				</button>
			{/if}
		</div>
	</div>

	{#if agent.needsConsent}
		<div
			class="flex flex-col gap-3 border-b border-voice/30 bg-voice/5 px-4 py-3 text-[13px]"
			role="dialog"
			aria-labelledby="consent-title"
		>
			<p id="consent-title" class="font-semibold text-ink-100">Before voice starts</p>
			<p class="text-ink-300">
				Voice sessions are recorded and transcribed by AssemblyAI on SENTINEL's behalf. Transcripts
				become part of the incident record and are kept under your organisation's retention policy.
				Tell anyone else who may be heard.
			</p>
			<div class="flex flex-wrap gap-2">
				<button class="btn-primary" onclick={() => onStart(true)}>I agree, start voice</button>
				<button class="btn-ghost" onclick={() => (agent.needsConsent = false)}>Not now</button>
			</div>
		</div>
	{/if}

	{#if agent.status === 'error'}
		<div
			class="flex items-start gap-3 border-b border-crit/30 bg-crit/5 px-4 py-3 text-[12.5px]"
			role="alert"
		>
			<CircleAlert class="mt-0.5 size-4 shrink-0 text-crit" />
			<div class="min-w-0 flex-1">
				<p class="font-semibold tracking-wide text-ink-100 uppercase">
					{ERROR_TITLES[agent.errorKind ?? 'voice']}
				</p>
				<p class="mt-0.5 text-ink-300">{ERROR_HELP[agent.errorKind ?? 'voice']}</p>
				<p class="mt-1 text-ink-400">
					Your incident data is safe. Facts, actions, timeline and report all still work manually.
				</p>
			</div>
			{#if voiceConfigured && !incidentClosed && agent.errorKind !== 'unsupported' && agent.errorKind !== 'insecure'}
				<button class="btn-secondary shrink-0 text-xs" onclick={() => onStart()}
					><RefreshCw class="size-3.5" /> Try again</button
				>
			{/if}
		</div>
	{/if}

	<div class="relative flex min-h-0 flex-1 flex-col">
		<ol
			{@attach scrollToEnd}
			class="max-h-[340px] min-h-[140px] flex-1 space-y-3 overflow-y-auto px-4 py-3"
			aria-label="Conversation"
		>
			{#if agent.items.length === 0 && history.length}
				<li class="text-center text-[11px] text-ink-500">Recorded conversation</li>
				{#each history as h (h.id)}
					{@const hit = shouldHighlight(h.text)}
					<li
						data-highlight={hit}
						class={hit ? 'rounded-md bg-voice/10 p-2 ring-1 ring-voice/60' : undefined}
						{@attach (node) => {
							if (hit) reveal(node);
						}}
					>
						{@render line(h.speaker, h.text, {
							typed: h.channel === 'typed',
							interrupted: h.interrupted,
							muted: true
						})}
					</li>
				{/each}
			{:else if agent.items.length === 0 && !agent.partialUser && !agent.partialAgent}
				<li class="py-6 text-center text-[13px] text-ink-500">
					{agent.active ? 'Waiting for SENTINEL…' : 'The conversation will appear here.'}
				</li>
			{/if}
			{#each agent.items as item (item.id)}
				{@const hit = shouldHighlight(item.text)}
				<li
					data-highlight={hit}
					class={['enter', hit && 'rounded-md bg-voice/10 p-2 ring-1 ring-voice/60']}
					{@attach (node) => {
						if (hit) reveal(node);
					}}
				>
					{#if item.speaker === 'system'}
						<p
							class="rounded border border-ink-700 bg-ink-850 px-2.5 py-1.5 text-[12px] text-ink-300"
						>
							<span class="mr-1 font-semibold text-ink-200">SENTINEL event:</span>{item.text}
						</p>
					{:else}
						{@render line(item.speaker, item.text, {
							typed: item.channel === 'typed',
							interrupted: item.interrupted
						})}
					{/if}
				</li>
			{/each}
			{#if agent.partialUser}
				<li aria-hidden="true">
					<p class="mb-0.5 text-[10.5px] font-semibold tracking-[0.14em] text-ink-400 uppercase">
						You
					</p>
					<p class="text-[14.5px] leading-relaxed text-ink-300 italic">{agent.partialUser}</p>
				</li>
			{/if}
			{#if agent.partialAgent}
				<li aria-hidden="true">
					<p class="mb-0.5 text-[10.5px] font-semibold tracking-[0.14em] text-voice uppercase">
						Sentinel
					</p>
					<p class="text-[14.5px] leading-relaxed text-ink-300">{agent.partialAgent}</p>
				</li>
			{/if}
		</ol>

		{#if agent.toolActivity.length}
			<div class="border-t border-ink-700/70 px-4 py-2">
				<p class="mb-1.5 flex items-center gap-1.5 eyebrow">
					<Wrench class="size-3" /> Voice → tool call → incident record
				</p>
				<ul class="space-y-1">
					{#each agent.toolActivity.slice(0, 3) as t (t.callId)}
						<li class="enter flex items-baseline gap-2 text-[12px]">
							<span
								class={[
									'shrink-0 mono text-[10.5px]',
									t.state === 'ok' ? 'text-ok' : t.state === 'error' ? 'text-crit' : 'text-info'
								]}
							>
								{t.state === 'running' ? '…' : t.state === 'ok' ? '✓' : '✕'}
								{t.name}
							</span>
							<span class="truncate text-ink-300" title={t.message}>
								{t.state === 'running' ? `${TOOL_LABELS[t.name] ?? t.name}…` : t.message}
							</span>
						</li>
					{/each}
				</ul>
			</div>
		{/if}

		{#if showTyping && agent.active}
			<form class="flex gap-2 border-t border-ink-700/70 p-3" onsubmit={submitTyped}>
				<input
					class="input"
					placeholder="Type what you would say…"
					bind:value={typed}
					maxlength="1000"
					aria-label="Message to SENTINEL"
				/>
				<button class="btn-secondary" type="submit" disabled={!typed.trim()} aria-label="Send"
					><Send class="size-4" /></button
				>
			</form>
		{/if}
	</div>

	{#if !agent.active && lastSession}
		<SessionTelemetry session={lastSession} count={sessions.length} />
	{/if}

	{#if scenario}
		<div class="border-t border-ink-700/70">
			<button
				class="flex w-full items-center justify-between px-4 py-2 text-left"
				onclick={() => (showScript = !showScript)}
				aria-expanded={showScript}
			>
				<span class="flex items-center gap-1.5 eyebrow"
					><ScrollText class="size-3.5" /> Demo script (suggested lines)</span
				>
				<span class="text-[11px] text-ink-500">{showScript ? 'hide' : 'show'}</span>
			</button>
			{#if showScript}
				<ol class="space-y-1.5 px-4 pb-3 text-[12.5px]">
					{#each scenario.script as l, i (i)}
						<li class={l.speaker === 'note' ? 'text-ink-500 italic' : 'text-ink-300'}>
							{#if l.speaker === 'you'}<span class="mr-1.5 mono text-ink-500"
									>{spokenIndex[i]}.</span
								>“{l.text}”{:else}{l.text}{/if}
						</li>
					{/each}
				</ol>
			{/if}
		</div>
	{/if}
</section>
