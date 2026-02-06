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

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;
const RATE_LIMIT_PATH_PREFIXES = [
	'/api/assist',
	'/api/query',
	'/satellite-oracle/api/assist',
	'/satellite-oracle/api/query'
];
const rateLimitStore = new Map<string, { count: number; windowStart: number }>();

const isRateLimitedPath = (path: string) =>
	RATE_LIMIT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));

const shouldLogRequest = (path: string) =>
	path.startsWith('/api/') || path.startsWith('/satellite-oracle/api/');

const checkRateLimit = (ip: string, now: number) => {
	const entry = rateLimitStore.get(ip);
	if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
		rateLimitStore.set(ip, { count: 1, windowStart: now });
		return false;
	}

	entry.count += 1;
	return entry.count > RATE_LIMIT_MAX_REQUESTS;
};

const cleanupRateLimitStore = (now: number) => {
	for (const [ip, entry] of rateLimitStore.entries()) {
		if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
			rateLimitStore.delete(ip);
		}
	}
};

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

	if (isRateLimitedPath(path)) {
		const now = Date.now();
		cleanupRateLimitStore(now);
		const clientIp = event.getClientAddress();
		if (checkRateLimit(clientIp, now)) {
			requestLogger.warn('rate limit exceeded', { ip: clientIp });
			return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
				status: 429,
				headers: {
					'content-type': 'application/json',
					'retry-after': String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000)),
					'x-request-id': requestId
				}
			});
		}
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
