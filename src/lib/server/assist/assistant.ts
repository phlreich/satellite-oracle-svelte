import Database from 'better-sqlite3';
import fs from 'node:fs/promises';
import path from 'path';
import { inspect } from 'node:util';
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
import { guardReadOnlySql } from '$lib/server/assist/sqlGuard';
import type {
	AssistFocusAction,
	AssistRequestBody,
	AssistResponse,
	AssistSceneAction,
	AssistSelectionMode,
	SceneContext
} from './types';

const DB_PATH = path.join(process.cwd(), 'src/data/satellite.db');

function openReadDatabase() {
	const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
	db.pragma('busy_timeout = 5000');
	return db;
}

const MAX_TOOL_ROUNDS = 8;
const DEFAULT_PREVIEW_ROWS = 30;
const DEFAULT_SAMPLE_ROWS = 20;
const MAX_PREVIEW_ROWS = 80;
const MAX_SAMPLE_ROWS = 40;
const MAX_HISTORY_MESSAGES = 30;
const MAX_SQL_RESULT_ROWS = 5000;
const TRACE_ARRAY_PREVIEW = 80;
const TRACE_OBJECT_KEYS_PREVIEW = 80;
const TRACE_STRING_PREVIEW = 4000;
const TRACE_TABLE_MAX_ROWS = 20;
const TRACE_TABLE_MAX_COLUMNS = 9;
const TRACE_TABLE_MAX_CELL = 120;

type TraceEvent = {
	title: string;
	summary?: Record<string, unknown>;
	details?: unknown;
};

function shortText(value: string, max = 180): string {
	if (value.length <= max) {
		return value;
	}
	return `${value.slice(0, max - 3)}...`;
}

function hasTruthyTraceFlag(value: string | undefined): boolean | null {
	if (!value) {
		return null;
	}
	const normalized = value.trim().toLowerCase();
	if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') {
		return true;
	}
	if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') {
		return false;
	}
	return null;
}

function isAssistTraceEnabled(): boolean {
	const explicit = hasTruthyTraceFlag(env.ASSIST_TRACE);
	if (explicit !== null) {
		return explicit;
	}
	return process.env.NODE_ENV !== 'production';
}

function isAssistFullLogEnabled(): boolean {
	const explicit = hasTruthyTraceFlag(env.ASSIST_LOG_FULL);
	if (explicit !== null) {
		return explicit;
	}
	return process.env.NODE_ENV !== 'production';
}

function fileTimestamp(date = new Date()): string {
	return date.toISOString().replace(/[:.]/g, '-');
}

function summarizeAction(action: AssistSceneAction): Record<string, unknown> {
	return {
		hasVisibilityAction: Boolean(action.visibility),
		visibilityMode: action.visibility?.mode ?? null,
		visibilityCount: action.visibility?.returnedCount ?? null,
		hasOrbitAction: Boolean(action.orbits),
		orbitMode: action.orbits?.mode ?? null,
		orbitCount: action.orbits?.returnedCount ?? null,
		hasFocusAction: Boolean(action.focus),
		focusTarget: action.focus?.target ?? null,
		focusNoradId: action.focus?.target === 'norad' ? action.focus.noradCatId : null
	};
}

function compactActionForTrace(action: AssistSceneAction): Record<string, unknown> {
	return {
		visibility: action.visibility
			? {
					mode: action.visibility.mode,
					returnedCount: action.visibility.returnedCount,
					noradPreview: action.visibility.noradCatIds.slice(0, 20)
				}
			: null,
		orbits: action.orbits
			? {
					mode: action.orbits.mode,
					returnedCount: action.orbits.returnedCount,
					noradPreview: action.orbits.noradCatIds.slice(0, 20)
				}
			: null,
		focus: action.focus ?? null
	};
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeForTrace(value: unknown, depth = 0): unknown {
	if (
		value === null ||
		typeof value === 'number' ||
		typeof value === 'boolean' ||
		value === undefined
	) {
		return value;
	}
	if (typeof value === 'string') {
		return value.length <= TRACE_STRING_PREVIEW
			? value
			: `${value.slice(0, TRACE_STRING_PREVIEW)}...<truncated>`;
	}
	if (depth >= 5) {
		return '<max-depth>';
	}
	if (Array.isArray(value)) {
		const trimmed = value
			.slice(0, TRACE_ARRAY_PREVIEW)
			.map((item) => sanitizeForTrace(item, depth + 1));
		if (value.length > TRACE_ARRAY_PREVIEW) {
			trimmed.push(`<${value.length - TRACE_ARRAY_PREVIEW} more items>`);
		}
		return trimmed;
	}
	const entries = Object.entries(value as Record<string, unknown>).slice(
		0,
		TRACE_OBJECT_KEYS_PREVIEW
	);
	const out: Record<string, unknown> = {};
	for (const [key, item] of entries) {
		out[key] = sanitizeForTrace(item, depth + 1);
	}
	if (Object.keys(value as Record<string, unknown>).length > TRACE_OBJECT_KEYS_PREVIEW) {
		out.__truncated_keys__ = true;
	}
	return out;
}

function scalarText(value: unknown): string {
	if (value === null || value === undefined) {
		return String(value);
	}
	if (typeof value === 'string') {
		return value.replace(/\s+/g, ' ').trim();
	}
	if (typeof value === 'number' || typeof value === 'boolean') {
		return String(value);
	}
	const asJson = JSON.stringify(sanitizeForTrace(value));
	if (typeof asJson === 'string') {
		return asJson;
	}
	return inspect(value, { depth: 1, compact: true, breakLength: Number.POSITIVE_INFINITY });
}

function truncCell(value: string, max = TRACE_TABLE_MAX_CELL): string {
	if (value.length <= max) {
		return value;
	}
	return value;
}

function padRight(value: string, width: number): string {
	if (value.length >= width) {
		return value;
	}
	return `${value}${' '.repeat(width - value.length)}`;
}

function inferTypeLabel(value: unknown): string {
	if (value === null || value === undefined) {
		return 'null';
	}
	if (typeof value === 'string') {
		return 'text';
	}
	if (typeof value === 'number') {
		return Number.isInteger(value) ? 'int' : 'float';
	}
	if (typeof value === 'boolean') {
		return 'bool';
	}
	if (Array.isArray(value)) {
		return 'array';
	}
	return 'object';
}

function isTableScalar(value: unknown): boolean {
	return (
		value === null ||
		value === undefined ||
		typeof value === 'string' ||
		typeof value === 'number' ||
		typeof value === 'boolean'
	);
}

function isTableFriendlyRows(rows: Record<string, unknown>[]): boolean {
	return rows.every((row) => Object.values(row).every((value) => isTableScalar(value)));
}

function formatRowsTable(rows: Record<string, unknown>[]): string | null {
	if (rows.length === 0) {
		return null;
	}
	const allColumns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
	if (allColumns.length === 0) {
		return null;
	}
	const shownColumns = allColumns.slice(0, TRACE_TABLE_MAX_COLUMNS);
	const hasMoreColumns = allColumns.length > shownColumns.length;
	const headers = hasMoreColumns ? [...shownColumns, '...'] : shownColumns;
	const shownRows = rows.slice(0, TRACE_TABLE_MAX_ROWS);
	const body = shownRows.map((row) => {
		const cells = shownColumns.map((column) => truncCell(scalarText(row[column])));
		if (hasMoreColumns) {
			cells.push('...');
		}
		return cells;
	});
	if (rows.length > shownRows.length) {
		const tail = headers.map(() => '...');
		tail[0] = `... +${rows.length - shownRows.length} rows`;
		body.push(tail);
	}
	const typeRow = shownColumns.map((column) => {
		const sample = rows.find((row) => row[column] !== undefined)?.[column];
		return inferTypeLabel(sample);
	});
	if (hasMoreColumns) {
		typeRow.push('...');
	}
	const widths = headers.map((header, index) =>
		Math.max(
			header.length,
			typeRow[index]?.length ?? 0,
			...body.map((row) => row[index]?.length ?? 0)
		)
	);
	const rowLine = (cells: string[]) =>
		`│ ${cells.map((cell, index) => padRight(cell, widths[index])).join(' │ ')} │`;
	const top = `┌${widths.map((width) => '─'.repeat(width + 2)).join('┬')}┐`;
	const middle = `├${widths.map((width) => '─'.repeat(width + 2)).join('┼')}┤`;
	const bottom = `└${widths.map((width) => '─'.repeat(width + 2)).join('┴')}┘`;
	return [
		top,
		rowLine(headers),
		rowLine(typeRow),
		middle,
		...body.map((row) => rowLine(row)),
		bottom,
		`${rows.length} rows (${Math.min(rows.length, TRACE_TABLE_MAX_ROWS)} shown), ${allColumns.length} columns (${shownColumns.length} shown)`
	].join('\n');
}

function formatScalarList(values: unknown[], max = 20): string {
	const shown = values.slice(0, max).map((item) => shortText(scalarText(item), 60));
	if (values.length <= max) {
		return shown.join(', ');
	}
	return `${shown.join(', ')} ... (+${values.length - max} more)`;
}

function markdownTextBlock(text: string): string {
	return `\`\`\`text\n${text}\n\`\`\``;
}

function summaryValueText(value: unknown): string {
	if (value === null || value === undefined) {
		return String(value);
	}
	if (Array.isArray(value)) {
		if (value.length === 0) {
			return '[]';
		}
		if (value.every((item) => !isPlainObject(item) && !Array.isArray(item))) {
			return formatScalarList(value, 6);
		}
		return `${value.length} items`;
	}
	if (isPlainObject(value)) {
		return inspect(sanitizeForTrace(value), { depth: 1, compact: true, breakLength: 120 });
	}
	return scalarText(value);
}

function renderDetailSections(value: unknown): string[] {
	if (value === null || value === undefined) {
		return ['- (none)'];
	}
	if (!isPlainObject(value)) {
		if (Array.isArray(value)) {
			const tableRows = value.filter((item) => isPlainObject(item)) as Record<string, unknown>[];
			if (
				tableRows.length === value.length &&
				tableRows.length > 0 &&
				isTableFriendlyRows(tableRows)
			) {
				const table = formatRowsTable(tableRows);
				return table ? [markdownTextBlock(table)] : [markdownTextBlock(inspect(value))];
			}
			return [markdownTextBlock(inspect(sanitizeForTrace(value), { depth: 4, compact: false }))];
		}
		if (typeof value === 'string') {
			return [markdownTextBlock(shortText(value, TRACE_STRING_PREVIEW))];
		}
		return [markdownTextBlock(inspect(value, { depth: 4, compact: false, breakLength: 100 }))];
	}
	const lines: string[] = [];
	const entries = Object.entries(value);
	for (const [key, item] of entries) {
		if (
			item === null ||
			item === undefined ||
			typeof item === 'string' ||
			typeof item === 'number' ||
			typeof item === 'boolean'
		) {
			const valueText = scalarText(item);
			if (valueText.length > 260) {
				lines.push(`${key}:`);
				lines.push(markdownTextBlock(valueText));
			} else {
				lines.push(`- ${key}: ${valueText}`);
			}
			continue;
		}
		if (
			Array.isArray(item) &&
			item.every((entry) => !isPlainObject(entry) && !Array.isArray(entry))
		) {
			lines.push(`- ${key}: ${formatScalarList(item, 20)}`);
			continue;
		}
		lines.push(`${key}:`);
		if (Array.isArray(item)) {
			const tableRows = item.filter((entry) => isPlainObject(entry)) as Record<string, unknown>[];
			if (
				tableRows.length === item.length &&
				tableRows.length > 0 &&
				isTableFriendlyRows(tableRows)
			) {
				const table = formatRowsTable(tableRows);
				lines.push(markdownTextBlock(table ?? inspect(item)));
			} else {
				lines.push(
					markdownTextBlock(inspect(sanitizeForTrace(item), { depth: 4, compact: false }))
				);
			}
			continue;
		}
		if (isPlainObject(item)) {
			lines.push(markdownTextBlock(inspect(sanitizeForTrace(item), { depth: 4, compact: false })));
			continue;
		}
		lines.push(markdownTextBlock(shortText(String(item), TRACE_STRING_PREVIEW)));
	}
	return lines;
}

function renderTraceMarkdown({
	requestId,
	model,
	sceneContext,
	messages,
	events,
	assistantMessage,
	action,
	startedAt,
	finishedAt
}: {
	requestId: string;
	model: string;
	sceneContext: ReturnType<typeof normalizeSceneContext>;
	messages: AssistRequestBody['messages'];
	events: TraceEvent[];
	assistantMessage: string;
	action: AssistSceneAction;
	startedAt: number;
	finishedAt: number;
}): string {
	const latestUserMessage =
		messages
			.slice()
			.reverse()
			.find((message) => message.role === 'user')?.content ?? '';
	const lines: string[] = [];
	lines.push('# Assist Trace');
	lines.push('');
	lines.push(`- Request ID: \`${requestId}\``);
	lines.push(`- Model: \`${model}\``);
	lines.push(`- Started: \`${new Date(startedAt).toISOString()}\``);
	lines.push(`- Finished: \`${new Date(finishedAt).toISOString()}\``);
	lines.push(`- Duration: \`${finishedAt - startedAt} ms\``);
	lines.push('');
	lines.push('## User Message');
	lines.push('');
	lines.push(
		`- Latest user message: ${latestUserMessage ? `\`${shortText(latestUserMessage, 400)}\`` : '`<none>`'}`
	);
	lines.push(`- Message count: \`${messages.length}\``);
	lines.push('');
	lines.push('<details><summary>Conversation</summary>');
	lines.push('');
	lines.push(
		markdownTextBlock(
			messages.map((msg, i) => `${i + 1}. ${msg.role}: ${msg.content}`).join('\n\n')
		)
	);
	lines.push('');
	lines.push('</details>');
	lines.push('');
	lines.push('## Scene Context');
	lines.push('');
	lines.push(`- selectedNoradId: \`${sceneContext.selectedNoradId}\``);
	lines.push(`- visibleCount: \`${sceneContext.visibleCount}\``);
	lines.push(`- selectedInfoPanel: \`${sceneContext.selectedInfoPanel}\``);
	lines.push('');
	lines.push('## Timeline');
	lines.push('');
	for (const [index, event] of events.entries()) {
		lines.push(`### ${index + 1}. ${event.title}`);
		lines.push('');
		if (event.summary) {
			for (const [key, val] of Object.entries(event.summary)) {
				lines.push(`- ${key}: \`${shortText(summaryValueText(val), 200)}\``);
			}
			lines.push('');
		}
		if (event.details !== undefined) {
			lines.push('<details><summary>Details</summary>');
			lines.push('');
			lines.push(...renderDetailSections(event.details));
			lines.push('');
			lines.push('</details>');
			lines.push('');
		}
	}
	lines.push('## Final Output');
	lines.push('');
	lines.push('assistantMessage:');
	lines.push(markdownTextBlock(assistantMessage));
	for (const [key, value] of Object.entries(summarizeAction(action))) {
		lines.push(`- ${key}: \`${String(value)}\``);
	}
	lines.push('');
	lines.push('<details><summary>Final action payload</summary>');
	lines.push('');
	lines.push(...renderDetailSections(compactActionForTrace(action)));
	lines.push('');
	lines.push('</details>');
	lines.push('');
	return lines.join('\n');
}

function summarizeToolArgs(
	toolName: string,
	toolArgs: Record<string, unknown>
): Record<string, unknown> {
	if (toolName === 'sql_select') {
		return {
			sql: typeof toolArgs.sql === 'string' ? shortText(toolArgs.sql, 220) : null,
			preview_rows: toolArgs.preview_rows ?? null,
			sample_rows: toolArgs.sample_rows ?? null
		};
	}
	if (toolName === 'set_visibility_from_result') {
		return {
			result_ref: toolArgs.result_ref ?? null,
			mode: toolArgs.mode ?? null,
			id_column: toolArgs.id_column ?? null
		};
	}
	if (toolName === 'set_visibility') {
		const ids = normalizeNoradIds(toolArgs.norad_ids);
		return {
			mode: toolArgs.mode ?? null,
			norad_count: ids.length,
			norad_preview: ids.slice(0, 12)
		};
	}
	if (toolName === 'set_orbits_from_result') {
		return {
			result_ref: toolArgs.result_ref ?? null,
			mode: toolArgs.mode ?? null,
			id_column: toolArgs.id_column ?? null
		};
	}
	if (toolName === 'set_orbits') {
		const ids = normalizeNoradIds(toolArgs.norad_ids);
		return {
			mode: toolArgs.mode ?? null,
			norad_count: ids.length,
			norad_preview: ids.slice(0, 12)
		};
	}
	if (toolName === 'set_focus') {
		return {
			target: toolArgs.target ?? null,
			norad_id: toolArgs.norad_id ?? null
		};
	}
	return { ...toolArgs };
}

function summarizeToolOutput(
	toolName: string,
	output: Record<string, unknown>
): Record<string, unknown> {
	if (toolName === 'sql_select') {
		return {
			ok: output.ok ?? null,
			row_count: output.row_count ?? null,
			columns: Array.isArray(output.columns) ? output.columns.length : null,
			result_ref: output.result_ref ?? null,
			truncated: output.truncated ?? null
		};
	}
	if (
		toolName === 'set_visibility' ||
		toolName === 'set_visibility_from_result' ||
		toolName === 'set_orbits' ||
		toolName === 'set_orbits_from_result'
	) {
		return {
			ok: output.ok ?? null,
			mode: output.mode ?? null,
			returned_count: output.returned_count ?? null,
			id_column: output.id_column ?? null
		};
	}
	if (toolName === 'set_focus') {
		return {
			ok: output.ok ?? null,
			target:
				typeof output.focus === 'object' && output.focus ? output.focus : (output.target ?? null)
		};
	}
	return output;
}

function formatToolHistoryEntry(
	toolName: string,
	toolArgs: Record<string, unknown>,
	output: Record<string, unknown>
): string {
	if (toolName === 'sql_select') {
		const sql = typeof toolArgs.sql === 'string' ? toolArgs.sql.trim() : '';
		const rowCount = output.row_count ?? null;
		const resultRef = output.result_ref ?? null;
		return `sql_select sql=${JSON.stringify(sql)} row_count=${rowCount} result_ref=${resultRef}`;
	}
	if (toolName === 'set_visibility_from_result') {
		return `set_visibility_from_result result_ref=${toolArgs.result_ref ?? null} mode=${toolArgs.mode ?? null} id_column=${toolArgs.id_column ?? null} returned_count=${output.returned_count ?? null}`;
	}
	if (toolName === 'set_visibility') {
		return `set_visibility mode=${toolArgs.mode ?? null} returned_count=${output.returned_count ?? null}`;
	}
	if (toolName === 'set_orbits_from_result') {
		return `set_orbits_from_result result_ref=${toolArgs.result_ref ?? null} mode=${toolArgs.mode ?? null} id_column=${toolArgs.id_column ?? null} returned_count=${output.returned_count ?? null}`;
	}
	if (toolName === 'set_orbits') {
		return `set_orbits mode=${toolArgs.mode ?? null} returned_count=${output.returned_count ?? null}`;
	}
	if (toolName === 'set_focus') {
		return `set_focus target=${toolArgs.target ?? null} norad_id=${toolArgs.norad_id ?? null}`;
	}
	const summarized = summarizeToolOutput(toolName, output);
	return `${toolName} ${JSON.stringify(summarized)}`;
}

function summarizeFunctionCallOutputForTrace(
	parsedOutput: Record<string, unknown>
): Record<string, unknown> {
	return {
		ok: parsedOutput.ok ?? null,
		result_ref: parsedOutput.result_ref ?? null,
		row_count: parsedOutput.row_count ?? null,
		returned_count: parsedOutput.returned_count ?? null,
		mode: parsedOutput.mode ?? null,
		id_column: parsedOutput.id_column ?? null,
		columns:
			Array.isArray(parsedOutput.columns) &&
			parsedOutput.columns.every((value) => typeof value === 'string')
				? parsedOutput.columns
				: null,
		keys: Object.keys(parsedOutput)
	};
}

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

const SET_ORBITS_FROM_RESULT_TOOL: FunctionTool = {
	type: 'function',
	name: 'set_orbits_from_result',
	description:
		'Draw orbit trails using NORAD IDs from a prior sql_select result_ref and an ID column.',
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

const SET_ORBITS_TOOL: FunctionTool = {
	type: 'function',
	name: 'set_orbits',
	description: 'Draw orbit trails from an explicit list of NORAD IDs.',
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
	SET_ORBITS_FROM_RESULT_TOOL,
	SET_ORBITS_TOOL,
	SET_FOCUS_TOOL
];

type QueryResultStore = {
	rows: Record<string, unknown>[];
	columns: string[];
};

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

function buildDatabaseContext(db: Database.Database) {
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
			'SELECT COUNTRY, ORBITAL_TOTAL_COUNT, ORBITAL_PAYLOAD_COUNT, ORBITAL_DEBRIS_COUNT, COUNTRY_TOTAL FROM boxscore ORDER BY COUNTRY_TOTAL DESC LIMIT 5',
		discos_objects:
			'SELECT norad_cat_id, cospar_id, name, object_class, mission, launch_cospar_no, launch_epoch, launch_vehicle_name, launch_site_name FROM discos_objects LIMIT 5',
		discos_object_entities:
			'SELECT norad_cat_id, role, entity_type, entity_name FROM discos_object_entities LIMIT 5'
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

	return parts.join('\n');
}

function buildInstructions({
	sceneContext,
	databaseContext
}: {
	sceneContext: ReturnType<typeof normalizeSceneContext>;
	databaseContext: string;
}): string {
	return [
		'You are the Satellite Oracle assistant.',
		'Use tools aggressively to inspect data and update the scene in one turn when useful.',
		'You can run only read-only SQL through sql_select. Use sql_select for analysis before acting.',
		'For large result sets, use set_visibility_from_result instead of manually listing IDs.',
		'When the user asks for orbit trails, use set_orbits_from_result (or set_orbits) in the same turn.',
		'For requests like "show X with orbits", pair visibility and orbit actions on the same subset.',
		"When the user asks to focus an object, call set_focus with target='norad' and norad_id.",
		"When the user asks to focus Earth, call set_focus with target='earth'.",
		'When the user asks to see objects, prefer applying a visibility action instead of returning long lists.',
		'Limit exploration to at most two SQL probes before deciding on an action or asking one concise clarification.',
		'Avoid schema-probing queries against sqlite_master unless absolutely necessary.',
		'You may call multiple tools before your final answer.',
		'Keep the final answer concise and explicit about scene changes applied.',
		'For launch provider or operator/owner requests, prefer discos_objects and discos_object_entities first.',
		`Scene context: ${JSON.stringify(sceneContext)}.`,
		databaseContext
	].join('\n');
}

function summarizeTools(tools: FunctionTool[]) {
	return tools.map((tool) => tool.name);
}

function summarizeResponseForTrace(response: Response): Record<string, unknown> {
	const functionCalls = response.output
		.filter((item) => item.type === 'function_call')
		.map((item) => ({
			name: item.name,
			call_id: item.call_id,
			arguments_summary: summarizeToolArgs(item.name, parseToolArgs(item.arguments))
		}));
	const assistantMessages = response.output
		.filter((item) => item.type === 'message')
		.map((item) => ({
			role: item.role,
			text: item.content
				.filter((entry) => entry.type === 'output_text')
				.map((entry) => entry.text)
				.join('\n')
		}))
		.filter((message) => message.text.trim() !== '');
	return {
		response_id: response.id ?? null,
		function_calls: functionCalls,
		assistant_messages: assistantMessages,
		output_text: response.output_text ?? ''
	};
}

function serializeResponseOutputForFullLog(response: Response): unknown[] {
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

function summarizeResponseForLog(response: Response): Record<string, unknown> {
	const functionCalls = response.output
		.filter((item) => item.type === 'function_call')
		.map((item) => ({
			name: item.name,
			callId: item.call_id
		}));
	return {
		responseId: response.id ?? null,
		outputItems: response.output.length,
		functionCallCount: functionCalls.length,
		functionCallNames: functionCalls.map((call) => call.name).join(', ') || 'none',
		hasOutputText: Boolean(response.output_text && response.output_text.trim() !== ''),
		outputTextPreview: response.output_text ? shortText(response.output_text, 180) : ''
	};
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
	db,
	toolName,
	toolArgs,
	queryResults,
	pendingAction,
	logger,
	traceEvent,
	fullLog
}: {
	db: Database.Database;
	toolName: string;
	toolArgs: Record<string, unknown>;
	queryResults: Map<string, QueryResultStore>;
	pendingAction: AssistSceneAction;
	logger: ReturnType<typeof createLogger>;
	traceEvent?: (event: TraceEvent) => void;
	fullLog?: (message: string, meta?: Record<string, unknown>) => void;
}) {
	logger.info('assist tool execution started', {
		toolName,
		toolArgs: summarizeToolArgs(toolName, toolArgs)
	});
	fullLog?.('assist tool execution started full', {
		toolName,
		toolArgs
	});

	if (toolName === 'sql_select') {
		const guardedSql = guardReadOnlySql(toolArgs.sql, DB_PATH);
		if (!guardedSql.ok) {
			return { ok: false, error: guardedSql.error };
		}
		const sql = guardedSql.sql;
		const previewRows = clampInt(toolArgs.preview_rows, 1, MAX_PREVIEW_ROWS, DEFAULT_PREVIEW_ROWS);
		const sampleRows = clampInt(toolArgs.sample_rows, 0, MAX_SAMPLE_ROWS, DEFAULT_SAMPLE_ROWS);
		try {
			const startedAt = Date.now();
			const stmt = db.prepare(sql);
			if (!stmt.reader) {
				return { ok: false, error: 'Query must return rows.' };
			}
			if (!stmt.readonly) {
				return { ok: false, error: 'sql_select only allows read-only queries.' };
			}
			const rows: Record<string, unknown>[] = [];
			let rowCapReached = false;
			for (const row of stmt.iterate() as IterableIterator<Record<string, unknown>>) {
				rows.push(row);
				if (rows.length >= MAX_SQL_RESULT_ROWS) {
					rowCapReached = true;
					break;
				}
			}
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
				rowCapReached,
				columns: columns.length,
				resultRef,
				durationMs: Date.now() - startedAt
			});
			fullLog?.('sql_select executed full', {
				sql,
				previewRowsRequested: previewRows,
				sampleRowsRequested: sampleRows,
				rows,
				columns,
				resultRef,
				rowCapReached
			});
			traceEvent?.({
				title: 'Tool result: sql_select',
				summary: {
					result_ref: resultRef,
					row_count: rows.length,
					column_count: columns.length,
					duration_ms: Date.now() - startedAt
				},
				details: {
					sql,
					result_ref: resultRef,
					row_count: rows.length,
					columns,
					preview_rows: preview.slice(0, 20),
					preview_rows_shown: Math.min(preview.length, 20),
					row_cap_reached: rowCapReached
				}
			});
			return {
				ok: true,
				result_ref: resultRef,
				row_count: rows.length,
				columns,
				preview_rows: sanitizeRowsForModel(preview),
				sample_rows: sanitizeRowsForModel(sample),
				truncated: rowCapReached || rows.length > preview.length,
				truncated_by_row_cap: rowCapReached
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
			resolvedColumn: extraction.resolvedColumn
		});
		fullLog?.('visibility action prepared from result full', {
			mode,
			returnedCount: extraction.ids.length,
			resolvedColumn: extraction.resolvedColumn,
			noradCatIds: extraction.ids
		});
		traceEvent?.({
			title: 'Tool result: set_visibility_from_result',
			summary: {
				mode,
				returned_count: extraction.ids.length,
				id_column: extraction.resolvedColumn
			},
			details: {
				mode,
				result_ref: resultRef,
				id_column: extraction.resolvedColumn,
				returned_count: extraction.ids.length,
				norad_preview: extraction.ids.slice(0, 50)
			}
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
		fullLog?.('visibility action prepared full', {
			mode,
			returnedCount: noradIds.length,
			noradCatIds: noradIds
		});
		traceEvent?.({
			title: 'Tool result: set_visibility',
			summary: { mode, returned_count: noradIds.length },
			details: {
				mode,
				returned_count: noradIds.length,
				norad_preview: noradIds.slice(0, 50)
			}
		});
		return { ok: true, mode, returned_count: noradIds.length };
	}

	if (toolName === 'set_orbits_from_result') {
		const resultRef =
			typeof toolArgs.result_ref === 'string' && toolArgs.result_ref.trim() !== ''
				? toolArgs.result_ref.trim()
				: null;
		const mode = normalizeMode(toolArgs.mode);
		if (!resultRef || !mode) {
			return { ok: false, error: 'set_orbits_from_result requires result_ref and valid mode.' };
		}
		const storedResult = queryResults.get(resultRef);
		if (!storedResult) {
			return { ok: false, error: `Unknown result_ref '${resultRef}'.` };
		}
		const idColumn = typeof toolArgs.id_column === 'string' ? toolArgs.id_column : undefined;
		const extraction = extractNoradIdsFromRows({ rows: storedResult.rows, idColumn });
		if (extraction.ids.length === 0 && mode !== 'replace') {
			return {
				ok: false,
				error:
					'Could not extract NORAD IDs from result rows. Provide id_column (e.g. NORAD_CAT_ID).',
				available_columns: storedResult.columns
			};
		}
		pendingAction.orbits = {
			mode,
			noradCatIds: extraction.ids,
			returnedCount: extraction.ids.length
		};
		logger.info('orbit action prepared from result', {
			mode,
			returnedCount: extraction.ids.length,
			resolvedColumn: extraction.resolvedColumn
		});
		fullLog?.('orbit action prepared from result full', {
			mode,
			returnedCount: extraction.ids.length,
			resolvedColumn: extraction.resolvedColumn,
			noradCatIds: extraction.ids
		});
		traceEvent?.({
			title: 'Tool result: set_orbits_from_result',
			summary: {
				mode,
				returned_count: extraction.ids.length,
				id_column: extraction.resolvedColumn
			},
			details: {
				mode,
				result_ref: resultRef,
				id_column: extraction.resolvedColumn,
				returned_count: extraction.ids.length,
				norad_preview: extraction.ids.slice(0, 50)
			}
		});
		return {
			ok: true,
			mode,
			returned_count: extraction.ids.length,
			id_column: extraction.resolvedColumn
		};
	}

	if (toolName === 'set_orbits') {
		const mode = normalizeMode(toolArgs.mode);
		const noradIds = normalizeNoradIds(toolArgs.norad_ids);
		if (!mode || (mode !== 'replace' && noradIds.length === 0)) {
			return { ok: false, error: 'set_orbits requires mode and valid NORAD IDs.' };
		}
		pendingAction.orbits = {
			mode,
			noradCatIds: noradIds,
			returnedCount: noradIds.length
		};
		logger.info('orbit action prepared', { mode, returnedCount: noradIds.length });
		fullLog?.('orbit action prepared full', {
			mode,
			returnedCount: noradIds.length,
			noradCatIds: noradIds
		});
		traceEvent?.({
			title: 'Tool result: set_orbits',
			summary: { mode, returned_count: noradIds.length },
			details: {
				mode,
				returned_count: noradIds.length,
				norad_preview: noradIds.slice(0, 50)
			}
		});
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
		fullLog?.('focus action prepared full', focus);
		traceEvent?.({
			title: 'Tool result: set_focus',
			summary: {
				target: focus.target,
				norad_id: focus.target === 'norad' ? focus.noradCatId : null
			},
			details: focus
		});
		return { ok: true, focus };
	}

	return { ok: false, error: `Unknown tool '${toolName}'.` };
}

function buildFallbackMessage(action: AssistSceneAction): string {
	if (!action.visibility && !action.orbits && !action.focus) {
		return 'I could not complete that request. Please restate what you want to query or change.';
	}
	const parts: string[] = [];
	if (action.visibility) {
		parts.push(
			`Applied visibility mode ${action.visibility.mode} to ${action.visibility.returnedCount} objects.`
		);
	}
	if (action.orbits) {
		parts.push(`Applied orbit mode ${action.orbits.mode} to ${action.orbits.returnedCount} objects.`);
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
	const db = openReadDatabase();
	const model = env.OPENAI_ASSIST_MODEL || 'gpt-5-mini';
	const sceneContext = normalizeSceneContext(body.sceneContext);
	const requestId = options?.requestId ?? 'unknown';
	const logger = createLogger('assist.executor', {
		requestId,
		model
	});
	const input = buildPlannerInput(body);
	const databaseContext = buildDatabaseContext(db);
	const instructions = buildInstructions({ sceneContext, databaseContext });
	const queryResults = new Map<string, QueryResultStore>();
	const action: AssistSceneAction = {};
	const toolHistoryLines: string[] = [];
	const traceEnabled = isAssistTraceEnabled();
	const fullLogEnabled = isAssistFullLogEnabled();
	const traceStartedAt = Date.now();
	const traceEvents: TraceEvent[] = [];
	const pushTrace = (event: TraceEvent) => {
		if (traceEnabled) {
			traceEvents.push(event);
		}
	};
	const fullLog = (message: string, meta?: Record<string, unknown>) => {
		if (fullLogEnabled) {
			logger.info(message, meta);
		}
	};

	try {
		const latestUserMessage =
			body.messages
				.slice()
				.reverse()
				.find((message) => message.role === 'user')?.content ?? '';
		pushTrace({
			title: 'Assist request accepted',
			summary: {
				message_count: body.messages.length,
				selected_norad_id: sceneContext.selectedNoradId ?? null,
				visible_count: sceneContext.visibleCount,
				latest_user_message: shortText(latestUserMessage, 220)
			},
			details: {
				messages: body.messages,
				scene_context: sceneContext
			}
		});

		logger.info('assist tool loop started', {
			messageCount: input.length,
			selectedNoradId: sceneContext.selectedNoradId,
			visibleCount: sceneContext.visibleCount,
			latestUserMessage: shortText(latestUserMessage, 180)
		});
		fullLog('assist tool loop started full', {
			messageCount: input.length,
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
			model,
			inputItems: input.length,
			toolNames: summarizeTools(ASSIST_TOOLS),
			instructionsChars: instructions.length
		});
		fullLog('openai responses.create request full', {
			step: 'initial',
			payload: initialRequest
		});
		pushTrace({
			title: 'OpenAI request: initial',
			summary: {
				model,
				input_items: input.length,
				tool_count: ASSIST_TOOLS.length,
				instructions_chars: instructions.length
			},
			details: {
				model,
				input,
				instructions_preview: shortText(instructions, 1200),
				instructions_chars: instructions.length,
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
			...summarizeResponseForLog(response)
		});
		fullLog('openai responses.create response full', {
			step: 'initial',
			responseId: response.id ?? null,
			outputText: response.output_text ?? '',
			output: serializeResponseOutputForFullLog(response)
		});
		pushTrace({
			title: 'OpenAI response: initial',
			summary: summarizeResponseForLog(response),
			details: summarizeResponseForTrace(response)
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
					callId: call.call_id
				}))
			});
			fullLog('assist executing tool round full', {
				round,
				toolCalls: functionCalls.length,
				functionCalls: functionCalls.map((call) => ({
					name: call.name,
					callId: call.call_id,
					argumentsRaw: call.arguments
				}))
			});
			pushTrace({
				title: `Tool round ${round}`,
				summary: {
					tool_calls: functionCalls.length
				},
				details: functionCalls.map((call) => ({
					name: call.name,
					call_id: call.call_id,
					arguments: parseToolArgs(call.arguments)
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
					toolArgs: summarizeToolArgs(call.name, args)
				});
				fullLog('assist tool call received full', {
					round,
					toolName: call.name,
					callId: call.call_id,
					argumentsRaw: call.arguments,
					argumentsParsed: args
				});
				pushTrace({
					title: `Tool call: ${call.name}`,
					summary: {
						round,
						call_id: call.call_id
					},
					details: {
						arguments: args
					}
				});
				const output = await executeToolCall({
					db,
					toolName: call.name,
					toolArgs: args,
					queryResults,
					pendingAction: action,
					logger,
					traceEvent: pushTrace,
					fullLog
				});
				logger.info('assist tool call output', {
					round,
					toolName: call.name,
					callId: call.call_id,
					output: summarizeToolOutput(call.name, output)
				});
				fullLog('assist tool call output full', {
					round,
					toolName: call.name,
					callId: call.call_id,
					output
				});
				toolHistoryLines.push(formatToolHistoryEntry(call.name, args, output));
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
				model,
				previousResponseId: response.id ?? null,
				inputItems: toolOutputs.length,
				toolNames: summarizeTools(ASSIST_TOOLS)
			});
			fullLog('openai responses.create request full', {
				step: 'followup',
				round,
				payload: followupRequest
			});
			pushTrace({
				title: `OpenAI request: followup round ${round}`,
				summary: {
					model,
					previous_response_id: response.id ?? null,
					input_items: toolOutputs.length
				},
				details: {
					model,
					previous_response_id: response.id ?? null,
					tool_outputs: toolOutputs.map((item) => ({
						call_id: item.call_id,
						output: summarizeFunctionCallOutputForTrace(JSON.parse(item.output))
					}))
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
				...summarizeResponseForLog(response)
			});
			fullLog('openai responses.create response full', {
				step: 'followup',
				round,
				responseId: response.id ?? null,
				outputText: response.output_text ?? '',
				output: serializeResponseOutputForFullLog(response)
			});
			pushTrace({
				title: `OpenAI response: followup round ${round}`,
				summary: summarizeResponseForLog(response),
				details: summarizeResponseForTrace(response)
			});
		}

		const historyMessages =
			toolHistoryLines.length > 0
				? [
						{
							role: 'assistant' as const,
							content: [
								'[tool-history]',
								...toolHistoryLines.map((line, index) => `${index + 1}. ${line}`)
							].join('\n')
						}
					]
				: undefined;

		const hasSceneAction = Boolean(action.visibility || action.orbits || action.focus);
		const assistantMessage =
			typeof response.output_text === 'string' && response.output_text.trim() !== ''
				? response.output_text.trim()
				: buildFallbackMessage(action);

		logger.info('assist tool loop completed', {
			...summarizeAction(action),
			assistantMessagePreview: shortText(assistantMessage, 180)
		});
		fullLog('assist tool loop completed full', {
			...summarizeAction(action),
			assistantMessage,
			action
		});
		pushTrace({
			title: 'Assist completed',
			summary: {
				...summarizeAction(action),
				assistant_message_preview: shortText(assistantMessage, 180)
			},
			details: {
				assistant_message: assistantMessage,
				action: compactActionForTrace(action)
			}
		});

		if (traceEnabled) {
			const traceDir = path.join(process.cwd(), 'logs', 'assist');
			const safeRequestId = requestId.replace(/[^a-zA-Z0-9_-]/g, '_');
			const traceFilePath = path.join(
				traceDir,
				`${fileTimestamp(new Date(traceStartedAt))}-${safeRequestId}.md`
			);
			try {
				await fs.mkdir(traceDir, { recursive: true });
				const traceBody = renderTraceMarkdown({
					requestId,
					model,
					sceneContext,
					messages: body.messages,
					events: traceEvents,
					assistantMessage,
					action,
					startedAt: traceStartedAt,
					finishedAt: Date.now()
				});
				await fs.writeFile(traceFilePath, traceBody, 'utf8');
				logger.info('assist trace written', {
					tracePath: path.relative(process.cwd(), traceFilePath)
				});
			} catch (error) {
				logger.warn('assist trace write failed', { error: serializeError(error) });
			}
		}

		return {
			assistantMessage,
			action: hasSceneAction ? action : null,
			historyMessages
		};
	} finally {
		db.close();
	}
}
