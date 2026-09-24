/**
 * Browser audio for the AssemblyAI Voice Agent API:
 *  - capture: mic → AudioWorklet → 24 kHz PCM16 mono chunks (base64 in JSON)
 *  - playback: reply.audio PCM16 24 kHz scheduled gap-free on the AudioContext,
 *    flushable instantly on barge-in so stale speech never plays.
 */
import { PCM_CAPTURE_WORKLET } from './pcm-worklet';

export const AGENT_SAMPLE_RATE = 24_000;

export class AudioEngine {
	private ctx: AudioContext | null = null;
	private stream: MediaStream | null = null;
	private worklet: AudioWorkletNode | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private output: GainNode | null = null;
	private analyser: AnalyserNode | null = null;
	private scheduled = new Set<AudioBufferSourceNode>();
	private playhead = 0;
	private analyserData: Uint8Array<ArrayBuffer> | null = null;

	onChunk: (base64: string, level: number) => void = () => {};
	/** Fired if the microphone track ends (unplugged, revoked, device switched off). */
	onMicLost: () => void = () => {};

	/** Create the context synchronously inside the user gesture (Safari requirement). */
	prepare(): void {
		if (!this.ctx) this.ctx = new AudioContext();
		void this.ctx.resume();
	}

	async start(): Promise<void> {
		this.prepare();
		const ctx = this.ctx!;
		this.stream = await navigator.mediaDevices.getUserMedia({
			// Per AssemblyAI guidance: echo cancellation on (agent must not hear
			// itself), noise suppression off (server already denoises).
			audio: {
				echoCancellation: true,
				noiseSuppression: false,
				autoGainControl: true,
				channelCount: 1
			}
		});
		this.stream.getAudioTracks()[0]?.addEventListener('ended', () => this.onMicLost());
		const moduleUrl = URL.createObjectURL(
			new Blob([PCM_CAPTURE_WORKLET], { type: 'application/javascript' })
		);
		try {
			await ctx.audioWorklet.addModule(moduleUrl);
		} finally {
			URL.revokeObjectURL(moduleUrl);
		}
		this.worklet = new AudioWorkletNode(ctx, 'pcm-capture', {
			processorOptions: { inputSampleRate: ctx.sampleRate, targetSampleRate: AGENT_SAMPLE_RATE }
		});
		this.worklet.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
			this.onChunk(bytesToBase64(new Uint8Array(e.data.pcm)), e.data.level);
		};
		this.source = ctx.createMediaStreamSource(this.stream);
		// Worklet output is silent; connecting to a muted gain keeps it pulled by the graph.
		const sink = ctx.createGain();
		sink.gain.value = 0;
		this.source.connect(this.worklet).connect(sink).connect(ctx.destination);

		this.output = ctx.createGain();
		this.analyser = ctx.createAnalyser();
		this.analyser.fftSize = 256;
		this.analyserData = new Uint8Array(new ArrayBuffer(this.analyser.fftSize));
		this.output.connect(this.analyser);
		this.analyser.connect(ctx.destination);
		this.playhead = ctx.currentTime;
	}

	/** Browsers may suspend audio in background tabs; resume when visible again. */
	resume(): void {
		if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume();
	}

	get micPermissionTracks(): number {
		return this.stream?.getAudioTracks().length ?? 0;
	}

	play(base64: string): void {
		const ctx = this.ctx;
		if (!ctx || !this.output) return;
		const bytes = base64ToBytes(base64);
		const samples = Math.floor(bytes.length / 2);
		if (!samples) return;
		const view = new DataView(bytes.buffer, bytes.byteOffset, samples * 2);
		const buffer = ctx.createBuffer(1, samples, AGENT_SAMPLE_RATE);
		const channel = buffer.getChannelData(0);
		for (let i = 0; i < samples; i++) channel[i] = view.getInt16(i * 2, true) / 32768;
		const node = ctx.createBufferSource();
		node.buffer = buffer;
		node.connect(this.output);
		const startAt = Math.max(this.playhead, ctx.currentTime + 0.02);
		node.start(startAt);
		this.playhead = startAt + buffer.duration;
		this.scheduled.add(node);
		node.onended = () => this.scheduled.delete(node);
	}

	/** Barge-in: drop all queued agent audio immediately. */
	flush(): void {
		for (const node of this.scheduled) {
			try {
				node.onended = null;
				node.stop();
				node.disconnect();
			} catch {
				/* already stopped */
			}
		}
		this.scheduled.clear();
		if (this.ctx) this.playhead = this.ctx.currentTime;
	}

	/** Seconds of agent audio still queued. */
	get pendingPlayback(): number {
		if (!this.ctx) return 0;
		return Math.max(0, this.playhead - this.ctx.currentTime);
	}

	/** 0..1 output level for the speaking visualiser. */
	outputLevel(): number {
		if (!this.analyser || !this.analyserData) return 0;
		this.analyser.getByteTimeDomainData(this.analyserData);
		let sum = 0;
		for (const v of this.analyserData) sum += ((v - 128) / 128) ** 2;
		return Math.sqrt(sum / this.analyserData.length);
	}

	async stop(): Promise<void> {
		this.flush();
		this.worklet?.port.close();
		this.worklet?.disconnect();
		this.source?.disconnect();
		this.stream?.getTracks().forEach((t) => t.stop());
		this.worklet = null;
		this.source = null;
		this.stream = null;
		const ctx = this.ctx;
		this.ctx = null;
		if (ctx && ctx.state !== 'closed') await ctx.close().catch(() => {});
	}
}

export function bytesToBase64(bytes: Uint8Array): string {
	let binary = '';
	const step = 0x8000;
	for (let i = 0; i < bytes.length; i += step) {
		binary += String.fromCharCode(...bytes.subarray(i, i + step));
	}
	return btoa(binary);
}

export function base64ToBytes(b64: string): Uint8Array {
	const binary = atob(b64);
	const out = new Uint8Array(binary.length);
	for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
	return out;
}
