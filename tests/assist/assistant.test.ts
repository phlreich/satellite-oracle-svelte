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

vi.mock('$env/static/private', () => ({ OPENAI_API_KEY: 'test-key' }));
vi.mock('$env/dynamic/private', () => ({ env: { OPENAI_ASSIST_MODEL: 'gpt-5-mini' } }));

import { runAssist } from '../../src/lib/server/assist/assistant';

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
							sql: 'SELECT NORAD_CAT_ID FROM gp ORDER BY NORAD_CAT_ID LIMIT 12',
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
			'SELECT NORAD_CAT_ID FROM gp ORDER BY NORAD_CAT_ID LIMIT 12'
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
							sql: 'SELECT NORAD_CAT_ID FROM gp ORDER BY NORAD_CAT_ID LIMIT 8',
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
		const manyIds = Array.from({ length: 400 }, (_, i) => i + 1);
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
		expect(createMock).toHaveBeenCalledTimes(2);
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
