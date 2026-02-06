// src/hooks.server.ts
import type { Handle } from '@sveltejs/kit';
import { initializeDatabaseAndSetCache, refreshData } from '$lib/server/database.server';
import { appLogger, newRequestId, serializeError } from '$lib/server/logger';
import { scheduleJob } from 'node-schedule';

const hooksLogger = appLogger.child({ component: 'hooks' });

void initializeDatabaseAndSetCache();
hooksLogger.info('startup initialization triggered');

scheduleJob('38 1 * * *', async function () {
	hooksLogger.info('scheduled refresh started');
	await refreshData();
	hooksLogger.info('scheduled refresh finished');
});

const shouldLogRequest = (path: string) =>
	path.startsWith('/api/') || path.startsWith('/satellite-oracle/api/');

export const handle: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;
	const requestId = newRequestId();
	(event.locals as Record<string, unknown>).requestId = requestId;
	const requestLogger = appLogger.child({
		component: 'http',
		requestId,
		method: event.request.method,
		path
	});
	const start = Date.now();
	if (shouldLogRequest(path)) {
		requestLogger.info('request started', {
			userAgent: event.request.headers.get('user-agent') ?? 'unknown',
			ip: event.getClientAddress()
		});
	}
	try {
		const response = await resolve(event);
		response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
		response.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
		response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
		response.headers.set('x-request-id', requestId);
		if (shouldLogRequest(path)) {
			requestLogger.info('request finished', {
				status: response.status,
				durationMs: Date.now() - start
			});
		}
		return response;
	} catch (error) {
		requestLogger.error('request failed', {
			durationMs: Date.now() - start,
			error: serializeError(error)
		});
		throw error;
	}
};
