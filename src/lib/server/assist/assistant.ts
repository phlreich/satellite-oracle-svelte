import { OpenAI } from 'openai';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { OPENAI_API_KEY } from '$env/static/private';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { env } from '$env/dynamic/private';
import { getObjectDetails, runCatalogQuery } from './queryRuntime';
import { planAssistTurn } from './planner';
import { createLogger, serializeError } from '$lib/server/logger';
import type {
	AssistRequestBody,
	AssistResponse,
	CatalogFacetBucket,
	CatalogQueryResult,
	CatalogQuerySpec,
	ObjectDetails,
	SceneContext
} from './types';

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

function buildPlannerSingleTargetConflictMessage(result: CatalogQueryResult): string {
	const preview = result.sample
		.slice(0, 5)
		.map((row) => `${row.objectName} (${row.noradCatId})`)
		.join(', ');
	if (result.totalCount === 0) {
		return 'Planner requested one object (limit=1), but the query matched none.\nNo scene change was applied.';
	}
	const lines = [
		`Planner requested one object (limit=1), but the query matched ${result.totalCount}.`,
		`Current filter: ${result.filterSummary}.`
	];
	if (preview.length > 0) {
		lines.push(`Closest matches: ${preview}.`);
	}
	lines.push('Please provide a more specific filter or NORAD ID.');
	lines.push('No scene change was applied.');
	return lines.join('\n');
}

function normalizeLimit(value: unknown): number | undefined {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return undefined;
	}
	return Math.max(1, Math.floor(value));
}

function normalizeExecutableQuery({
	kind,
	plannedQuery
}: {
	kind: 'count' | 'view_update';
	plannedQuery?: CatalogQuerySpec;
}): CatalogQuerySpec | null {
	if (!plannedQuery || !Array.isArray(plannedQuery.filters)) {
		return null;
	}
	const expectedQueryType = kind === 'count' ? 'count' : 'select';
	if (plannedQuery.queryType !== expectedQueryType) {
		return null;
	}
	return {
		queryType: expectedQueryType,
		mode:
			kind === 'view_update' &&
			(plannedQuery.mode === 'add' ||
				plannedQuery.mode === 'remove' ||
				plannedQuery.mode === 'replace')
				? plannedQuery.mode
				: 'replace',
		limit: kind === 'view_update' ? normalizeLimit(plannedQuery.limit) : undefined,
		filters: plannedQuery.filters
	};
}

export async function runAssist(
	body: AssistRequestBody,
	options?: { requestId?: string }
): Promise<AssistResponse> {
	const openai = new OpenAI({ apiKey: OPENAI_API_KEY });
	const model = env.OPENAI_ASSIST_MODEL || 'gpt-5-mini';
	const sceneContext = normalizeSceneContext(body.sceneContext);
	const logger = createLogger('assist.executor', {
		requestId: options?.requestId ?? 'unknown',
		model
	});
	logger.info('assist execution started', {
		messageCount: body.messages.length,
		selectedNoradId: sceneContext.selectedNoradId,
		visibleCount: sceneContext.visibleCount
	});

	const plan = await planAssistTurn({
		openai,
		model,
		body,
		requestId: options?.requestId
	});
	logger.info('assist plan received', {
		kind: plan.kind,
		hasQuery: Boolean(plan.query),
		hasQuestion: Boolean(plan.question)
	});

	if (plan.kind === 'clarify') {
		logger.info('assist execution finished with clarify response');
		return {
			assistantMessage: plan.question ?? 'Could you clarify what you want me to filter or count?',
			action: null
		};
	}

	if (plan.kind === 'explain_selected') {
		if (sceneContext.selectedNoradId === null) {
			logger.info('assist explanation blocked: no selected object');
			return {
				assistantMessage:
					'I do not see a selected object. Select a satellite in the scene (or provide a NORAD ID), and I can explain its orbit.\nNo scene change was applied.',
				action: null
			};
		}
		const details = getObjectDetails(sceneContext.selectedNoradId);
		if (!details) {
			logger.warn('assist explanation failed: selected object not found', {
				selectedNoradId: sceneContext.selectedNoradId
			});
			return {
				assistantMessage:
					'I could not find details for the selected object. Try selecting another satellite.\nNo scene change was applied.',
				action: null
			};
		}
		logger.info('assist explanation generated', {
			selectedNoradId: details.noradCatId,
			orbitClass: details.orbitClass
		});
		return {
			assistantMessage: buildExplainMessage(details),
			action: null
		};
	}

	const executableQuery = normalizeExecutableQuery({
		kind: plan.kind,
		plannedQuery: plan.query
	});
	if (!executableQuery) {
		logger.warn('assist execution blocked: planner did not provide a valid executable query', {
			kind: plan.kind
		});
		return {
			assistantMessage:
				'I could not execute that because no valid structured query was provided. Please restate your request with explicit filters.\nNo scene change was applied.',
			action: null
		};
	}
	logger.info('assist query prepared', {
		kind: plan.kind,
		queryType: executableQuery.queryType,
		mode: executableQuery.mode ?? null,
		filterCount: executableQuery.filters.length
	});

	let queryResult: CatalogQueryResult;
	try {
		queryResult = runCatalogQuery(executableQuery);
	} catch (error) {
		const message = error instanceof Error ? error.message : 'query failed';
		logger.error('assist query execution failed', {
			error: serializeError(error),
			queryType: executableQuery.queryType,
			filterCount: executableQuery.filters.length
		});
		return {
			assistantMessage: `I could not execute that query (${message}). Please rephrase with concrete filters.\nNo scene change was applied.`,
			action: null
		};
	}
	logger.info('assist query execution succeeded', {
		queryType: queryResult.queryType,
		mode: queryResult.mode,
		totalCount: queryResult.totalCount,
		returnedCount: queryResult.returnedCount
	});

	if (plan.kind === 'count') {
		logger.info('assist execution finished with analytical response');
		return {
			assistantMessage: buildCountMessage(queryResult),
			action: null
		};
	}

	if (executableQuery.limit === 1 && queryResult.totalCount !== 1) {
		logger.warn('assist scene action blocked: planner single-target constraint not satisfied', {
			totalCount: queryResult.totalCount,
			filterSummary: queryResult.filterSummary
		});
		return {
			assistantMessage: buildPlannerSingleTargetConflictMessage(queryResult),
			action: null
		};
	}

	logger.info('assist execution finished with scene action', {
		mode: queryResult.mode,
		returnedCount: queryResult.returnedCount
	});
	const viewUpdateMessage = buildViewUpdateMessage(queryResult);
	return {
		assistantMessage: viewUpdateMessage,
		action: {
			mode: queryResult.mode,
			noradCatIds: queryResult.noradCatIds,
			totalCount: queryResult.totalCount,
			returnedCount: queryResult.returnedCount,
			filterSummary: queryResult.filterSummary
		}
	};
}
