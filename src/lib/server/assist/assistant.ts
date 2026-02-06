import { OpenAI } from 'openai';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { OPENAI_API_KEY } from '$env/static/private';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { env } from '$env/dynamic/private';
import { getObjectDetails, runCatalogQuery } from './queryRuntime';
import { buildHeuristicQuery, inferViewMode, planAssistTurn } from './planner';
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

function normalizeText(value: string): string {
	return value
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, ' ')
		.trim()
		.replace(/\s+/g, ' ');
}

function getPrimaryObjectNameContainsNeedle(query: CatalogQuerySpec): string | null {
	const candidates = query.filters.filter(
		(filter) =>
			filter.field === 'object_name' &&
			filter.op === 'contains' &&
			typeof filter.value === 'string' &&
			filter.value.trim() !== ''
	);
	if (candidates.length !== 1) {
		return null;
	}
	const normalized = normalizeText(candidates[0].value as string);
	return normalized.length >= 2 ? normalized : null;
}

function messageSuggestsSingleTarget(message: string): boolean {
	const latest = message.toLowerCase();
	if (/\bhow many|count|number of|total\b/.test(latest)) {
		return false;
	}
	if (
		/\ball\b|\bevery\b|\bobjects?\b|\bsatellites?\b|\bpayloads?\b|\bdebris\b|\bfragments?\b|\brocket bodies\b|\brockets?\b|\bboosters?\b/.test(
			latest
		)
	) {
		return false;
	}
	return /\bthe\b|\bthis\b|\bthat\b|\bit\b|\bselected\b|\bspecific\b|\bexact\b/.test(latest);
}

function expectsSingleTarget(message: string, query: CatalogQuerySpec): boolean {
	if (query.queryType !== 'select') {
		return false;
	}
	if (typeof query.limit === 'number' && query.limit <= 1) {
		return true;
	}
	if (messageSuggestsSingleTarget(message)) {
		return true;
	}
	const primaryNeedle = getPrimaryObjectNameContainsNeedle(query);
	return primaryNeedle !== null && !primaryNeedle.includes(' ') && primaryNeedle.length <= 6;
}

function isStrongNameMatch(objectName: string, normalizedNeedle: string): boolean {
	const normalizedName = normalizeText(objectName);
	return normalizedName === normalizedNeedle || normalizedName.startsWith(`${normalizedNeedle} `);
}

function hasConfidentSingleMatch(result: CatalogQueryResult, normalizedNeedle: string): boolean {
	if (result.noradCatIds.length === 0) {
		return false;
	}
	const selectedNoradId = result.noradCatIds[0];
	const strongMatches = result.sample.filter((row) =>
		isStrongNameMatch(row.objectName, normalizedNeedle)
	);
	return strongMatches.length === 1 && strongMatches[0].noradCatId === selectedNoradId;
}

function buildAmbiguousSingleTargetMessage(result: CatalogQueryResult): string {
	const preview = result.sample
		.slice(0, 5)
		.map((row) => `${row.objectName} (${row.noradCatId})`)
		.join(', ');
	const lines = [
		`I found ${result.totalCount} matches for what looks like a single-object request, so I did not change the scene.`,
		`Current filter: ${result.filterSummary}.`
	];
	if (preview.length > 0) {
		lines.push(`Closest matches: ${preview}.`);
	}
	lines.push('Please provide a more specific object name or a NORAD ID.');
	lines.push('No scene change was applied.');
	return lines.join('\n');
}

function inferSelectLimit({
	latestUserMessage,
	plannedLimit
}: {
	latestUserMessage: string;
	plannedLimit: unknown;
}): number | undefined {
	if (typeof plannedLimit === 'number' && Number.isFinite(plannedLimit)) {
		return Math.max(1, Math.floor(plannedLimit));
	}
	if (messageSuggestsSingleTarget(latestUserMessage)) {
		return 1;
	}
	return undefined;
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
	const plannedMode =
		kind === 'view_update'
			? plannedQuery?.mode === 'add' || plannedQuery?.mode === 'remove'
				? plannedQuery.mode
				: plannedQuery?.mode === 'replace'
					? 'replace'
					: defaultMode
			: 'replace';
	const resolvedLimit =
		kind === 'view_update'
			? inferSelectLimit({
					latestUserMessage,
					plannedLimit: plannedQuery?.limit
				})
			: undefined;

	if (!plannedQuery || !Array.isArray(plannedQuery.filters)) {
		const heuristic = buildHeuristicQuery(latestUserMessage, expectedQueryType, defaultMode);
		return kind === 'view_update'
			? {
					...heuristic,
					mode: plannedMode,
					limit: resolvedLimit
				}
			: heuristic;
	}

	return {
		queryType: expectedQueryType,
		mode: plannedMode,
		limit: resolvedLimit,
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
	const latestUserMessage = getLatestUserMessage(body.messages);
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

	const executableQuery = coerceExecutableQuery({
		kind: plan.kind,
		latestUserMessage,
		plannedQuery: plan.query
	});
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

	let disambiguationPrefix: string | null = null;
	const singleTargetExpected = expectsSingleTarget(latestUserMessage, executableQuery);
	if (singleTargetExpected && queryResult.totalCount === 0) {
		logger.info('assist scene action blocked: no matches for single-target request');
		return {
			assistantMessage:
				'I could not find a unique object for that single-target request.\nNo scene change was applied.',
			action: null
		};
	}
	if (singleTargetExpected && queryResult.totalCount > 1) {
		const primaryNeedle = getPrimaryObjectNameContainsNeedle(executableQuery);
		const confidentMatch =
			primaryNeedle !== null && hasConfidentSingleMatch(queryResult, primaryNeedle);
		if (!confidentMatch) {
			logger.warn('assist scene action blocked: ambiguous single-target request', {
				totalCount: queryResult.totalCount,
				filterSummary: queryResult.filterSummary
			});
			return {
				assistantMessage: buildAmbiguousSingleTargetMessage(queryResult),
				action: null
			};
		}
		const selected = queryResult.sample.find(
			(row) => row.noradCatId === queryResult.noradCatIds[0]
		);
		if (selected) {
			disambiguationPrefix = `Interpreted your request as ${selected.objectName} (${selected.noradCatId}) from ${queryResult.totalCount} partial matches.`;
		}
		logger.info('assist single-target request auto-disambiguated', {
			totalCount: queryResult.totalCount,
			selectedNoradId: queryResult.noradCatIds[0]
		});
	}

	logger.info('assist execution finished with scene action', {
		mode: queryResult.mode,
		returnedCount: queryResult.returnedCount
	});
	const viewUpdateMessage = buildViewUpdateMessage(queryResult);
	return {
		assistantMessage:
			disambiguationPrefix === null
				? viewUpdateMessage
				: `${disambiguationPrefix}\n${viewUpdateMessage}`,
		action: {
			mode: queryResult.mode,
			noradCatIds: queryResult.noradCatIds,
			totalCount: queryResult.totalCount,
			returnedCount: queryResult.returnedCount,
			filterSummary: queryResult.filterSummary
		}
	};
}
