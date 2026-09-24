import type {
	ActionPriority,
	ContactRole,
	FactCategory,
	IncidentType,
	InfoPriority,
	Severity
} from './types';

export interface InfoTemplate {
	key: string;
	label: string;
	/** Natural, spoken-style question the agent can ask. */
	question: string;
	priority: InfoPriority;
	category: FactCategory;
}

export interface ActionTemplate {
	title: string;
	description: string;
	priority: ActionPriority;
	contactRole?: ContactRole;
	requiresResponse?: boolean;
}

export interface Playbook {
	type: IncidentType;
	label: string;
	baseSeverity: Severity;
	info: InfoTemplate[];
	actions: ActionTemplate[];
	/** Who to escalate to when a contact of the given role does not respond. */
	escalationChain: Partial<Record<ContactRole, ContactRole>>;
	keyterms: string[];
}

const location: InfoTemplate = {
	key: 'location',
	label: 'Location',
	question: 'Which site or branch is this at?',
	priority: 'critical',
	category: 'location'
};
const incidentStart: InfoTemplate = {
	key: 'incident_start',
	label: 'Incident start',
	question: 'When did this start?',
	priority: 'important',
	category: 'timing'
};
const responsiblePerson: InfoTemplate = {
	key: 'responsible_person',
	label: 'Responsible person',
	question: 'Who is on site and responsible right now?',
	priority: 'important',
	category: 'people'
};
const peopleAtRisk: InfoTemplate = {
	key: 'people_at_risk',
	label: 'People at risk',
	question: 'Is anyone hurt or at risk?',
	priority: 'critical',
	category: 'people'
};

const DEFAULT_CHAIN: Playbook['escalationChain'] = {
	maintenance: 'operations_manager',
	branch_manager: 'operations_manager',
	it_support: 'operations_manager',
	food_safety: 'operations_manager',
	security: 'operations_manager'
};

export const PLAYBOOKS: Record<IncidentType, Playbook> = {
	refrigeration_failure: {
		type: 'refrigeration_failure',
		label: 'Refrigeration failure',
		baseSeverity: 'medium',
		info: [
			location,
			incidentStart,
			{
				key: 'temperature',
				label: 'Temperature',
				question: 'What does the temperature display read right now?',
				priority: 'critical',
				category: 'measurement'
			},
			{
				key: 'affected_inventory',
				label: 'Affected inventory',
				question: 'What stock is inside the unit?',
				priority: 'critical',
				category: 'impact'
			},
			{
				key: 'unit_status',
				label: 'Unit status',
				question: 'Is the unit completely off, or still running but not cooling?',
				priority: 'critical',
				category: 'equipment'
			},
			{
				key: 'backup_storage',
				label: 'Backup cold storage',
				question: 'Is there another fridge or freezer the food can go into?',
				priority: 'critical',
				category: 'mitigation'
			},
			responsiblePerson,
			{
				key: 'doors_closed',
				label: 'Doors kept closed',
				question: 'Have the doors been kept closed since it failed?',
				priority: 'important',
				category: 'mitigation'
			},
			{
				key: 'inventory_quantity',
				label: 'Inventory quantity',
				question: 'Roughly how much stock is inside?',
				priority: 'optional',
				category: 'impact'
			}
		],
		actions: [
			{
				title: 'Keep refrigeration doors closed',
				description: 'Minimise temperature rise until stock is moved or the unit is repaired.',
				priority: 'immediate'
			},
			{
				title: 'Move perishable inventory to alternate cold storage',
				description: 'Prioritise raw meat, poultry and dairy.',
				priority: 'immediate'
			},
			{
				title: 'Contact maintenance',
				description: 'Request urgent repair of the refrigeration unit.',
				priority: 'immediate',
				contactRole: 'maintenance',
				requiresResponse: true
			},
			{
				title: 'Notify branch manager',
				description: 'Make sure the branch manager is aware of the incident.',
				priority: 'high',
				contactRole: 'branch_manager'
			},
			{
				title: 'Record unit temperature every 15 minutes',
				description: 'Build a verified temperature log for the food-safety decision.',
				priority: 'high'
			},
			{
				title: 'Assess affected inventory for food safety',
				description: 'Decide keep / discard based on time above 5 °C.',
				priority: 'normal',
				contactRole: 'food_safety'
			}
		],
		escalationChain: DEFAULT_CHAIN,
		keyterms: ['refrigeration', 'freezer', 'compressor', 'chiller', 'walk-in', 'Celsius', 'dairy']
	},
	pos_outage: {
		type: 'pos_outage',
		label: 'POS system failure',
		baseSeverity: 'medium',
		info: [
			location,
			incidentStart,
			{
				key: 'affected_terminals',
				label: 'Affected terminals',
				question: 'Are all the tills down, or just some?',
				priority: 'critical',
				category: 'impact'
			},
			{
				key: 'error_message',
				label: 'Error message',
				question: 'What does the screen or error message say?',
				priority: 'important',
				category: 'equipment'
			},
			{
				key: 'payment_fallback',
				label: 'Payment fallback',
				question: 'Can you still take payments another way, like cash or a card reader?',
				priority: 'critical',
				category: 'mitigation'
			},
			{
				key: 'network_status',
				label: 'Network status',
				question: 'Is the internet working on other devices?',
				priority: 'important',
				category: 'equipment'
			},
			{
				key: 'customer_impact',
				label: 'Customer impact',
				question: 'How many customers are waiting?',
				priority: 'important',
				category: 'impact'
			},
			responsiblePerson
		],
		actions: [
			{
				title: 'Switch to fallback payment method',
				description: 'Cash or standalone card reader; log manual sales.',
				priority: 'immediate'
			},
			{
				title: 'Restart affected POS terminals',
				description: 'Power-cycle one terminal first and record the result.',
				priority: 'high'
			},
			{
				title: 'Contact IT support',
				description: 'Report the outage with the error message and scope.',
				priority: 'immediate',
				contactRole: 'it_support',
				requiresResponse: true
			},
			{
				title: 'Notify branch manager',
				description: 'Make sure the branch manager is aware.',
				priority: 'high',
				contactRole: 'branch_manager'
			}
		],
		escalationChain: DEFAULT_CHAIN,
		keyterms: ['POS', 'till', 'terminal', 'card reader', 'receipt printer']
	},
	it_outage: generic('it_outage', 'IT / production outage', 'high', ['outage', 'server', 'API']),
	equipment_failure: generic('equipment_failure', 'Equipment failure', 'medium', ['compressor']),
	power_outage: generic('power_outage', 'Power outage', 'high', ['generator', 'breaker']),
	water_leak: generic('water_leak', 'Water leak', 'medium', ['leak', 'pipe', 'flooding']),
	damaged_shipment: generic('damaged_shipment', 'Damaged shipment', 'low', ['pallet', 'delivery']),
	guest_safety: generic('guest_safety', 'Guest safety incident', 'high', ['injury', 'first aid']),
	fire_safety: generic('fire_safety', 'Fire / smoke', 'critical', ['smoke', 'fire alarm']),
	other: generic('other', 'Other incident', 'low', [])
};

function generic(
	type: IncidentType,
	label: string,
	baseSeverity: Severity,
	keyterms: string[]
): Playbook {
	return {
		type,
		label,
		baseSeverity,
		info: [
			location,
			incidentStart,
			peopleAtRisk,
			{
				key: 'impact',
				label: 'Operational impact',
				question: 'What is it affecting right now?',
				priority: 'critical',
				category: 'impact'
			},
			responsiblePerson
		],
		actions: [],
		escalationChain: DEFAULT_CHAIN,
		keyterms
	};
}

export function getPlaybook(type: IncidentType): Playbook {
	return PLAYBOOKS[type] ?? PLAYBOOKS.other;
}

export const INFO_PRIORITY_RANK: Record<InfoPriority, number> = {
	critical: 0,
	important: 1,
	optional: 2
};

export const CONTACT_ROLE_LABELS: Record<ContactRole, string> = {
	branch_manager: 'Branch manager',
	maintenance: 'Maintenance',
	operations_manager: 'Operations manager',
	it_support: 'IT support',
	food_safety: 'Food safety lead',
	security: 'Security'
};

/** Demo timeouts are compressed so escalation is visible live; production uses minutes. */
export const RESPONSE_TIMEOUT_SECONDS = {
	demo: 30,
	production: 15 * 60
} as const;
