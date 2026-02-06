import { beforeEach, describe, expect, it, vi } from 'vitest';

const { runAssistMock } = vi.hoisted(() => ({
	runAssistMock: vi.fn()
}));

vi.mock('$lib/server/assist/assistant', () => ({
	runAssist: runAssistMock
}));

import { POST } from '../../src/routes/api/assist/+server';

describe('/api/assist route', () => {
	beforeEach(() => {
		runAssistMock.mockReset();
	});

	it('returns structured assistant fallback on backend errors', async () => {
		runAssistMock.mockRejectedValueOnce(new Error('upstream failure'));

		const response = await POST({
			request: new Request('http://localhost/api/assist', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					messages: [{ role: 'user', content: 'hello' }]
				})
			})
		} as never);

		expect(response.status).toBe(200);
		const body = await response.json();
		expect(body.action).toBeNull();
		expect(body.assistantMessage).toContain('backend error');
	});

	it('rejects invalid payloads with HTTP 400', async () => {
		const response = await POST({
			request: new Request('http://localhost/api/assist', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					messages: []
				})
			})
		} as never);

		expect(response.status).toBe(400);
	});
});
