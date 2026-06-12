import Database from 'better-sqlite3';
import path from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { createMock } = vi.hoisted(() => ({
	createMock: vi.fn()
}));

vi.mock('openai', () => {
	class MockOpenAI {
		responses: { create: typeof createMock };

		constructor(options: unknown) {
			void options;
			this.responses = {
				create: createMock
			};
		}
	}

	return {
		OpenAI: MockOpenAI
	};
});

vi.mock('$env/dynamic/private', () => ({
	env: { OPENAI_API_KEY: 'test-key', OPENAI_ASSIST_MODEL: 'gpt-5-mini' }
}));

import { runAssist } from '../../src/lib/server/assist/assistant';

const DB_PATH = path.join(process.cwd(), 'src/data/satellite.db');
const OUT_OF_SCENE_NORAD = 99_999_999;

function loadSceneUniverseFixture() {
	const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
	try {
		const countRow = db
			.prepare(
				`
					SELECT COUNT(*) AS count
					FROM (
						SELECT DISTINCT gp.NORAD_CAT_ID
						FROM gp
						JOIN satcat ON gp.NORAD_CAT_ID = satcat.NORAD_CAT_ID
						WHERE gp.NORAD_CAT_ID IS NOT NULL
					)
				`
			)
			.get() as { count: number | string };
		const sampleRows = db
			.prepare(
				`
					SELECT DISTINCT gp.NORAD_CAT_ID AS norad_cat_id
					FROM gp
					JOIN satcat ON gp.NORAD_CAT_ID = satcat.NORAD_CAT_ID
					WHERE gp.NORAD_CAT_ID IS NOT NULL
					ORDER BY gp.NORAD_CAT_ID
					LIMIT 500
				`
			)
			.all() as Array<{ norad_cat_id: number | string }>;
		return {
			count: Number(countRow.count),
			sampleNoradIds: sampleRows.map((row) => Number(row.norad_cat_id))
		};
	} finally {
		db.close();
	}
}

const SCENE_UNIVERSE = loadSceneUniverseFixture();

type MockResponse = {
	id: string;
	output: Array<{
		type: 'function_call';
		name: string;
		call_id: string;
		arguments: string;
	}>;
	output_text: string;
};

function functionCallResponse(
	id: string,
	calls: Array<{ name: string; callId: string; args: Record<string, unknown> }>
): MockResponse {
	return {
		id,
		output: calls.map((call) => ({
			type: 'function_call',
			name: call.name,
			call_id: call.callId,
			arguments: JSON.stringify(call.args)
		})),
		output_text: ''
	};
}

describe('runAssist tool loop behavior', () => {
	beforeEach(() => {
		createMock.mockReset();
	});

	it('can query SQL, apply visibility from result, and set focus in one turn', async () => {
		let requestCount = 0;
		createMock.mockImplementation(async (request: unknown) => {
			const typed = request as Record<string, unknown>;
			if (requestCount === 0) {
				requestCount += 1;
				return functionCallResponse('resp_1', [
					{
						name: 'sql_select',
						callId: 'call_sql_1',
						args: {
							sql: 'SELECT norad_cat_id FROM semantic_gp ORDER BY norad_cat_id LIMIT 12',
							preview_rows: 5,
							sample_rows: 0
						}
					}
				]);
			}
			if (requestCount === 1) {
				requestCount += 1;
				const outputs = typed.input as Array<{ output: string }>;
				const parsedOutput = JSON.parse(outputs[0].output) as { result_ref: string };
				return functionCallResponse('resp_2', [
					{
						name: 'set_visibility_from_result',
						callId: 'call_visibility_1',
						args: {
							result_ref: parsedOutput.result_ref,
							mode: 'replace',
							id_column: 'NORAD_CAT_ID'
						}
					},
					{
						name: 'set_focus',
						callId: 'call_focus_1',
						args: { target: 'earth' }
					}
				]);
			}
			return {
				id: 'resp_3',
				output: [],
				output_text: 'Applied filter and focused on Earth.'
			};
		});

		const result = await runAssist({
			messages: [{ role: 'user', content: 'show a small batch and focus Earth' }],
			sceneContext: { visibleCount: 100, selectedInfoPanel: 'none' }
		});

		expect(result.assistantMessage).toContain('Applied filter');
		expect(result.action?.visibility?.mode).toBe('replace');
		expect(result.action?.visibility?.returnedCount).toBe(12);
		expect(result.action?.focus?.target).toBe('earth');
		expect(result.historyMessages?.[0]?.content).toContain('sql_select sql=');
		expect(result.historyMessages?.[0]?.content).toContain(
			'SELECT norad_cat_id FROM semantic_gp ORDER BY norad_cat_id LIMIT 12'
		);
		expect(createMock).toHaveBeenCalledTimes(3);
	});

	it('can apply orbit overlays from a SQL result in the same turn', async () => {
		let requestCount = 0;
		createMock.mockImplementation(async (request: unknown) => {
			const typed = request as Record<string, unknown>;
			if (requestCount === 0) {
				requestCount += 1;
				return functionCallResponse('resp_1', [
					{
						name: 'sql_select',
						callId: 'call_sql_1',
						args: {
							sql: 'SELECT norad_cat_id FROM semantic_gp ORDER BY norad_cat_id LIMIT 8',
							preview_rows: 5,
							sample_rows: 0
						}
					}
				]);
			}
			if (requestCount === 1) {
				requestCount += 1;
				const outputs = typed.input as Array<{ output: string }>;
				const parsedOutput = JSON.parse(outputs[0].output) as { result_ref: string };
				return functionCallResponse('resp_2', [
					{
						name: 'set_visibility_from_result',
						callId: 'call_visibility_1',
						args: {
							result_ref: parsedOutput.result_ref,
							mode: 'replace',
							id_column: 'NORAD_CAT_ID'
						}
					},
					{
						name: 'set_orbits_from_result',
						callId: 'call_orbits_1',
						args: {
							result_ref: parsedOutput.result_ref,
							mode: 'replace',
							id_column: 'NORAD_CAT_ID'
						}
					}
				]);
			}
			return {
				id: 'resp_3',
				output: [],
				output_text: 'Applied visibility and orbit overlays.'
			};
		});

		const result = await runAssist({
			messages: [{ role: 'user', content: 'show a small batch with orbits' }],
			sceneContext: { visibleCount: 100, selectedInfoPanel: 'none' }
		});

		expect(result.assistantMessage).toContain('Applied visibility');
		expect(result.action?.visibility?.mode).toBe('replace');
		expect(result.action?.orbits?.mode).toBe('replace');
		expect(result.action?.visibility?.returnedCount).toBe(8);
		expect(result.action?.orbits?.returnedCount).toBe(8);
		expect(createMock).toHaveBeenCalledTimes(3);
	});

	it('keeps large explicit orbit sets intact', async () => {
		const manyIds = SCENE_UNIVERSE.sampleNoradIds.slice(0, 400);
		createMock
			.mockResolvedValueOnce(
				functionCallResponse('resp_1', [
					{
						name: 'set_orbits',
						callId: 'call_orbits_1',
						args: { mode: 'replace', norad_ids: manyIds }
					}
				])
			)
			.mockResolvedValueOnce({
				id: 'resp_2',
				output: [],
				output_text: 'Applied orbit overlays.'
			});

		const result = await runAssist({
			messages: [{ role: 'user', content: 'draw all these orbits' }]
		});

		expect(result.action?.orbits?.mode).toBe('replace');
		expect(result.action?.orbits?.returnedCount).toBe(400);
		expect(result.action?.orbits?.noradCatIds).toHaveLength(400);
		expect(createMock).toHaveBeenCalledTimes(1);
	});

	it('filters non-scene NORAD ids out of fast visibility actions', async () => {
		createMock.mockResolvedValueOnce(
			functionCallResponse('resp_1', [
				{
					name: 'set_visibility',
					callId: 'call_visibility_filtered_1',
					args: {
						mode: 'replace',
						norad_ids: [SCENE_UNIVERSE.sampleNoradIds[0], OUT_OF_SCENE_NORAD]
					}
				}
			])
		);

		const result = await runAssist({
			messages: [{ role: 'user', content: 'show this specific mix' }]
		});

		expect(result.action?.visibility?.mode).toBe('replace');
		expect(result.action?.visibility?.returnedCount).toBe(1);
		expect(result.action?.visibility?.noradCatIds).toEqual([SCENE_UNIVERSE.sampleNoradIds[0]]);
		expect(result.assistantMessage).toContain('Applied visibility mode replace to 1 objects.');
		expect(result.historyMessages?.[0]?.content).toContain('filtered_out_count=1');
		expect(createMock).toHaveBeenCalledTimes(1);
	});

	it('supports one-hop fast path with set_visibility_sql', async () => {
		createMock.mockResolvedValueOnce({
			id: 'resp_1',
			output: [
				{
					type: 'function_call',
						name: 'set_visibility_sql',
						call_id: 'call_fast_1',
						arguments: JSON.stringify({
							sql: "SELECT norad_cat_id FROM semantic_satcat WHERE object_type LIKE '%DEBRIS%' LIMIT 5",
							mode: 'replace',
							set_orbits_mode: 'replace',
							focus_target: 'earth'
					})
				}
			],
			output_text: 'Showing five debris objects with orbits.'
		});

		const result = await runAssist({
			messages: [{ role: 'user', content: 'show debris' }]
		});

		expect(result.assistantMessage).toContain('debris');
		expect(result.action?.visibility?.mode).toBe('replace');
		expect(result.action?.visibility?.returnedCount).toBe(5);
		expect(result.action?.orbits?.mode).toBe('replace');
		expect(result.action?.orbits?.returnedCount).toBe(5);
		expect(result.action?.focus?.target).toBe('earth');
		expect(createMock).toHaveBeenCalledTimes(1);
	});

	it('uses set_visibility_sql assistant_message without a followup call', async () => {
		createMock.mockResolvedValueOnce({
			id: 'resp_1',
			output: [
				{
					type: 'function_call',
						name: 'set_visibility_sql',
						call_id: 'call_fast_2',
						arguments: JSON.stringify({
							sql: "SELECT norad_cat_id FROM semantic_satcat WHERE object_type LIKE '%DEBRIS%' LIMIT 3",
							mode: 'replace',
							id_column: 'norad_cat_id',
							assistant_message: 'Debris applied from tool message.'
						})
				}
			],
			output_text: ''
		});

		const result = await runAssist({
			messages: [{ role: 'user', content: 'show debris' }]
		});

		expect(result.assistantMessage).toBe('Debris applied from tool message.');
		expect(result.action?.visibility?.returnedCount).toBe(3);
		expect(createMock).toHaveBeenCalledTimes(1);
	});

	it('still follows up after sql_select even when text is present', async () => {
		createMock
			.mockResolvedValueOnce({
				id: 'resp_1',
				output: [
					{
						type: 'function_call',
						name: 'sql_select',
						call_id: 'call_sql_1',
						arguments: JSON.stringify({
							sql: 'SELECT norad_cat_id FROM semantic_gp ORDER BY norad_cat_id LIMIT 3'
						})
					}
				],
				output_text: 'I am checking that now.'
			})
			.mockResolvedValueOnce({
				id: 'resp_2',
				output: [],
				output_text: 'Done.'
			});

		const result = await runAssist({
			messages: [{ role: 'user', content: 'check a few ids' }]
		});

		expect(result.assistantMessage).toContain('Done');
		expect(createMock).toHaveBeenCalledTimes(2);
	});

	it('removes sql_select from the final model round and forces an action', async () => {
		let requestCount = 0;
		createMock.mockImplementation(async (request: unknown) => {
			const typed = request as { tools?: Array<{ name: string }> };
			const toolNames = (typed.tools ?? []).map((tool) => tool.name);
			if (requestCount === 0) {
				requestCount += 1;
				expect(toolNames).toContain('sql_select');
				return functionCallResponse('resp_1', [
					{
						name: 'sql_select',
						callId: 'call_sql_1',
						args: { sql: 'SELECT norad_cat_id FROM semantic_gp ORDER BY norad_cat_id LIMIT 2' }
					}
				]);
			}
			if (requestCount === 1) {
				requestCount += 1;
				expect(toolNames).toContain('sql_select');
				return functionCallResponse('resp_2', [
					{
						name: 'sql_select',
						callId: 'call_sql_2',
						args: { sql: 'SELECT norad_cat_id FROM semantic_gp ORDER BY norad_cat_id LIMIT 1' }
					}
				]);
			}
			if (requestCount === 2) {
				requestCount += 1;
				expect(toolNames).not.toContain('sql_select');
				return functionCallResponse('resp_3', [
					{
						name: 'set_visibility',
						callId: 'call_visibility_1',
						args: { mode: 'replace', norad_ids: [25544, 20580] }
					}
				]);
			}
			throw new Error('unexpected create call');
		});

		const result = await runAssist({
			messages: [{ role: 'user', content: 'analyze then act' }]
		});

		expect(result.action?.visibility?.mode).toBe('replace');
		expect(result.action?.visibility?.returnedCount).toBe(2);
		expect(createMock).toHaveBeenCalledTimes(3);
	});

	it('rejects non-SELECT SQL tool calls and leaves scene unchanged', async () => {
		createMock
			.mockResolvedValueOnce(
				functionCallResponse('resp_1', [
					{
						name: 'sql_select',
						callId: 'call_sql_1',
						args: { sql: 'DELETE FROM gp' }
					}
				])
			)
			.mockResolvedValueOnce({
				id: 'resp_2',
				output: [],
				output_text: 'I can only run read-only SELECT queries.'
			});

		const result = await runAssist({
			messages: [{ role: 'user', content: 'delete everything' }]
		});

		expect(result.action).toBeNull();
		expect(result.assistantMessage).toContain('read-only SELECT');
		expect(createMock).toHaveBeenCalledTimes(2);
	});

	it('sends mixed chat history in easy message format for responses input', async () => {
		createMock.mockResolvedValueOnce({
			id: 'resp_1',
			output: [],
			output_text: 'No action.'
		});

		await runAssist({
			messages: [
				{ role: 'user', content: 'hello' },
				{ role: 'assistant', content: 'hi there' },
				{ role: 'user', content: 'what share of objects are debris?' }
			]
		});

		expect(createMock).toHaveBeenCalledTimes(1);
		const request = createMock.mock.calls[0][0] as { input: unknown };
		expect(request.input).toEqual([
			{ role: 'user', content: 'hello' },
			{ role: 'assistant', content: 'hi there' },
			{ role: 'user', content: 'what share of objects are debris?' }
		]);
	});
});
