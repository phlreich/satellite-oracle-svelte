import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { runAssist } from '$lib/server/assist/assistant';
import type { AssistRequestBody } from '$lib/server/assist/types';
import { createLogger, serializeError } from '$lib/server/logger';
import { waitForStartupInitialization } from '$lib/server/startup.server';

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
	if (body.sceneContext !== undefined && body.sceneContext !== null) {
		if (typeof body.sceneContext !== 'object' || Array.isArray(body.sceneContext)) {
			return false;
		}
	}
	return true;
}

export const POST: RequestHandler = async ({ request, locals, url }) => {
	const localsRecord = (locals ?? {}) as Record<string, unknown>;
	const path = url?.pathname ?? '/api/assist';
	const requestId =
		typeof localsRecord.requestId === 'string' ? (localsRecord.requestId as string) : 'unknown';
	const logger = createLogger('assist.api', { requestId, path });
	await waitForStartupInitialization();

	const contentLength = request.headers.get('content-length');
	logger.info('assist request received', { contentLength: contentLength ?? 'unknown' });
	if (contentLength && Number(contentLength) > MAX_REQUEST_BYTES) {
		logger.warn('assist request rejected: payload too large', { contentLength });
		return json({ error: 'Request too large' }, { status: 413 });
	}

	let parsedBody: unknown;
	try {
		parsedBody = await request.json();
	} catch (error) {
		logger.warn('assist request rejected: invalid json', { error: serializeError(error) });
		return json({ error: 'Invalid JSON body' }, { status: 400 });
	}

	if (!isValidBody(parsedBody)) {
		logger.warn('assist request rejected: invalid body shape');
		return json({ error: 'Invalid assist request body' }, { status: 400 });
	}

	try {
		const body = parsedBody as AssistRequestBody;
		const latestUserMessage =
			body.messages
				.slice()
				.reverse()
				.find((message) => message.role === 'user')
				?.content.slice(0, 180) ?? '';
		logger.info('assist request accepted', {
			messageCount: body.messages.length,
			sceneSelectedNoradId:
				typeof body.sceneContext?.selectedNoradId === 'number'
					? body.sceneContext.selectedNoradId
					: null,
			latestUserMessage,
			sceneVisibleCount:
				typeof body.sceneContext?.visibleCount === 'number' ? body.sceneContext.visibleCount : null,
			selectedInfoPanel:
				typeof body.sceneContext?.selectedInfoPanel === 'string'
					? body.sceneContext.selectedInfoPanel
					: null
		});

		const result = await runAssist(body, { requestId });
		logger.info('assist request completed', {
			hasAction: result.action !== null,
			visibilityMode: result.action?.visibility?.mode ?? null,
			visibilityCount: result.action?.visibility?.returnedCount ?? null,
			focusTarget: result.action?.focus?.target ?? null
		});
		return json(result);
	} catch (error) {
		logger.error('assist request failed', { error: serializeError(error) });
		return json({
			assistantMessage:
				'The assistant ran into a backend error while processing that request. Please try again. No scene change was applied.',
			action: null
		});
	}
};
