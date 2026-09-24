/**
 * AudioWorklet source, loaded via a Blob URL so no separate static file or
 * extra network request is needed (works under any base path and in tests).
 */
export const PCM_CAPTURE_WORKLET = String.raw`// AudioWorklet: capture mic audio, resample to 24 kHz mono PCM16 and post
// ~50 ms chunks plus an RMS level for the UI meter.
// Pattern from AssemblyAI's browser-integration guide (resample inside the
// worklet so Firefox keeps echo cancellation and Safari's hardware rate works).
class PcmCaptureProcessor extends AudioWorkletProcessor {
	constructor(options) {
		super();
		const { inputSampleRate, targetSampleRate } = options.processorOptions;
		this.ratio = inputSampleRate / targetSampleRate;
		this.chunkSamples = Math.round(targetSampleRate * 0.05);
		this.buffer = new Int16Array(this.chunkSamples);
		this.filled = 0;
		this.pos = 0; // fractional read position carried across render quanta
		this.sumSquares = 0;
		this.levelCount = 0;
	}

	process(inputs) {
		const input = inputs[0] && inputs[0][0];
		if (!input) return true;
		for (let i = 0; i < input.length; i++) this.sumSquares += input[i] * input[i];
		this.levelCount += input.length;

		while (this.pos < input.length) {
			const idx = Math.floor(this.pos);
			const frac = this.pos - idx;
			const a = input[idx];
			const b = idx + 1 < input.length ? input[idx + 1] : a;
			const sample = a + (b - a) * frac;
			this.buffer[this.filled++] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
			if (this.filled === this.chunkSamples) {
				const level = Math.sqrt(this.sumSquares / Math.max(1, this.levelCount));
				this.port.postMessage({ pcm: this.buffer.buffer, level }, [this.buffer.buffer]);
				this.buffer = new Int16Array(this.chunkSamples);
				this.filled = 0;
				this.sumSquares = 0;
				this.levelCount = 0;
			}
			this.pos += this.ratio;
		}
		this.pos -= input.length;
		return true;
	}
}

registerProcessor('pcm-capture', PcmCaptureProcessor);
`;
