// src/hooks.server.ts
import type { Handle } from '@sveltejs/kit';
import { initializeDatabaseAndSetCache, refreshData } from '$lib/server/database.server';
import { scheduleJob } from 'node-schedule';

initializeDatabaseAndSetCache();

const job = scheduleJob('38 1 * * *', async function () {
	refreshData();
});

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_REQUESTS = 60;
const RATE_LIMIT_PATH_PREFIXES = [
	'/api/ai-chat',
	'/api/query',
	'/satellite-oracle/api/ai-chat',
	'/satellite-oracle/api/query'
];
const rateLimitStore = new Map<string, { count: number; windowStart: number }>();

const isRateLimitedPath = (path: string) =>
	RATE_LIMIT_PATH_PREFIXES.some((prefix) => path.startsWith(prefix));

const checkRateLimit = (ip: string, now: number) => {
	const entry = rateLimitStore.get(ip);
	if (!entry || now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
		rateLimitStore.set(ip, { count: 1, windowStart: now });
		return false;
	}

	entry.count += 1;
	return entry.count > RATE_LIMIT_MAX_REQUESTS;
};

export const handle: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;
	if (isRateLimitedPath(path)) {
		const now = Date.now();
		const clientIp = event.getClientAddress();
		if (checkRateLimit(clientIp, now)) {
			return new Response(JSON.stringify({ error: 'Rate limit exceeded' }), {
				status: 429,
				headers: {
					'content-type': 'application/json',
					'retry-after': String(Math.ceil(RATE_LIMIT_WINDOW_MS / 1000))
				}
			});
		}
	}

	const response = await resolve(event);
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	response.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
	response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
	return response;
};