import type { OpenAI } from 'openai';
import type {
	EasyInputMessage,
	FunctionTool,
	Response
} from 'openai/resources/responses/responses';
import type { AssistRequestBody, CatalogQuerySpec, SceneContext } from './types';
import { createLogger, serializeError } from '$lib/server/logger';

export type AssistPlanKind = 'count' | 'view_update' | 'explain_selected' | 'clarify';

export type AssistPlan = {
	kind: AssistPlanKind;
	query?: CatalogQuerySpec;
	question?: string;
};

const CLARIFY_FALLBACK_QUESTION =
	'I need a clearer request. Tell me what to filter, count, add, or remove.';

const PLANNER_TOOL: FunctionTool = {
	type: 'function',
	name: 'propose_assist_plan',
	description:
		'Propose a deterministic execution plan for the user request. Do not execute anything.',
	strict: false,
	parameters: {
		type: 'object',
		properties: {
			kind: { type: 'string', enum: ['count', 'view_update', 'explain_selected', 'clarify'] },
			question: { type: 'string' },
			query: {
				type: 'object',
				properties: {
					queryType: { type: 'string', enum: ['count', 'select'] },
					mode: { type: 'string', enum: ['replace', 'add', 'remove'] },
					limit: { type: 'number' },
					filters: {
						type: 'array',
						items: {
							type: 'object',
							properties: {
								field: {
									type: 'string',
									enum: [
										'norad_cat_id',
										'object_name',
										'object_type',
										'country_code',
										'launch_year',
										'apogee_km',
										'perigee_km',
										'period_minutes',
										'inclination_deg',
										'orbit_class',
										'site',
										'rcs_size'
									]
								},
								op: {
									type: 'string',
									enum: ['eq', 'neq', 'contains', 'in', 'gt', 'gte', 'lt', 'lte']
								},
								value: { anyOf: [{ type: 'string' }, { type: 'number' }] },
								values: {
									type: 'array',
									items: { anyOf: [{ type: 'string' }, { type: 'number' }] }
								}
							},
							required: ['field', 'op'],
							additionalProperties: false
						}
					}
				},
				required: ['queryType', 'filters'],
				additionalProperties: false
			}
		},
		required: ['kind'],
		additionalProperties: false
	}
};

const PLANNER_PROMPT = `
You are a planning component for Satellite Oracle.
Return exactly one plan via the propose_assist_plan function.

Planning rules:
- kind=count for analytical count/quantity questions.
- kind=view_update for show/hide/filter/add/remove requests.
- kind=explain_selected for "this orbit"/selected-object explanation requests.
- kind=clarify if the request is too ambiguous and you need one short follow-up question.
- If the user asks for one specific object (for example "the ISS"), set query.limit to 1.
- Prefer precise object filters over broad substring matches when a unique target is implied.
- For kind=count, query.queryType must be "count".
- For kind=view_update, query.queryType must be "select" and mode must be replace/add/remove.
- Never invent results. Only plan actions.
`;

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

function extractPlannedArguments(response: Response): Record<string, unknown> | null {
	for (const item of response.output) {
		if (item.type !== 'function_call') {
			continue;
		}
		if (item.name !== 'propose_assist_plan') {
			continue;
		}
		const parsed = parseJson(item.arguments);
		if (typeof parsed === 'object' && parsed !== null) {
			return parsed as Record<string, unknown>;
		}
	}
	return null;
}

function normalizePlan(candidate: Record<string, unknown> | null): AssistPlan | null {
	if (!candidate) {
		return null;
	}
	const kind = candidate.kind;
	if (
		kind !== 'count' &&
		kind !== 'view_update' &&
		kind !== 'explain_selected' &&
		kind !== 'clarify'
	) {
		return null;
	}
	const question = typeof candidate.question === 'string' ? candidate.question.trim() : undefined;
	const query =
		typeof candidate.query === 'object' && candidate.query !== null
			? (candidate.query as CatalogQuerySpec)
			: undefined;

	return {
		kind,
		question: question && question.length > 0 ? question : undefined,
		query
	};
}

function normalizeSceneContext(sceneContext?: SceneContext) {
	const visibleCount =
		typeof sceneContext?.visibleCount === 'number' && Number.isFinite(sceneContext.visibleCount)
			? Math.max(0, Math.floor(sceneContext.visibleCount))
			: 0;

	return {
		selectedNoradId:
			typeof sceneContext?.selectedNoradId === 'number' &&
			Number.isInteger(sceneContext.selectedNoradId)
				? sceneContext.selectedNoradId
				: null,
		visibleCount
	};
}

function buildPlannerInput(messages: AssistRequestBody['messages']): EasyInputMessage[] {
	const cleaned = messages
		.filter((message) => typeof message.content === 'string' && message.content.trim() !== '')
		.slice(-20)
		.map((message) => ({ role: message.role, content: message.content.trim() }));
	if (cleaned.length === 0) {
		return [{ role: 'user', content: 'Show currently visible objects.' }];
	}
	return cleaned;
}

export async function planAssistTurn({
	openai,
	model,
	body,
	requestId
}: {
	openai: OpenAI;
	model: string;
	body: AssistRequestBody;
	requestId?: string;
}): Promise<AssistPlan> {
	const logger = createLogger('assist.planner', {
		requestId: requestId ?? 'unknown',
		model
	});
	const normalizedContext = normalizeSceneContext(body.sceneContext);
	const input = buildPlannerInput(body.messages);
	let response: Response;

	const requestArgs = {
		model,
		instructions: `${PLANNER_PROMPT}\nScene context: ${JSON.stringify(normalizedContext)}.`,
		input,
		tools: [PLANNER_TOOL],
		tool_choice: { type: 'function' as const, name: 'propose_assist_plan' as const }
	};
	logger.info('planner request started', {
		messageCount: input.length,
		selectedNoradId: normalizedContext.selectedNoradId
	});

	try {
		response = await openai.responses.create(requestArgs);
	} catch (error) {
		logger.error('planner request failed', { error: serializeError(error) });
		throw error;
	}

	const parsedPlan = normalizePlan(extractPlannedArguments(response));
	const plan = parsedPlan ?? { kind: 'clarify', question: CLARIFY_FALLBACK_QUESTION };
	logger.info('planner request completed', {
		responseId: response.id ?? null,
		usedFallbackPlan: parsedPlan === null,
		kind: plan.kind,
		filterCount: plan.query?.filters.length ?? 0
	});
	return plan;
}
