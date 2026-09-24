import { isAssemblyAIConfigured } from '$lib/server/assemblyai/token';
import { getScenario } from '$lib/demo/scenarios';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async ({ url }) => {
	const scenario = getScenario(url.searchParams.get('scenario'));
	return { scenarioId: scenario?.id ?? null, voiceConfigured: isAssemblyAIConfigured() };
};
