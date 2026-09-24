/**
 * Demo scenarios. All organisations and people are FICTIONAL demo data.
 * A scenario only provides context and a suggested script — the incident
 * itself is created live by the voice agent from what the user says.
 */
export interface DemoScenario {
	id: string;
	title: string;
	organization: string;
	site: string;
	blurb: string;
	/** Suggested lines for the presenter. Nothing here is fed to the agent automatically. */
	script: { speaker: 'you' | 'note'; text: string }[];
}

export const DEMO_ORGANIZATION = 'Golden Fork Restaurant (demo)';

export const DEMO_SCENARIOS: DemoScenario[] = [
	{
		id: 'refrigeration',
		title: 'Restaurant refrigeration failure',
		organization: DEMO_ORGANIZATION,
		site: 'Yangon Branch',
		blurb: 'Walk-in unit stops cooling with frozen chicken and dairy inside.',
		script: [
			{
				speaker: 'you',
				text: "The refrigeration unit at our Yangon branch stopped cooling about twenty minutes ago. It's showing twelve degrees and we've got frozen chicken and dairy inside."
			},
			{ speaker: 'you', text: "It's running, but it's not cooling. What should we do right now?" },
			{
				speaker: 'note',
				text: 'While SENTINEL is answering, talk over it: it stops mid-sentence (barge-in).'
			},
			{ speaker: 'you', text: 'Wait, stop. I already moved the food to the bar fridge.' },
			{ speaker: 'you', text: 'Please get maintenance on it.' },
			{
				speaker: 'note',
				text: 'Maintenance does not reply → after 30 s SENTINEL escalates to Maya Win (demo simulation).'
			},
			{ speaker: 'you', text: 'Actually, I checked again. It says thirteen point four degrees.' },
			{ speaker: 'you', text: 'Generate the incident report.' }
		]
	},
	{
		id: 'pos',
		title: 'Retail POS failure',
		organization: DEMO_ORGANIZATION,
		site: 'Mandalay Branch',
		blurb: 'All tills freeze at lunch rush; the card reader may still work.',
		script: [
			{
				speaker: 'you',
				text: 'All the tills at the Mandalay branch just froze, it started maybe five minutes ago. There is a queue of around fifteen customers.'
			},
			{ speaker: 'you', text: 'The screen says payment service unavailable.' },
			{ speaker: 'you', text: 'We can still take cash, the card reader is down too.' },
			{ speaker: 'you', text: 'Please get IT support on it.' }
		]
	}
];

export function getScenario(id: string | null | undefined): DemoScenario | null {
	return DEMO_SCENARIOS.find((s) => s.id === id) ?? null;
}
