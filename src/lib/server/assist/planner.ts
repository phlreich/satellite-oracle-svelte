import type { OpenAI } from 'openai';
import type {
	EasyInputMessage,
	FunctionTool,
	Response
} from 'openai/resources/responses/responses';
import type { AssistRequestBody, CatalogQuerySpec, SceneContext } from './types';

export type AssistPlanKind = 'count' | 'view_update' | 'explain_selected' | 'clarify';

export type AssistPlan = {
	kind: AssistPlanKind;
	query?: CatalogQuerySpec;
	question?: string;
};

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
- For kind=count, query.queryType must be "count".
- For kind=view_update, query.queryType must be "select" and mode must be replace/add/remove.
- Never invent results. Only plan actions.
`;

function shouldRetryWithoutPreviousResponse(error: unknown): boolean {
	if (!error || typeof error !== 'object') {
		return false;
	}
	const candidate = error as { message?: string; param?: string };
	const message = (candidate.message ?? '').toLowerCase();
	const param = (candidate.param ?? '').toLowerCase();
	return (
		param.includes('previous_response_id') ||
		message.includes('previous_response_id') ||
		message.includes('response id') ||
		message.includes('not found')
	);
}

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

export function inferViewMode(message: string): 'replace' | 'add' | 'remove' {
	const latest = message.toLowerCase();
	if (/\badd|include|also show|plus\b/.test(latest)) {
		return 'add';
	}
	if (/\bhide|remove|exclude|subtract\b/.test(latest)) {
		return 'remove';
	}
	return 'replace';
}

function maybePushYearFilter(
	latest: string,
	filters: CatalogQuerySpec['filters'],
	op: 'lt' | 'gt',
	pattern: RegExp
) {
	const match = latest.match(pattern);
	if (!match) {
		return;
	}
	const yearText = match[0].match(/(19|20)\d{2}/)?.[0];
	if (!yearText) {
		return;
	}
	filters.push({
		field: 'launch_year',
		op,
		value: Number(yearText)
	});
}

export function buildHeuristicQuery(
	latestMessage: string,
	queryType: 'count' | 'select',
	mode: 'replace' | 'add' | 'remove'
): CatalogQuerySpec {
	const latest = latestMessage.toLowerCase();
	const filters: CatalogQuerySpec['filters'] = [];

	if (/\bstarlink\b/.test(latest)) {
		filters.push({ field: 'object_name', op: 'contains', value: 'starlink' });
	}

	if (/\bdebris\b/.test(latest)) {
		filters.push({ field: 'object_type', op: 'eq', value: 'debris' });
	}
	if (/\bpayload|satellite(s)?\b/.test(latest)) {
		filters.push({ field: 'object_type', op: 'eq', value: 'payload' });
	}
	if (/\brocket body|rocket|booster\b/.test(latest)) {
		filters.push({ field: 'object_type', op: 'eq', value: 'rocket body' });
	}

	if (/\bgerman|germany|deutsch\b/.test(latest)) {
		filters.push({ field: 'country_code', op: 'eq', value: 'germany' });
	} else if (/\bamerican|united states|usa|u\.s\.\b/.test(latest)) {
		filters.push({ field: 'country_code', op: 'eq', value: 'usa' });
	} else if (/\bchinese|china\b/.test(latest)) {
		filters.push({ field: 'country_code', op: 'eq', value: 'china' });
	} else if (/\brussian|russia\b/.test(latest)) {
		filters.push({ field: 'country_code', op: 'eq', value: 'russia' });
	}

	if (/\bleo|low earth orbit\b/.test(latest)) {
		filters.push({ field: 'orbit_class', op: 'eq', value: 'LEO' });
	} else if (/\bmeo|medium earth orbit\b/.test(latest)) {
		filters.push({ field: 'orbit_class', op: 'eq', value: 'MEO' });
	} else if (/\bgeo|geostationary\b/.test(latest)) {
		filters.push({ field: 'orbit_class', op: 'eq', value: 'GEO' });
	} else if (/\bheo|high earth orbit\b/.test(latest)) {
		filters.push({ field: 'orbit_class', op: 'eq', value: 'HEO' });
	}

	maybePushYearFilter(latest, filters, 'lt', /\b(before|pre)\s+(19|20)\d{2}\b/);
	maybePushYearFilter(latest, filters, 'gt', /\b(after|since|post)\s+(19|20)\d{2}\b/);

	return {
		queryType,
		mode,
		limit: queryType === 'select' ? 2500 : undefined,
		filters
	};
}

export function buildFallbackPlan(messages: AssistRequestBody['messages']): AssistPlan {
	const latest =
		messages
			.slice()
			.reverse()
			.find((message) => message.role === 'user')
			?.content.toLowerCase() ?? '';
	const hasViewVerb =
		/\bshow|display|hide|highlight|focus|draw|plot|visuali[sz]e|filter|remove|add|select\b/.test(
			latest
		);
	const isCount = /\bhow many|count|number of|total\b/.test(latest);
	const isExplain = /\bwhy|explain|what does|what is|how high|how low\b/.test(latest);

	if (isCount && !hasViewVerb) {
		return {
			kind: 'count',
			query: buildHeuristicQuery(latest, 'count', 'replace')
		};
	}
	if (hasViewVerb) {
		const mode = inferViewMode(latest);
		return {
			kind: 'view_update',
			query: buildHeuristicQuery(latest, 'select', mode)
		};
	}
	if (isExplain) {
		return { kind: 'explain_selected' };
	}
	return { kind: 'clarify', question: 'What would you like me to filter or count?' };
}

function normalizeSceneContext(sceneContext?: SceneContext) {
	const visibleNoradIds = Array.isArray(sceneContext?.visibleNoradIds)
		? sceneContext.visibleNoradIds.filter((value) => Number.isInteger(value)).slice(0, 250)
		: [];
	const visibleCount =
		typeof sceneContext?.visibleCount === 'number' && Number.isFinite(sceneContext.visibleCount)
			? Math.max(0, Math.floor(sceneContext.visibleCount))
			: visibleNoradIds.length;

	return {
		selectedNoradId:
			typeof sceneContext?.selectedNoradId === 'number' &&
			Number.isInteger(sceneContext.selectedNoradId)
				? sceneContext.selectedNoradId
				: null,
		visibleNoradIds,
		visibleCount,
		timestamp:
			typeof sceneContext?.timestamp === 'string' && sceneContext.timestamp.trim() !== ''
				? sceneContext.timestamp
				: new Date().toISOString()
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
	body
}: {
	openai: OpenAI;
	model: string;
	body: AssistRequestBody;
}): Promise<{ plan: AssistPlan; responseId: string | null }> {
	const normalizedContext = normalizeSceneContext(body.sceneContext);
	const input = buildPlannerInput(body.messages);
	let response: Response;

	const requestArgs = {
		model,
		instructions: `${PLANNER_PROMPT}\nScene context: ${JSON.stringify(normalizedContext)}.`,
		input,
		tools: [PLANNER_TOOL],
		tool_choice: { type: 'function' as const, name: 'propose_assist_plan' as const },
		previous_response_id: body.previousResponseId ?? undefined
	};

	try {
		response = await openai.responses.create(requestArgs);
	} catch (error) {
		if (body.previousResponseId && shouldRetryWithoutPreviousResponse(error)) {
			response = await openai.responses.create({ ...requestArgs, previous_response_id: undefined });
		} else {
			throw error;
		}
	}

	const parsedPlan = normalizePlan(extractPlannedArguments(response));
	return {
		plan: parsedPlan ?? buildFallbackPlan(body.messages),
		responseId: response.id ?? null
	};
}
