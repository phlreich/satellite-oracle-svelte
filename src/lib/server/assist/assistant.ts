import Database from 'better-sqlite3';
import path from 'path';
import { OpenAI } from 'openai';
import type {
	EasyInputMessage,
	FunctionTool,
	Response
} from 'openai/resources/responses/responses';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { OPENAI_API_KEY } from '$env/static/private';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { env } from '$env/dynamic/private';
import { createLogger, serializeError } from '$lib/server/logger';
import type {
	AssistFocusAction,
	AssistRequestBody,
	AssistResponse,
	AssistSceneAction,
	AssistSelectionMode,
	SceneContext
} from './types';

const DB_PATH = path.join(process.cwd(), 'src/data/satellite.db');
const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');

const MAX_TOOL_ROUNDS = 8;
const DEFAULT_PREVIEW_ROWS = 30;
const DEFAULT_SAMPLE_ROWS = 20;
const MAX_PREVIEW_ROWS = 80;
const MAX_SAMPLE_ROWS = 40;
const MAX_HISTORY_MESSAGES = 30;

const SQL_SELECT_TOOL: FunctionTool = {
	type: 'function',
	name: 'sql_select',
	description:
		'Execute one read-only SELECT query against SQLite. Returns row count, columns, preview rows, random sample rows, and a result_ref.',
	strict: false,
	parameters: {
		type: 'object',
		properties: {
			sql: { type: 'string' },
			preview_rows: { type: 'number' },
			sample_rows: { type: 'number' }
		},
		required: ['sql'],
		additionalProperties: false
	}
};

const SET_VISIBILITY_FROM_RESULT_TOOL: FunctionTool = {
	type: 'function',
	name: 'set_visibility_from_result',
	description:
		'Set scene visibility using NORAD IDs from a prior sql_select result_ref and an ID column.',
	strict: false,
	parameters: {
		type: 'object',
		properties: {
			result_ref: { type: 'string' },
			mode: { type: 'string', enum: ['replace', 'add', 'remove'] },
			id_column: { type: 'string' }
		},
		required: ['result_ref', 'mode'],
		additionalProperties: false
	}
};

const SET_VISIBILITY_TOOL: FunctionTool = {
	type: 'function',
	name: 'set_visibility',
	description: 'Set scene visibility directly from an explicit list of NORAD IDs.',
	strict: false,
	parameters: {
		type: 'object',
		properties: {
			mode: { type: 'string', enum: ['replace', 'add', 'remove'] },
			norad_ids: {
				type: 'array',
				items: { type: 'number' }
			}
		},
		required: ['mode', 'norad_ids'],
		additionalProperties: false
	}
};

const SET_FOCUS_TOOL: FunctionTool = {
	type: 'function',
	name: 'set_focus',
	description: 'Set camera focus to Earth or one NORAD object.',
	strict: false,
	parameters: {
		type: 'object',
		properties: {
			target: { type: 'string', enum: ['earth', 'norad'] },
			norad_id: { type: 'number' }
		},
		required: ['target'],
		additionalProperties: false
	}
};

const ASSIST_TOOLS: FunctionTool[] = [
	SQL_SELECT_TOOL,
	SET_VISIBILITY_FROM_RESULT_TOOL,
	SET_VISIBILITY_TOOL,
	SET_FOCUS_TOOL
];

type QueryResultStore = {
	rows: Record<string, unknown>[];
	columns: string[];
};

let cachedDatabaseContext: string | null = null;

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== 'number' || !Number.isFinite(value)) {
		return fallback;
	}
	return Math.min(max, Math.max(min, Math.floor(value)));
}

function sanitizeScalar(value: unknown): string | number | boolean | null {
	if (value === null || typeof value === 'number' || typeof value === 'boolean') {
		return value;
	}
	if (typeof value === 'string') {
		const trimmed = value.trim();
		if (trimmed.length <= 120) {
			return trimmed;
		}
		return `${trimmed.slice(0, 117)}...`;
	}
	return String(value);
}

function sanitizeRowsForModel(rows: Record<string, unknown>[]) {
	return rows.map((row) => {
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(row)) {
			out[key] = sanitizeScalar(value);
		}
		return out;
	});
}

function randomSampleRows(
	rows: Record<string, unknown>[],
	sampleCount: number
): Record<string, unknown>[] {
	if (sampleCount <= 0 || rows.length === 0) {
		return [];
	}
	if (rows.length <= sampleCount) {
		return rows;
	}
	const selectedIndices = new Set<number>();
	while (selectedIndices.size < sampleCount) {
		selectedIndices.add(Math.floor(Math.random() * rows.length));
	}
	return [...selectedIndices].map((index) => rows[index]);
}

function parseToolArgs(text: string): Record<string, unknown> {
	try {
		const parsed = JSON.parse(text);
		if (typeof parsed === 'object' && parsed !== null) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		// ignore
	}
	return {};
}

function normalizeMode(value: unknown): AssistSelectionMode | null {
	if (value === 'replace' || value === 'add' || value === 'remove') {
		return value;
	}
	return null;
}

function normalizeSelectSql(rawSql: unknown): string | null {
	if (typeof rawSql !== 'string') {
		return null;
	}
	const sql = rawSql.trim().replace(/;+\s*$/, '');
	if (sql.length === 0) {
		return null;
	}
	if (sql.includes(';')) {
		return null;
	}
	if (!/^(select|with)\b/i.test(sql)) {
		return null;
	}
	if (
		/\b(insert|update|delete|drop|alter|create|replace|pragma|attach|detach|vacuum|reindex|analyze|begin|commit|rollback)\b/i.test(
			sql
		)
	) {
		return null;
	}
	return sql;
}

function normalizeNoradIds(values: unknown): number[] {
	if (!Array.isArray(values)) {
		return [];
	}
	const ids: number[] = [];
	const seen = new Set<number>();
	for (const item of values) {
		if (typeof item !== 'number' || !Number.isFinite(item)) {
			continue;
		}
		const id = Math.floor(item);
		if (id <= 0 || seen.has(id)) {
			continue;
		}
		seen.add(id);
		ids.push(id);
	}
	return ids;
}

function normalizeSceneContext(sceneContext?: SceneContext) {
	const selectedNoradId =
		typeof sceneContext?.selectedNoradId === 'number' &&
		Number.isInteger(sceneContext.selectedNoradId)
			? sceneContext.selectedNoradId
			: null;
	const visibleCount =
		typeof sceneContext?.visibleCount === 'number' && Number.isFinite(sceneContext.visibleCount)
			? Math.max(0, Math.floor(sceneContext.visibleCount))
			: 0;
	const selectedInfoPanel =
		typeof sceneContext?.selectedInfoPanel === 'string' &&
		sceneContext.selectedInfoPanel.trim() !== ''
			? sceneContext.selectedInfoPanel.trim().slice(0, 600)
			: 'none';

	return {
		selectedNoradId,
		visibleCount,
		selectedInfoPanel
	};
}

function buildPlannerInput(body: AssistRequestBody): EasyInputMessage[] {
	const messages = body.messages
		.filter((message) => typeof message.content === 'string' && message.content.trim() !== '')
		.slice(-MAX_HISTORY_MESSAGES)
		.map((message) => ({
			role: message.role,
			content: message.content.trim()
		}));

	if (messages.length > 0) {
		return messages as EasyInputMessage[];
	}

	return [
		{
			role: 'user',
			content: 'Show currently visible objects.'
		}
	] as EasyInputMessage[];
}

function toTextSummary(rows: Record<string, unknown>[]): string {
	if (rows.length === 0) {
		return '[]';
	}
	return JSON.stringify(sanitizeRowsForModel(rows));
}

function buildDatabaseContext() {
	if (cachedDatabaseContext) {
		return cachedDatabaseContext;
	}

	const tableRows = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
		)
		.all() as Array<{ name: string }>;

	const previewQueries: Record<string, string> = {
		gp: 'SELECT NORAD_CAT_ID, OBJECT_NAME, OBJECT_TYPE, COUNTRY_CODE, LAUNCH_DATE, APOAPSIS, PERIAPSIS, PERIOD FROM gp LIMIT 5',
		satcat:
			'SELECT NORAD_CAT_ID, OBJECT_NAME, OBJECT_TYPE, COUNTRY, LAUNCH, SITE, APOGEE, PERIGEE FROM satcat LIMIT 5',
		boxscore:
			'SELECT COUNTRY, ORBITAL_TOTAL_COUNT, ORBITAL_PAYLOAD_COUNT, ORBITAL_DEBRIS_COUNT, COUNTRY_TOTAL FROM boxscore ORDER BY COUNTRY_TOTAL DESC LIMIT 5'
	};

	const parts = ['Database snapshot:'];
	for (const table of tableRows) {
		const tableName = table.name;
		const rowCount = db.prepare(`SELECT COUNT(*) as count FROM ${tableName}`).get() as {
			count: number;
		};
		const columns = db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
			name: string;
			type: string;
		}>;
		const previewSql = previewQueries[tableName] ?? `SELECT * FROM ${tableName} LIMIT 3`;
		const previewRows = db.prepare(previewSql).all() as Record<string, unknown>[];

		parts.push(`- table ${tableName} (${rowCount.count} rows)`);
		parts.push(
			`  columns: ${columns.map((col) => `${col.name}${col.type ? ` ${col.type}` : ''}`).join(', ')}`
		);
		parts.push(`  preview: ${toTextSummary(previewRows)}`);
	}

	cachedDatabaseContext = parts.join('\n');
	return cachedDatabaseContext;
}

function buildInstructions(sceneContext: ReturnType<typeof normalizeSceneContext>): string {
	return [
		'You are the Satellite Oracle assistant.',
		'Use tools aggressively to inspect data and update the scene in one turn when useful.',
		'You can run only read-only SQL through sql_select. Use sql_select for analysis before acting.',
		'For large result sets, use set_visibility_from_result instead of manually listing IDs.',
		"When the user asks to focus an object, call set_focus with target='norad' and norad_id.",
		"When the user asks to focus Earth, call set_focus with target='earth'.",
		'You may call multiple tools before your final answer.',
		'Keep the final answer concise and explicit about scene changes applied.',
		`Scene context: ${JSON.stringify(sceneContext)}.`,
		buildDatabaseContext()
	].join('\n');
}

function summarizeTools(tools: FunctionTool[]) {
	return tools.map((tool) => tool.name);
}

function serializeResponseOutput(response: Response) {
	return response.output.map((item) => {
		if (item.type === 'function_call') {
			return {
				type: item.type,
				name: item.name,
				call_id: item.call_id,
				arguments: item.arguments
			};
		}
		if (item.type === 'message') {
			return {
				type: item.type,
				role: item.role,
				content: item.content
			};
		}
		return item;
	});
}

function resolveCaseInsensitiveColumn(row: Record<string, unknown>, wanted: string): string | null {
	const match = Object.keys(row).find((key) => key.toLowerCase() === wanted.toLowerCase());
	return match ?? null;
}

function extractNoradIdsFromRows({
	rows,
	idColumn
}: {
	rows: Record<string, unknown>[];
	idColumn?: string;
}): { ids: number[]; resolvedColumn: string | null } {
	if (rows.length === 0) {
		return { ids: [], resolvedColumn: null };
	}
	let resolvedColumn: string | null = null;
	if (idColumn && idColumn.trim() !== '') {
		resolvedColumn = resolveCaseInsensitiveColumn(rows[0], idColumn.trim());
	}
	if (!resolvedColumn) {
		for (const candidate of ['NORAD_CAT_ID', 'norad_cat_id', 'norad_id', 'noradId']) {
			const maybe = resolveCaseInsensitiveColumn(rows[0], candidate);
			if (maybe) {
				resolvedColumn = maybe;
				break;
			}
		}
	}
	if (!resolvedColumn) {
		return { ids: [], resolvedColumn: null };
	}
	const ids: number[] = [];
	const seen = new Set<number>();
	for (const row of rows) {
		const raw = row[resolvedColumn];
		const value =
			typeof raw === 'number'
				? raw
				: typeof raw === 'string' && raw.trim() !== '' && Number.isFinite(Number(raw))
					? Number(raw)
					: null;
		if (value === null) {
			continue;
		}
		const id = Math.floor(value);
		if (id <= 0 || seen.has(id)) {
			continue;
		}
		seen.add(id);
		ids.push(id);
	}
	return { ids, resolvedColumn };
}

async function executeToolCall({
	toolName,
	toolArgs,
	queryResults,
	pendingAction,
	logger
}: {
	toolName: string;
	toolArgs: Record<string, unknown>;
	queryResults: Map<string, QueryResultStore>;
	pendingAction: AssistSceneAction;
	logger: ReturnType<typeof createLogger>;
}) {
	logger.info('assist tool execution started', {
		toolName,
		toolArgs
	});

	if (toolName === 'sql_select') {
		const sql = normalizeSelectSql(toolArgs.sql);
		if (!sql) {
			return { ok: false, error: 'sql_select only accepts a single SELECT/CTE SELECT statement.' };
		}
		const previewRows = clampInt(toolArgs.preview_rows, 1, MAX_PREVIEW_ROWS, DEFAULT_PREVIEW_ROWS);
		const sampleRows = clampInt(toolArgs.sample_rows, 0, MAX_SAMPLE_ROWS, DEFAULT_SAMPLE_ROWS);
		try {
			const startedAt = Date.now();
			const stmt = db.prepare(sql);
			if (!stmt.reader) {
				return { ok: false, error: 'Query must return rows.' };
			}
			const rows = stmt.all() as Record<string, unknown>[];
			const columns = stmt.columns().map((column) => column.name);
			const preview = rows.slice(0, previewRows);
			const sample = randomSampleRows(rows, sampleRows);
			const resultRef = `result_${Date.now()}_${Math.floor(Math.random() * 1_000_000)}`;
			queryResults.set(resultRef, { rows, columns });
			logger.info('sql_select executed', {
				sql,
				previewRowsRequested: previewRows,
				sampleRowsRequested: sampleRows,
				rows: rows.length,
				columns: columns.length,
				resultRef,
				durationMs: Date.now() - startedAt
			});
			return {
				ok: true,
				result_ref: resultRef,
				row_count: rows.length,
				columns,
				preview_rows: sanitizeRowsForModel(preview),
				sample_rows: sanitizeRowsForModel(sample),
				truncated: rows.length > preview.length
			};
		} catch (error) {
			logger.warn('sql_select failed', { error: serializeError(error) });
			return {
				ok: false,
				error: error instanceof Error ? error.message : 'SQL execution failed.'
			};
		}
	}

	if (toolName === 'set_visibility_from_result') {
		const resultRef =
			typeof toolArgs.result_ref === 'string' && toolArgs.result_ref.trim() !== ''
				? toolArgs.result_ref.trim()
				: null;
		const mode = normalizeMode(toolArgs.mode);
		if (!resultRef || !mode) {
			return { ok: false, error: 'set_visibility_from_result requires result_ref and valid mode.' };
		}
		const storedResult = queryResults.get(resultRef);
		if (!storedResult) {
			return { ok: false, error: `Unknown result_ref '${resultRef}'.` };
		}
		const idColumn = typeof toolArgs.id_column === 'string' ? toolArgs.id_column : undefined;
		const extraction = extractNoradIdsFromRows({ rows: storedResult.rows, idColumn });
		if (extraction.ids.length === 0) {
			return {
				ok: false,
				error:
					'Could not extract NORAD IDs from result rows. Provide id_column (e.g. NORAD_CAT_ID).',
				available_columns: storedResult.columns
			};
		}
		pendingAction.visibility = {
			mode,
			noradCatIds: extraction.ids,
			returnedCount: extraction.ids.length
		};
		logger.info('visibility action prepared from result', {
			mode,
			returnedCount: extraction.ids.length,
			resolvedColumn: extraction.resolvedColumn,
			noradCatIds: extraction.ids
		});
		return {
			ok: true,
			mode,
			returned_count: extraction.ids.length,
			id_column: extraction.resolvedColumn
		};
	}

	if (toolName === 'set_visibility') {
		const mode = normalizeMode(toolArgs.mode);
		const noradIds = normalizeNoradIds(toolArgs.norad_ids);
		if (!mode || noradIds.length === 0) {
			return { ok: false, error: 'set_visibility requires mode and at least one valid NORAD ID.' };
		}
		pendingAction.visibility = {
			mode,
			noradCatIds: noradIds,
			returnedCount: noradIds.length
		};
		logger.info('visibility action prepared', { mode, returnedCount: noradIds.length });
		logger.info('visibility IDs prepared', { noradCatIds: noradIds });
		return { ok: true, mode, returned_count: noradIds.length };
	}

	if (toolName === 'set_focus') {
		const target = toolArgs.target;
		let focus: AssistFocusAction | null = null;
		if (target === 'earth') {
			focus = { target: 'earth' };
		}
		if (target === 'norad') {
			const rawNorad = toolArgs.norad_id;
			const noradId =
				typeof rawNorad === 'number' && Number.isFinite(rawNorad) ? Math.floor(rawNorad) : null;
			if (!noradId || noradId <= 0) {
				return { ok: false, error: 'set_focus target=norad requires a positive norad_id.' };
			}
			focus = { target: 'norad', noradCatId: noradId };
		}
		if (!focus) {
			return { ok: false, error: "set_focus target must be 'earth' or 'norad'." };
		}
		pendingAction.focus = focus;
		logger.info('focus action prepared', focus);
		return { ok: true, focus };
	}

	return { ok: false, error: `Unknown tool '${toolName}'.` };
}

function buildFallbackMessage(action: AssistSceneAction): string {
	if (!action.visibility && !action.focus) {
		return 'I could not complete that request. Please restate what you want to query or change.';
	}
	const parts: string[] = [];
	if (action.visibility) {
		parts.push(
			`Applied visibility mode ${action.visibility.mode} to ${action.visibility.returnedCount} objects.`
		);
	}
	if (action.focus) {
		parts.push(
			action.focus.target === 'earth'
				? 'Focused on Earth.'
				: `Focused on NORAD ${action.focus.noradCatId}.`
		);
	}
	return parts.join(' ');
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
	const input = buildPlannerInput(body);
	const instructions = buildInstructions(sceneContext);
	const queryResults = new Map<string, QueryResultStore>();
	const action: AssistSceneAction = {};

	logger.info('assist tool loop started', {
		messageCount: input.length,
		selectedNoradId: sceneContext.selectedNoradId,
		visibleCount: sceneContext.visibleCount,
		messages: body.messages,
		sceneContext,
		input,
		instructions
	});

	let response: Response;
	const initialRequest = {
		model,
		instructions,
		input,
		tools: ASSIST_TOOLS
	};
	logger.info('openai responses.create request', {
		step: 'initial',
		payload: {
			...initialRequest,
			tools: summarizeTools(ASSIST_TOOLS)
		}
	});
	try {
		response = await openai.responses.create(initialRequest);
	} catch (error) {
		logger.error('assist initial response failed', { error: serializeError(error) });
		throw error;
	}
	logger.info('openai responses.create response', {
		step: 'initial',
		responseId: response.id ?? null,
		outputText: response.output_text ?? '',
		output: serializeResponseOutput(response)
	});

	for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
		const functionCalls = response.output.filter((item) => item.type === 'function_call');
		if (functionCalls.length === 0) {
			break;
		}

		logger.info('assist executing tool round', {
			round,
			toolCalls: functionCalls.length,
			functionCalls: functionCalls.map((call) => ({
				name: call.name,
				callId: call.call_id,
				arguments: call.arguments
			}))
		});

		const toolOutputs = [] as Array<{
			type: 'function_call_output';
			call_id: string;
			output: string;
		}>;

		for (const call of functionCalls) {
			const args = parseToolArgs(call.arguments);
			logger.info('assist tool call received', {
				round,
				toolName: call.name,
				callId: call.call_id,
				argumentsRaw: call.arguments,
				argumentsParsed: args
			});
			const output = await executeToolCall({
				toolName: call.name,
				toolArgs: args,
				queryResults,
				pendingAction: action,
				logger
			});
			logger.info('assist tool call output', {
				round,
				toolName: call.name,
				callId: call.call_id,
				output
			});
			toolOutputs.push({
				type: 'function_call_output',
				call_id: call.call_id,
				output: JSON.stringify(output)
			});
		}

		const followupRequest = {
			model,
			previous_response_id: response.id,
			input: toolOutputs,
			tools: ASSIST_TOOLS
		};
		logger.info('openai responses.create request', {
			step: 'followup',
			round,
			payload: {
				...followupRequest,
				tools: summarizeTools(ASSIST_TOOLS)
			}
		});
		try {
			response = await openai.responses.create(followupRequest);
		} catch (error) {
			logger.error('assist tool round failed', { error: serializeError(error), round });
			throw error;
		}
		logger.info('openai responses.create response', {
			step: 'followup',
			round,
			responseId: response.id ?? null,
			outputText: response.output_text ?? '',
			output: serializeResponseOutput(response)
		});
	}

	const hasSceneAction = Boolean(action.visibility || action.focus);
	const assistantMessage =
		typeof response.output_text === 'string' && response.output_text.trim() !== ''
			? response.output_text.trim()
			: buildFallbackMessage(action);

	logger.info('assist tool loop completed', {
		hasVisibilityAction: Boolean(action.visibility),
		hasFocusAction: Boolean(action.focus),
		visibilityCount: action.visibility?.returnedCount ?? null,
		action,
		assistantMessage
	});

	return {
		assistantMessage,
		action: hasSceneAction ? action : null
	};
}
