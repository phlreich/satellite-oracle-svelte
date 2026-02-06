import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runAssist } from '$lib/server/assist/assistant';
import type { AssistRequestBody } from '$lib/server/assist/types';

const MAX_REQUEST_BYTES = 50_000;
const MAX_MESSAGES = 40;

function isValidBody(value: unknown): value is AssistRequestBody {
	if (typeof value !== 'object' || value === null) {
		return false;
	}
	const body = value as Record<string, unknown>;
	if (
		!Array.isArray(body.messages) ||
		body.messages.length === 0 ||
		body.messages.length > MAX_MESSAGES
	) {
		return false;
	}
	for (const message of body.messages) {
		if (typeof message !== 'object' || message === null) {
			return false;
		}
		const typed = message as Record<string, unknown>;
		if (typed.role !== 'user' && typed.role !== 'assistant') {
			return false;
		}
		if (typeof typed.content !== 'string' || typed.content.trim() === '') {
			return false;
		}
	}
	if (body.previousResponseId !== undefined && body.previousResponseId !== null) {
		if (typeof body.previousResponseId !== 'string') {
			return false;
		}
	}
	if (body.sceneContext !== undefined && body.sceneContext !== null) {
		if (typeof body.sceneContext !== 'object' || Array.isArray(body.sceneContext)) {
			return false;
		}
	}
	return true;
}

export const POST: RequestHandler = async ({ request }) => {
	const contentLength = request.headers.get('content-length');
	if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) {
		return json({ error: 'Request too large' }, { status: 413 });
	}

	let parsedBody: unknown;
	try {
		parsedBody = await request.json();
	} catch {
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	if (!isValidBody(parsedBody)) {
		return json({ error: 'Invalid assist request body' }, { status: 400 });
	}

	try {
		const result = await runAssist(parsedBody);
		return json(result);
	} catch (error) {
		console.error('Assist API error:', error);
		return json({
			assistantMessage:
				'The assistant ran into a backend error while processing that request. Please try again. No scene change was applied.',
			action: null,
			responseId: null
		});
	}
};
