import { OpenAI } from 'openai';
import type {
	EasyInputMessage,
	FunctionTool,
	Response,
	ResponseFunctionToolCall
} from 'openai/resources/responses/responses';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { OPENAI_API_KEY } from '$env/static/private';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { env } from '$env/dynamic/private';
import { getObjectDetails, runCatalogQuery } from './queryRuntime';
import type {
	AssistRequestBody,
	AssistResponse,
	CatalogQuerySpec,
	CatalogQueryResult,
	ObjectDetails,
	SceneContext
} from './types';

type UserIntent = 'analytical' | 'view_update';
type AnalyticalKind = 'count' | 'explain' | 'other';

const MAX_TOOL_STEPS = 6;

const ASSIST_TOOLS: FunctionTool[] = [
	{
		type: 'function',
		name: 'scene_context',
		description: 'Get scene context (selected object and visibility statistics).',
		strict: false,
		parameters: {
			type: 'object',
			properties: {},
			additionalProperties: false
		}
	},
	{
		type: 'function',
		name: 'execute_catalog_query',
		description:
			'Run a read-only catalog query. Use queryType=count for analytical questions and queryType=select for scene update requests.',
		strict: false,
		parameters: {
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
									'inclination_deg'
								]
							},
							op: {
								type: 'string',
								enum: ['eq', 'neq', 'contains', 'in', 'gt', 'gte', 'lt', 'lte']
							},
							value: {
								anyOf: [{ type: 'string' }, { type: 'number' }]
							},
							values: {
								type: 'array',
								items: {
									anyOf: [{ type: 'string' }, { type: 'number' }]
								}
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
	{
		type: 'function',
		name: 'get_object_details',
		description: 'Get details for one NORAD object, useful for explaining a selected orbit.',
		strict: false,
		parameters: {
			type: 'object',
			properties: {
				norad_cat_id: { type: 'number' }
			},
			required: ['norad_cat_id'],
			additionalProperties: false
		}
	}
];

const SYSTEM_PROMPT = `
You are Satellite Oracle's AI assistant.
You can answer analytical questions and scene-update requests.
Use tools, do not invent counts or object details.

Rules:
- For analytical questions (how many/count/why/explain), do NOT request scene updates.
- For analytical questions, prefer execute_catalog_query with queryType=count.
- For selected-object explanations, call get_object_details using scene_context.selectedNoradId.
- For view updates (show/hide/filter/display), use execute_catalog_query with queryType=select and mode replace/add/remove.
- If queryType=count result is zero, still provide a useful answer and suggest likely alternatives.
- If no selected object exists for a "this orbit" question, ask the user to select one.
- Keep responses short and explicit.
`;

function getLatestUserMessage(messages: AssistRequestBody['messages']): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') {
			return messages[i].content;
		}
	}
	return '';
}

function inferUserIntent(messages: AssistRequestBody['messages']): UserIntent {
	const latest = getLatestUserMessage(messages).toLowerCase();
	const analytical =
		/how many|count|number of|why|explain|what does|what is|how high|how low|statistics/.test(
			latest
		);
	const view =
		/\bshow|display|hide|highlight|focus|draw|plot|visuali[sz]e|filter|only|remove|add\b/.test(
			latest
		);
	if (analytical && !view) {
		return 'analytical';
	}
	return 'view_update';
}

function inferAnalyticalKind(latestMessage: string): AnalyticalKind {
	const latest = latestMessage.toLowerCase();
	if (/\bhow many|count|number of|total\b/.test(latest)) {
		return 'count';
	}
	if (/\bwhy|explain|what does|what is|how high|how low\b/.test(latest)) {
		return 'explain';
	}
	return 'other';
}

function buildInitialToolChoice(
	step: number,
	intent: UserIntent,
	analyticalKind: AnalyticalKind,
	selectedNoradId: number | null
): 'auto' | { type: 'function'; name: 'execute_catalog_query' | 'get_object_details' } {
	if (step > 0 || intent !== 'analytical') {
		return 'auto';
	}
	if (analyticalKind === 'count') {
		return { type: 'function', name: 'execute_catalog_query' };
	}
	if (analyticalKind === 'explain' && selectedNoradId !== null) {
		return { type: 'function', name: 'get_object_details' };
	}
	return 'auto';
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

function buildInitialInput(messages: AssistRequestBody['messages']): EasyInputMessage[] {
	const cleaned = messages
		.filter((message) => typeof message.content === 'string' && message.content.trim() !== '')
		.slice(-30)
		.map((message) => ({ role: message.role, content: message.content.trim() }));
	if (cleaned.length === 0) {
		return [{ role: 'user', content: 'Show currently visible objects.' }];
	}
	return cleaned;
}

function extractToolCalls(response: Response): ResponseFunctionToolCall[] {
	return response.output.filter(
		(item): item is ResponseFunctionToolCall => item.type === 'function_call'
	);
}

function parseJson(text: string): unknown {
	try {
		return JSON.parse(text);
	} catch {
		return null;
	}
}

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

function buildHeuristicCountSpec(latestMessage: string): CatalogQuerySpec | null {
	const latest = latestMessage.toLowerCase();
	const filters: CatalogQuerySpec['filters'] = [];

	if (/\bstarlink\b/.test(latest)) {
		filters.push({ field: 'object_name', op: 'contains', value: 'starlink' });
	}

	if (/\bdebris\b/.test(latest)) {
		filters.push({ field: 'object_type', op: 'eq', value: 'DEBRIS' });
	}
	if (/\bpayload|satellite(s)?\b/.test(latest)) {
		filters.push({ field: 'object_type', op: 'eq', value: 'PAYLOAD' });
	}
	if (/\brocket body|rocket\b/.test(latest)) {
		filters.push({ field: 'object_type', op: 'eq', value: 'ROCKET BODY' });
	}

	if (/\bgerman|germany|deutsch\b/.test(latest)) {
		filters.push({ field: 'country_code', op: 'eq', value: 'germany' });
	} else if (/\bamerican|united states|usa|u\.s\.| us\b/.test(latest)) {
		filters.push({ field: 'country_code', op: 'eq', value: 'usa' });
	} else if (/\bchinese|china\b/.test(latest)) {
		filters.push({ field: 'country_code', op: 'eq', value: 'china' });
	} else if (/\brussian|russia\b/.test(latest)) {
		filters.push({ field: 'country_code', op: 'eq', value: 'RUS' });
	}

	const beforeMatch = latest.match(/\b(before|pre)\s+(19|20)\d{2}\b/);
	if (beforeMatch) {
		const yearText = beforeMatch[0].match(/(19|20)\d{2}/)?.[0];
		if (yearText) {
			filters.push({ field: 'launch_year', op: 'lt', value: Number(yearText) });
		}
	}

	const afterMatch = latest.match(/\b(after|since|post)\s+(19|20)\d{2}\b/);
	if (afterMatch) {
		const yearText = afterMatch[0].match(/(19|20)\d{2}/)?.[0];
		if (yearText) {
			filters.push({ field: 'launch_year', op: 'gt', value: Number(yearText) });
		}
	}

	if (filters.length === 0) {
		return null;
	}

	return {
		queryType: 'count',
		filters
	};
}

function buildFallbackMessage(
	intent: UserIntent,
	lastQueryResult: CatalogQueryResult | null,
	lastDetails: ObjectDetails | null
): string {
	if (intent === 'analytical' && lastQueryResult?.queryType === 'count') {
		return `Query result: ${lastQueryResult.totalCount} matches (${lastQueryResult.filterSummary}). No scene change was applied.`;
	}
	if (intent === 'analytical' && lastDetails) {
		const apogee = lastDetails.apogeeKm ?? 'unknown';
		const perigee = lastDetails.perigeeKm ?? 'unknown';
		return `Selected object ${lastDetails.objectName} (${lastDetails.noradCatId}) has apogee ${apogee} km and perigee ${perigee} km. No scene change was applied.`;
	}
	return 'I could not complete that request reliably. Please rephrase with either a filter request or a count question.';
}

export async function runAssist(body: AssistRequestBody): Promise<AssistResponse> {
	const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
	const model = env.OPENAI_ASSIST_MODEL || 'gpt-5-mini';
	const sceneContext = normalizeSceneContext(body.sceneContext);
	const intent = inferUserIntent(body.messages);
	const latestUserMessage = getLatestUserMessage(body.messages);
	const analyticalKind = inferAnalyticalKind(latestUserMessage);

	let previousResponseId = body.previousResponseId ?? null;
	let input:
		| EasyInputMessage[]
		| Array<{ type: 'function_call_output'; call_id: string; output: string }> = buildInitialInput(
		body.messages
	);
	let lastQueryResult: CatalogQueryResult | null = null;
	let lastDetails: ObjectDetails | null = null;
	let finalResponse: Response | null = null;
	let usedHeuristicCountResult = false;

	for (let step = 0; step < MAX_TOOL_STEPS; step++) {
		const requestArgs = {
			model,
			instructions:
				SYSTEM_PROMPT +
				`\nIntent: ${intent}.` +
				`\nScene context: ${JSON.stringify(sceneContext)}.`,
			input,
			tools: ASSIST_TOOLS,
			tool_choice: buildInitialToolChoice(
				step,
				intent,
				analyticalKind,
				sceneContext.selectedNoradId
			),
			previous_response_id: previousResponseId ?? undefined
		};

		let response: Response;
		try {
			response = await openai.responses.create(requestArgs);
		} catch (error) {
			if (previousResponseId && shouldRetryWithoutPreviousResponse(error)) {
				previousResponseId = null;
				response = await openai.responses.create({
					...requestArgs,
					previous_response_id: undefined
				});
			} else {
				throw error;
			}
		}

		finalResponse = response;
		const toolCalls = extractToolCalls(response);
		if (toolCalls.length === 0) {
			break;
		}

		const toolOutputs: Array<{ type: 'function_call_output'; call_id: string; output: string }> =
			[];

		for (const call of toolCalls) {
			if (call.name === 'scene_context') {
				toolOutputs.push({
					type: 'function_call_output',
					call_id: call.call_id,
					output: JSON.stringify(sceneContext)
				});
				continue;
			}

			if (call.name === 'execute_catalog_query') {
				const parsed = parseJson(call.arguments);
				try {
					const queryResult = runCatalogQuery(parsed);
					lastQueryResult = queryResult;
					toolOutputs.push({
						type: 'function_call_output',
						call_id: call.call_id,
						output: JSON.stringify(queryResult)
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : 'query failed';
					toolOutputs.push({
						type: 'function_call_output',
						call_id: call.call_id,
						output: JSON.stringify({ code: 'QUERY_ERROR', error: message })
					});
				}
				continue;
			}

			if (call.name === 'get_object_details') {
				const parsed = parseJson(call.arguments) as Record<string, unknown> | null;
				const noradCandidate = parsed?.norad_cat_id;
				try {
					const noradId = Number(noradCandidate);
					const details = getObjectDetails(noradId);
					lastDetails = details;
					toolOutputs.push({
						type: 'function_call_output',
						call_id: call.call_id,
						output: JSON.stringify(details ?? { code: 'NOT_FOUND', norad_cat_id: noradId })
					});
				} catch (error) {
					const message = error instanceof Error ? error.message : 'details lookup failed';
					toolOutputs.push({
						type: 'function_call_output',
						call_id: call.call_id,
						output: JSON.stringify({ code: 'DETAILS_ERROR', error: message })
					});
				}
				continue;
			}

			toolOutputs.push({
				type: 'function_call_output',
				call_id: call.call_id,
				output: JSON.stringify({ code: 'UNKNOWN_TOOL', name: call.name })
			});
		}

		input = toolOutputs;
		previousResponseId = response.id;
	}

	if (intent === 'analytical' && analyticalKind === 'count') {
		const heuristicSpec = buildHeuristicCountSpec(latestUserMessage);
		if (heuristicSpec) {
			try {
				const heuristicResult = runCatalogQuery(heuristicSpec);
				if (!lastQueryResult || lastQueryResult.totalCount === 0) {
					lastQueryResult = heuristicResult;
					usedHeuristicCountResult = true;
				}
			} catch {
				// Ignore heuristic fallback errors and continue to final fallback messaging.
			}
		}
	}
	if (
		intent === 'analytical' &&
		analyticalKind === 'explain' &&
		!lastDetails &&
		sceneContext.selectedNoradId !== null
	) {
		try {
			lastDetails = getObjectDetails(sceneContext.selectedNoradId);
		} catch {
			// Ignore detail fallback errors and continue to final fallback messaging.
		}
	}

	const baseMessage = (finalResponse?.output_text ?? '').trim();
	const needsFallback =
		usedHeuristicCountResult ||
		baseMessage.length < 12 ||
		/applied your request/i.test(baseMessage);
	let assistantMessage = needsFallback
		? buildFallbackMessage(intent, lastQueryResult, lastDetails)
		: baseMessage;

	if (
		intent === 'analytical' &&
		analyticalKind === 'count' &&
		lastQueryResult?.queryType === 'count'
	) {
		assistantMessage = `Count: ${lastQueryResult.totalCount} objects match (${lastQueryResult.filterSummary}). No scene change was applied.`;
	}

	let action: AssistResponse['action'] = null;
	if (intent === 'view_update' && lastQueryResult && lastQueryResult.queryType === 'select') {
		action = {
			mode: lastQueryResult.mode,
			noradCatIds: lastQueryResult.noradCatIds,
			totalCount: lastQueryResult.totalCount,
			returnedCount: lastQueryResult.returnedCount,
			filterSummary: lastQueryResult.filterSummary
		};
	}
	if (intent === 'analytical' && !assistantMessage.includes('No scene change')) {
		assistantMessage = `${assistantMessage}\nNo scene change was applied.`;
	}

	return {
		assistantMessage,
		action,
		responseId: finalResponse?.id ?? null
	};
}
