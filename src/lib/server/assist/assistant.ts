import { OpenAI } from 'openai';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { OPENAI_API_KEY } from '$env/static/private';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { env } from '$env/dynamic/private';
import { getObjectDetails, runCatalogQuery } from './queryRuntime';
import { buildHeuristicQuery, inferViewMode, planAssistTurn } from './planner';
import type {
	AssistRequestBody,
	AssistResponse,
	CatalogFacetBucket,
	CatalogQueryResult,
	CatalogQuerySpec,
	ObjectDetails,
	SceneContext
} from './types';

function getLatestUserMessage(messages: AssistRequestBody['messages']): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		if (messages[i].role === 'user') {
			return messages[i].content;
		}
	}
	return '';
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

function topFacetSummary(label: string, buckets: CatalogFacetBucket[], limit = 3): string | null {
	const top = buckets
		.filter(
			(bucket) => bucket.value.trim() !== '' && bucket.value.trim().toLowerCase() !== 'unknown'
		)
		.slice(0, limit)
		.map((bucket) => `${bucket.value} (${bucket.count})`);
	if (top.length === 0) {
		return null;
	}
	return `${label}: ${top.join(', ')}`;
}

function buildCountMessage(result: CatalogQueryResult): string {
	const parts = [`Count: ${result.totalCount} objects match (${result.filterSummary}).`];
	const objectTypeSummary = topFacetSummary('Top object types', result.facets.objectType);
	const countrySummary = topFacetSummary('Top countries', result.facets.countryCode);
	const orbitSummary = topFacetSummary('Top orbit classes', result.facets.orbitClass);
	if (objectTypeSummary) {
		parts.push(objectTypeSummary);
	}
	if (countrySummary) {
		parts.push(countrySummary);
	}
	if (orbitSummary) {
		parts.push(orbitSummary);
	}
	parts.push('No scene change was applied.');
	return parts.join('\n');
}

function buildViewUpdateMessage(result: CatalogQueryResult): string {
	const capped =
		result.returnedCount < result.totalCount
			? `Returned ${result.returnedCount} of ${result.totalCount} matches due to limit.`
			: `Returned all ${result.totalCount} matches.`;
	const orbitSummary = topFacetSummary('Orbit classes in result', result.facets.orbitClass);
	const parts = [
		`Applied filter (${result.filterSummary}).`,
		capped,
		`Scene mode: ${result.mode}.`
	];
	if (orbitSummary) {
		parts.push(orbitSummary);
	}
	return parts.join('\n');
}

function buildExplainMessage(details: ObjectDetails): string {
	const apogee = details.apogeeKm !== null ? `${details.apogeeKm.toFixed(1)} km` : 'unknown';
	const perigee = details.perigeeKm !== null ? `${details.perigeeKm.toFixed(1)} km` : 'unknown';
	const period =
		details.periodMinutes !== null ? `${details.periodMinutes.toFixed(2)} min` : 'unknown';
	const inclination =
		details.inclinationDeg !== null ? `${details.inclinationDeg.toFixed(3)}°` : 'unknown';

	const parts = [
		`Selected object: ${details.objectName} (${details.noradCatId}).`,
		`Orbit profile: class ${details.orbitClass}, apogee ${apogee}, perigee ${perigee}, period ${period}, inclination ${inclination}.`
	];

	if (details.orbitClass === 'GEO') {
		parts.push(
			'This orbit is high because geostationary missions trade launch cost for constant Earth coverage and near-fixed ground position.'
		);
	} else if (details.orbitClass === 'HEO') {
		parts.push(
			'This orbit is high because highly elliptical/high-earth trajectories prioritize long dwell times, transfer geometry, or special mission coverage.'
		);
	} else if (details.orbitClass === 'MEO') {
		parts.push(
			'This orbit is higher than LEO because MEO missions prioritize wide-area coverage and longer orbital periods (e.g., navigation constellations).'
		);
	} else {
		parts.push(
			'Even in LEO, altitude is a drag/lifetime tradeoff: higher means less drag and fewer reboosts, lower means easier access and lower radiation.'
		);
	}

	parts.push('No scene change was applied.');
	return parts.join('\n');
}

function coerceExecutableQuery({
	kind,
	latestUserMessage,
	plannedQuery
}: {
	kind: 'count' | 'view_update';
	latestUserMessage: string;
	plannedQuery?: CatalogQuerySpec;
}): CatalogQuerySpec {
	const defaultMode = inferViewMode(latestUserMessage);
	const expectedQueryType = kind === 'count' ? 'count' : 'select';

	if (!plannedQuery || !Array.isArray(plannedQuery.filters)) {
		return buildHeuristicQuery(latestUserMessage, expectedQueryType, defaultMode);
	}

	return {
		queryType: expectedQueryType,
		mode:
			kind === 'view_update'
				? plannedQuery.mode === 'add' || plannedQuery.mode === 'remove'
					? plannedQuery.mode
					: plannedQuery.mode === 'replace'
						? 'replace'
						: defaultMode
				: 'replace',
		limit:
			kind === 'view_update'
				? typeof plannedQuery.limit === 'number' && Number.isFinite(plannedQuery.limit)
					? Math.floor(plannedQuery.limit)
					: 2500
				: undefined,
		filters: plannedQuery.filters
	};
}

export async function runAssist(body: AssistRequestBody): Promise<AssistResponse> {
	const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
	const model = env.OPENAI_ASSIST_MODEL || 'gpt-5-mini';
	const sceneContext = normalizeSceneContext(body.sceneContext);
	const latestUserMessage = getLatestUserMessage(body.messages);

	const planResult = await planAssistTurn({ openai, model, body });
	const plan = planResult.plan;

	if (plan.kind === 'clarify') {
		return {
			assistantMessage: plan.question ?? 'Could you clarify what you want me to filter or count?',
			action: null,
			responseId: planResult.responseId
		};
	}

	if (plan.kind === 'explain_selected') {
		if (sceneContext.selectedNoradId === null) {
			return {
				assistantMessage:
					'I do not see a selected object. Select a satellite in the scene (or provide a NORAD ID), and I can explain its orbit.\nNo scene change was applied.',
				action: null,
				responseId: planResult.responseId
			};
		}
		const details = getObjectDetails(sceneContext.selectedNoradId);
		if (!details) {
			return {
				assistantMessage:
					'I could not find details for the selected object. Try selecting another satellite.\nNo scene change was applied.',
				action: null,
				responseId: planResult.responseId
			};
		}
		return {
			assistantMessage: buildExplainMessage(details),
			action: null,
			responseId: planResult.responseId
		};
	}

	const executableQuery = coerceExecutableQuery({
		kind: plan.kind,
		latestUserMessage,
		plannedQuery: plan.query
	});

	let queryResult: CatalogQueryResult;
	try {
		queryResult = runCatalogQuery(executableQuery);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'query failed';
		return {
			assistantMessage: `I could not execute that query (${message}). Please rephrase with concrete filters.\nNo scene change was applied.`,
			action: null,
			responseId: planResult.responseId
		};
	}

	if (plan.kind === 'count') {
		return {
			assistantMessage: buildCountMessage(queryResult),
			action: null,
			responseId: planResult.responseId
		};
	}

	return {
		assistantMessage: buildViewUpdateMessage(queryResult),
		action: {
			mode: queryResult.mode,
			noradCatIds: queryResult.noradCatIds,
			totalCount: queryResult.totalCount,
			returnedCount: queryResult.returnedCount,
			filterSummary: queryResult.filterSummary
		},
		responseId: planResult.responseId
	};
}
