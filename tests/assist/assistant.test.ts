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

function plannerResponse(id: string, plan: Record<string, unknown>) {
	return {
		id,
		output: [
			{
				type: 'function_call',
				name: 'propose_assist_plan',
				call_id: 'call_plan_1',
				arguments: JSON.stringify(plan)
			}
		],
		output_text: ''
	};
}

describe('runAssist planner/executor behavior', () => {
	beforeEach(() => {
		createMock.mockReset();
	});

	it('executes count plans deterministically without scene mutation', async () => {
		createMock.mockResolvedValueOnce(
			plannerResponse('resp_plan_1', {
				kind: 'count',
				query: {
					queryType: 'count',
					filters: [
						{ field: 'country_code', op: 'eq', value: 'germany' },
						{ field: 'object_type', op: 'eq', value: 'payload' }
					]
				}
			})
		);

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
			name: 'propose_assist_plan'
		});
	});

	it('executes view-update plans and returns structured action', async () => {
		createMock.mockResolvedValueOnce(
			plannerResponse('resp_plan_2', {
				kind: 'view_update',
				query: {
					queryType: 'select',
					mode: 'replace',
					limit: 3,
					filters: [{ field: 'object_name', op: 'contains', value: 'starlink' }]
				}
			})
		);

		const result = await runAssist({
			messages: [{ role: 'user', content: 'show all starlink satellites' }],
			sceneContext: { visibleNoradIds: [25544], visibleCount: 250 }
		});

		expect(result.action).not.toBeNull();
		expect(result.action?.mode).toBe('replace');
		expect(result.action?.returnedCount).toBe(3);
		expect(result.action?.noradCatIds.length).toBe(3);
		expect(result.assistantMessage).toContain('Scene mode: replace.');
	});

	it('executes selected-object explanation plans without scene mutation', async () => {
		createMock.mockResolvedValueOnce(
			plannerResponse('resp_plan_3', {
				kind: 'explain_selected'
			})
		);

		const result = await runAssist({
			messages: [{ role: 'user', content: 'why is this orbit so high up?' }],
			sceneContext: { selectedNoradId: 25544, visibleNoradIds: [25544], visibleCount: 1 }
		});

		expect(result.action).toBeNull();
		expect(result.assistantMessage).toContain('Selected object:');
		expect(result.assistantMessage).toContain('No scene change was applied.');
	});

	it('ignores previous_response_id when invoking planner requests', async () => {
		createMock.mockResolvedValueOnce(
			plannerResponse('resp_plan_4', {
				kind: 'clarify',
				question: 'What would you like me to filter or count?'
			})
		);

		const result = await runAssist({
			messages: [{ role: 'user', content: 'hey there' }],
			previousResponseId: 'resp_invalid'
		});

		expect(createMock).toHaveBeenCalledTimes(1);
		expect(createMock.mock.calls[0][0].previous_response_id).toBeUndefined();
		expect(result.assistantMessage).toContain('What would you like me to filter or count?');
	});

	it('blocks scene mutations for ambiguous single-target object-name matches', async () => {
		createMock.mockResolvedValueOnce(
			plannerResponse('resp_plan_5', {
				kind: 'view_update',
				query: {
					queryType: 'select',
					mode: 'replace',
					limit: 1,
					filters: [{ field: 'object_name', op: 'contains', value: 'ume' }]
				}
			})
		);

		const result = await runAssist({
			messages: [{ role: 'user', content: 'show me the ume object' }]
		});

		expect(result.action).toBeNull();
		expect(result.assistantMessage).toContain('did not change the scene');
		expect(result.assistantMessage).toContain('Closest matches:');
	});

	it('auto-disambiguates single-target matches when exactly one strong candidate exists', async () => {
		createMock.mockResolvedValueOnce(
			plannerResponse('resp_plan_6', {
				kind: 'view_update',
				query: {
					queryType: 'select',
					mode: 'replace',
					limit: 1,
					filters: [{ field: 'object_name', op: 'contains', value: 'iss' }]
				}
			})
		);

		const result = await runAssist({
			messages: [{ role: 'user', content: 'show me the iss' }]
		});

		expect(result.action).not.toBeNull();
		expect(result.action?.returnedCount).toBe(1);
		expect(result.assistantMessage).toContain('Interpreted your request as');
	});
});
