import type { EpistemicClass, FactRecord, TranscriptRecord } from './types';

/**
 * Derive how a fact should be presented. Precedence matters:
 * a disputed or inferred value must never be displayed as settled,
 * and "confirmed" is reserved for independent confirmation.
 */
export function classifyFact(
	fact: Pick<FactRecord, 'verification' | 'basis' | 'certainty' | 'needsVerification'>
): EpistemicClass {
	if (fact.verification === 'disputed') return 'disputed';
	if (fact.verification === 'confirmed') return 'confirmed';
	if (fact.basis === 'observed') return 'observed';
	if (fact.basis === 'inferred') return 'inferred';
	if (fact.certainty === 'approximate') return 'approximate';
	if (fact.needsVerification) return 'unverified';
	return 'reported';
}

export const EPISTEMIC_LABELS: Record<EpistemicClass, string> = {
	confirmed: 'Confirmed',
	reported: 'Reported',
	unverified: 'Unverified',
	approximate: 'Approximate',
	inferred: 'Inferred',
	disputed: 'Disputed',
	observed: 'Sensor reading'
};

export const EPISTEMIC_DESCRIPTIONS: Record<EpistemicClass, string> = {
	confirmed: 'Independently confirmed by a later statement or action.',
	reported: 'Stated directly by the reporter.',
	unverified: 'Stated directly, but a reading or claim that has not been verified.',
	approximate: 'Stated as an estimate — precision is limited.',
	inferred: 'Reasoned by SENTINEL from other facts. Not stated by anyone.',
	disputed: 'Later called into question. Treat with caution.',
	observed:
		'Measured by an instrument and delivered through the sensor API, not spoken by a person.'
};

/** Measurement-type facts need verification by default. */
export function defaultNeedsVerification(category: string): boolean {
	return category === 'measurement';
}

const HEDGED =
	/^~|\b(about|around|roughly|approx(imately)?|maybe|nearly|almost|circa|some|probably|i think)\b/i;

export function formatFactValue(
	fact: Pick<FactRecord, 'value' | 'numericValue' | 'unit' | 'certainty'>
): string {
	let text = fact.value;
	if (fact.numericValue !== null && fact.unit) {
		const unit = normalizeUnitLabel(fact.unit);
		const num = Number.isInteger(fact.numericValue)
			? String(fact.numericValue)
			: fact.numericValue.toFixed(1);
		text = `${num}${unit}`;
	}
	// Mark estimates, unless the wording already carries the hedge ("about 20 minutes").
	if (fact.certainty === 'approximate' && !HEDGED.test(text)) text = `~${text}`;
	return text;
}

function normalizeUnitLabel(unit: string): string {
	const u = unit.trim().toLowerCase();
	if (u === 'c' || u === '°c' || u === 'celsius') return '°C';
	if (u === 'f' || u === '°f' || u === 'fahrenheit') return '°F';
	if (u === 'min' || u === 'minutes') return ' min';
	return ` ${unit.trim()}`;
}

export function toCelsius(value: number, unit: string | null): number | null {
	if (!unit) return null;
	const u = unit.trim().toLowerCase();
	if (u === 'c' || u === '°c' || u === 'celsius') return value;
	if (u === 'f' || u === '°f' || u === 'fahrenheit') return ((value - 32) * 5) / 9;
	return null;
}

export function normalizeFactKey(key: string): string {
	return key
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 64);
}

export function humanizeKey(key: string): string {
	const s = key.replace(/_/g, ' ');
	return s.charAt(0).toUpperCase() + s.slice(1);
}

/** True when two facts carry the same claim (used to make add_fact idempotent). */
export function sameClaim(
	a: Pick<FactRecord, 'value' | 'numericValue' | 'unit' | 'certainty'>,
	b: Pick<FactRecord, 'value' | 'numericValue' | 'unit' | 'certainty'>
): boolean {
	if (a.certainty !== b.certainty) return false;
	if (a.numericValue !== null || b.numericValue !== null) {
		return a.numericValue === b.numericValue && (a.unit ?? '') === (b.unit ?? '');
	}
	return normalizeText(a.value) === normalizeText(b.value);
}

// ---------------------------------------------------------------------------
// Evidence quote matching
// ---------------------------------------------------------------------------

const NUMBER_WORDS: Record<string, string> = {
	zero: '0',
	one: '1',
	two: '2',
	three: '3',
	four: '4',
	five: '5',
	six: '6',
	seven: '7',
	eight: '8',
	nine: '9',
	ten: '10',
	eleven: '11',
	twelve: '12',
	thirteen: '13',
	fourteen: '14',
	fifteen: '15',
	sixteen: '16',
	seventeen: '17',
	eighteen: '18',
	nineteen: '19',
	twenty: '20',
	thirty: '30',
	forty: '40',
	fifty: '50',
	sixty: '60'
};

export function normalizeText(text: string): string {
	return text
		.toLowerCase()
		.replace(/[’']/g, '')
		.replace(/[^a-z0-9.\s]/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
		.map((w) => NUMBER_WORDS[w] ?? w.replace(/\.$/, ''))
		.join(' ');
}

export interface QuoteMatch {
	transcriptId: string;
	score: number;
	exact: boolean;
}

/**
 * Locate the user utterance that supports a fact. Exact (normalised)
 * substring wins; otherwise the best token-overlap match above a threshold.
 * Returns null when the quote cannot be traced — the fact is then stored
 * with quoteMatched=false so the UI can flag weak provenance.
 */
export function matchEvidenceQuote(
	quote: string,
	transcripts: Pick<TranscriptRecord, 'id' | 'speaker' | 'text'>[],
	threshold = 0.6
): QuoteMatch | null {
	const q = normalizeText(quote);
	if (!q) return null;
	const candidates = transcripts.filter((t) => t.speaker === 'user');
	// Prefer the most recent utterance when several match.
	for (let i = candidates.length - 1; i >= 0; i--) {
		if (normalizeText(candidates[i].text).includes(q)) {
			return { transcriptId: candidates[i].id, score: 1, exact: true };
		}
	}
	const qTokens = new Set(q.split(' '));
	let best: QuoteMatch | null = null;
	for (let i = candidates.length - 1; i >= 0; i--) {
		const tTokens = new Set(normalizeText(candidates[i].text).split(' '));
		let hit = 0;
		for (const tok of qTokens) if (tTokens.has(tok)) hit++;
		const score = hit / qTokens.size;
		if (score >= threshold && (!best || score > best.score)) {
			best = { transcriptId: candidates[i].id, score, exact: false };
		}
	}
	return best;
}

// ---------------------------------------------------------------------------
// Simple value semantics used by severity rules
// ---------------------------------------------------------------------------

const NEGATIVE =
	/\b(no|none|not|nobody|nothing|unavailable|isn'?t|aren'?t|don'?t|doesn'?t|cannot|can'?t|without|negative)\b/i;
const AFFIRMATIVE =
	/\b(yes|yeah|available|there is|we have|working|another|spare|backup|ok|okay)\b/i;

export function isNegativeStatement(value: string): boolean {
	return NEGATIVE.test(value);
}

export function isAffirmativeStatement(value: string): boolean {
	return AFFIRMATIVE.test(value) && !NEGATIVE.test(value);
}

export const PERISHABLE_TERMS = [
	'chicken',
	'poultry',
	'meat',
	'beef',
	'pork',
	'fish',
	'seafood',
	'prawn',
	'shrimp',
	'dairy',
	'milk',
	'cheese',
	'cream',
	'yogurt',
	'butter',
	'egg',
	'vaccine',
	'insulin',
	'medicine'
];

export function findPerishables(value: string): string[] {
	const v = value.toLowerCase();
	return PERISHABLE_TERMS.filter((t) => v.includes(t));
}
