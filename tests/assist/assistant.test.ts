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

function textResponse(id: string, outputText: string) {
	return {
		id,
		output: [],
		output_text: outputText
	};
}

function toolCallResponse(
	id: string,
	toolName: 'execute_catalog_query' | 'get_object_details' | 'scene_context',
	args: Record<string, unknown>,
	callId = 'call_1'
) {
	return {
		id,
		output: [
			{
				type: 'function_call',
				name: toolName,
				call_id: callId,
				arguments: JSON.stringify(args)
			}
		],
		output_text: ''
	};
}

describe('runAssist behavior', () => {
	beforeEach(() => {
		createMock.mockReset();
	});

	it('keeps analytical count prompts non-mutating and deterministic', async () => {
		createMock.mockResolvedValueOnce(textResponse('resp_1', 'Applied your request.'));

		const result = await runAssist({
			messages: [{ role: 'user', content: 'how many german payload objects are there?' }],
			sceneContext: { visibleNoradIds: [25544], visibleCount: 250 }
		});

		expect(result.action).toBeNull();
		expect(result.assistantMessage.startsWith('Count:')).toBe(true);
		expect(result.assistantMessage).toContain('No scene change was applied.');
		expect(createMock).toHaveBeenCalledTimes(1);
		expect(createMock.mock.calls[0][0].tool_choice).toEqual({
			type: 'function',
			name: 'execute_catalog_query'
		});
	});

	it('returns a scene action for view-update prompts when query tool is used', async () => {
		createMock
			.mockResolvedValueOnce(
				toolCallResponse('resp_1', 'execute_catalog_query', {
					queryType: 'select',
					mode: 'replace',
					limit: 3,
					filters: [{ field: 'object_name', op: 'contains', value: 'starlink' }]
				})
			)
			.mockResolvedValueOnce(textResponse('resp_2', 'Selection updated successfully.'));

		const result = await runAssist({
			messages: [{ role: 'user', content: 'show all starlink satellites' }],
			sceneContext: { visibleNoradIds: [25544], visibleCount: 250 }
		});

		expect(result.action).not.toBeNull();
		expect(result.action?.mode).toBe('replace');
		expect(result.action?.returnedCount).toBe(3);
		expect(result.action?.noradCatIds.length).toBe(3);
		expect(result.assistantMessage).toBe('Selection updated successfully.');
		expect(createMock.mock.calls[0][0].tool_choice).toBe('auto');
	});

	it('forces object-details tool first for selected-orbit explanation prompts', async () => {
		createMock
			.mockResolvedValueOnce(
				toolCallResponse('resp_1', 'get_object_details', {
					norad_cat_id: 25544
				})
			)
			.mockResolvedValueOnce(textResponse('resp_2', 'Orbit explanation.'));

		const result = await runAssist({
			messages: [{ role: 'user', content: 'why is this orbit so high up?' }],
			sceneContext: { selectedNoradId: 25544, visibleNoradIds: [25544], visibleCount: 1 }
		});

		expect(result.action).toBeNull();
		expect(createMock.mock.calls[0][0].tool_choice).toEqual({
			type: 'function',
			name: 'get_object_details'
		});
		expect(result.assistantMessage).toContain('No scene change was applied.');
	});

	it('retries once without previous_response_id when stale thread id is rejected', async () => {
		createMock
			.mockRejectedValueOnce(
				Object.assign(new Error('Invalid previous_response_id'), {
					param: 'previous_response_id'
				})
			)
			.mockResolvedValueOnce(textResponse('resp_2', 'Hello from assistant runtime.'));

		const result = await runAssist({
			messages: [{ role: 'user', content: 'hey there' }],
			previousResponseId: 'resp_invalid'
		});

		expect(createMock).toHaveBeenCalledTimes(2);
		expect(createMock.mock.calls[0][0].previous_response_id).toBe('resp_invalid');
		expect(createMock.mock.calls[1][0].previous_response_id).toBeUndefined();
		expect(result.assistantMessage).toContain('Hello from assistant runtime.');
	});
});
