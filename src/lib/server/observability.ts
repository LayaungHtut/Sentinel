/**
 * Structured logging (one JSON object per line: easy to ship to any log
 * pipeline) and in-process Prometheus metrics exposed at /api/metrics.
 * Never pass secrets or raw transcript text into log fields.
 */

type Level = 'debug' | 'info' | 'warn' | 'error';
const LEVELS: Record<Level, number> = { debug: 10, info: 20, warn: 30, error: 40 };

function threshold(): number {
	const env = (process.env.LOG_LEVEL ?? 'info') as Level;
	return LEVELS[env] ?? LEVELS.info;
}

function serializeError(e: unknown) {
	if (e instanceof Error)
		return { name: e.name, message: e.message, stack: e.stack?.split('\n').slice(0, 6).join('\n') };
	return { message: String(e) };
}

function write(level: Level, msg: string, fields: Record<string, unknown> = {}) {
	if (LEVELS[level] < threshold()) return;
	const entry: Record<string, unknown> = { ts: new Date().toISOString(), level, msg };
	for (const [k, v] of Object.entries(fields)) entry[k] = k === 'err' ? serializeError(v) : v;
	const line = JSON.stringify(entry);
	if (level === 'error' || level === 'warn') process.stderr.write(line + '\n');
	else process.stdout.write(line + '\n');
}

export const log = {
	debug: (msg: string, f?: Record<string, unknown>) => write('debug', msg, f),
	info: (msg: string, f?: Record<string, unknown>) => write('info', msg, f),
	warn: (msg: string, f?: Record<string, unknown>) => write('warn', msg, f),
	error: (msg: string, f?: Record<string, unknown>) => write('error', msg, f)
};

// ─── Metrics ────────────────────────────────────────────────────────────────

type Labels = Record<string, string>;
const labelKey = (l: Labels) =>
	Object.keys(l)
		.sort()
		.map((k) => `${k}="${String(l[k]).replace(/["\\\n]/g, '_')}"`)
		.join(',');

class Counter {
	private values = new Map<string, number>();
	constructor(
		readonly name: string,
		readonly help: string
	) {}
	inc(labels: Labels = {}, by = 1) {
		const k = labelKey(labels);
		this.values.set(k, (this.values.get(k) ?? 0) + by);
	}
	render(): string {
		const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} counter`];
		for (const [k, v] of this.values) lines.push(`${this.name}${k ? `{${k}}` : ''} ${v}`);
		return lines.join('\n');
	}
}

class Histogram {
	private buckets: number[];
	private data = new Map<string, { counts: number[]; sum: number; count: number }>();
	constructor(
		readonly name: string,
		readonly help: string,
		buckets: number[]
	) {
		this.buckets = buckets;
	}
	observe(value: number, labels: Labels = {}) {
		const k = labelKey(labels);
		const d = this.data.get(k) ?? { counts: this.buckets.map(() => 0), sum: 0, count: 0 };
		this.buckets.forEach((b, i) => {
			if (value <= b) d.counts[i]++;
		});
		d.sum += value;
		d.count++;
		this.data.set(k, d);
	}
	render(): string {
		const lines = [`# HELP ${this.name} ${this.help}`, `# TYPE ${this.name} histogram`];
		for (const [k, d] of this.data) {
			const base = k ? `${k},` : '';
			this.buckets.forEach((b, i) =>
				lines.push(`${this.name}_bucket{${base}le="${b}"} ${d.counts[i]}`)
			);
			lines.push(`${this.name}_bucket{${base}le="+Inf"} ${d.count}`);
			lines.push(`${this.name}_sum${k ? `{${k}}` : ''} ${d.sum}`);
			lines.push(`${this.name}_count${k ? `{${k}}` : ''} ${d.count}`);
		}
		return lines.join('\n');
	}
}

export const metrics = {
	toolCalls: new Counter(
		'sentinel_tool_calls_total',
		'Tool executions by tool, origin and outcome'
	),
	toolLatency: new Histogram(
		'sentinel_tool_duration_ms',
		'Tool execution time in ms',
		[10, 25, 50, 100, 250, 500, 1000, 2500]
	),
	voiceSessions: new Counter('sentinel_voice_sessions_total', 'Voice sessions by outcome'),
	voiceSeconds: new Counter('sentinel_voice_session_seconds_total', 'Voice session seconds'),
	voiceReplyLatency: new Histogram(
		'sentinel_voice_reply_latency_ms',
		'User end-of-turn to first agent audio (ms)',
		[300, 600, 1000, 1500, 2500, 4000, 7000]
	),
	interruptions: new Counter(
		'sentinel_voice_interruptions_total',
		'Agent replies interrupted by the user'
	),
	escalations: new Counter('sentinel_escalations_total', 'Escalations by trigger'),
	notifications: new Counter('sentinel_notifications_total', 'Notifications by channel and status'),
	httpErrors: new Counter('sentinel_http_errors_total', 'HTTP 5xx responses by route')
};

export function renderMetrics(): string {
	return (
		Object.values(metrics)
			.map((m) => m.render())
			.join('\n\n') + '\n'
	);
}
