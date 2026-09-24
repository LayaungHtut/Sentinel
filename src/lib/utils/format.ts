export function fmtClock(iso: string | Date | null | undefined, seconds = true): string {
	if (!iso) return '—';
	const d = typeof iso === 'string' ? new Date(iso) : iso;
	return d.toLocaleTimeString([], {
		hour: '2-digit',
		minute: '2-digit',
		...(seconds ? { second: '2-digit' } : {}),
		hour12: false
	});
}

export function fmtDateTime(iso: string | Date | null | undefined): string {
	if (!iso) return '—';
	const d = typeof iso === 'string' ? new Date(iso) : iso;
	return d.toLocaleString([], {
		year: 'numeric',
		month: 'short',
		day: 'numeric',
		hour: '2-digit',
		minute: '2-digit',
		hour12: false
	});
}

export function fmtRelative(iso: string | null | undefined, now = Date.now()): string {
	if (!iso) return '—';
	const diff = Math.round((now - new Date(iso).getTime()) / 1000);
	const abs = Math.abs(diff);
	const suffix = diff >= 0 ? 'ago' : 'from now';
	if (abs < 45) return diff >= 0 ? 'just now' : 'in a moment';
	if (abs < 3600) return `${Math.round(abs / 60)} min ${suffix}`;
	if (abs < 86400) return `${Math.round(abs / 3600)} h ${suffix}`;
	return `${Math.round(abs / 86400)} d ${suffix}`;
}

export function fmtCountdown(totalSeconds: number): string {
	const s = Math.max(0, Math.round(totalSeconds));
	return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function titleCase(s: string): string {
	return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
