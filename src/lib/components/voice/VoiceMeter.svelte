<script lang="ts">
	import type { VoiceAgent } from '$lib/voice/agent.svelte';

	let { agent }: { agent: VoiceAgent } = $props();

	const BARS = 28;

	/** Canvas meter: mic level while listening, output level while SENTINEL speaks. */
	function meter(canvas: HTMLCanvasElement) {
		const ctx = canvas.getContext('2d')!;
		const history = new Array<number>(BARS).fill(0);
		let frame = 0;
		let raf = 0;
		const styles = getComputedStyle(document.documentElement);
		const colorVoice = styles.getPropertyValue('--color-voice').trim() || '#9ab6ff';
		const colorUser = styles.getPropertyValue('--color-ink-100').trim() || '#e7ebf0';
		const colorIdle = styles.getPropertyValue('--color-ink-600').trim() || '#2e3846';

		const draw = () => {
			raf = requestAnimationFrame(draw);
			if (++frame % 2) return;
			const speaking = agent.status === 'speaking';
			const live = agent.active && agent.status !== 'reconnecting';
			const level = !live ? 0 : speaking ? Math.min(1, agent.outputLevel() * 5) : agent.micLevel;
			history.shift();
			history.push(level);
			const dpr = window.devicePixelRatio || 1;
			const w = canvas.clientWidth;
			const h = canvas.clientHeight;
			if (canvas.width !== w * dpr) {
				canvas.width = w * dpr;
				canvas.height = h * dpr;
			}
			ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
			ctx.clearRect(0, 0, w, h);
			const gap = 3;
			const bw = (w - gap * (BARS - 1)) / BARS;
			ctx.fillStyle = speaking ? colorVoice : live ? colorUser : colorIdle;
			for (let i = 0; i < BARS; i++) {
				const v = Math.max(0.06, Math.min(1, history[i] * 1.3));
				const bh = Math.max(2, v * h);
				ctx.globalAlpha = live ? 0.35 + 0.65 * (i / BARS) : 0.5;
				ctx.beginPath();
				ctx.roundRect(i * (bw + gap), (h - bh) / 2, bw, bh, 1.5);
				ctx.fill();
			}
		};
		draw();
		return () => cancelAnimationFrame(raf);
	}
</script>

<canvas {@attach meter} class="h-12 w-full" aria-hidden="true"></canvas>
