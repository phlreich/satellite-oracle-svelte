// src/hooks.server.ts
import type { Handle } from '@sveltejs/kit';
import { dev } from '$app/environment';
import { refreshData } from '$lib/server/database.server';
import { appLogger, newRequestId, serializeError } from '$lib/server/logger';
import { triggerStartupInitialization } from '$lib/server/startup.server';
import { scheduleJob } from 'node-schedule';
import earthTextureUrl from '$lib/assets/earth.webp';

const hooksLogger = appLogger.child({ component: 'hooks' });

void triggerStartupInitialization();
hooksLogger.info('startup initialization triggered');

scheduleJob('38 1 * * *', async function () {
	hooksLogger.info('scheduled refresh started');
	await refreshData();
	hooksLogger.info('scheduled refresh finished');
});

// Keep the large Earth texture warm in Cloudflare's edge cache. On the free
// plan the edge evicts assets under LRU/memory pressure regardless of the
// 1-year immutable header, which causes the occasional "pop-in" on the first
// visit after a quiet period. Re-requesting the public (content-hashed) asset
// URL on a schedule keeps it recently-used; because the request travels out to
// Cloudflare and back through the tunnel, it warms the colo nearest this host.
const SITE_ORIGIN = process.env.PUBLIC_SITE_ORIGIN ?? 'https://phlreich.com';
const EARTH_TEXTURE_URL = new URL(earthTextureUrl, SITE_ORIGIN).href;

async function warmEdgeCache() {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 30_000);
	try {
		const response = await fetch(EARTH_TEXTURE_URL, {
			signal: controller.signal,
			headers: { 'user-agent': 'phlreich-cache-warmer' }
		});
		// Drain the body so Cloudflare fully receives and caches the object.
		await response.arrayBuffer();
		hooksLogger.info('edge cache warm', {
			url: EARTH_TEXTURE_URL,
			status: response.status,
			cfCacheStatus: response.headers.get('cf-cache-status') ?? 'unknown',
			cfRay: response.headers.get('cf-ray') ?? 'unknown'
		});
	} catch (error) {
		hooksLogger.warn('edge cache warm failed', {
			url: EARTH_TEXTURE_URL,
			error: serializeError(error)
		});
	} finally {
		clearTimeout(timeout);
	}
}

if (!dev) {
	// Warm shortly after startup (e.g. right after a deploy), then periodically.
	setTimeout(() => void warmEdgeCache(), 15_000);
	scheduleJob('*/20 * * * *', () => void warmEdgeCache());
}

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
		response.headers.set('Cross-Origin-Embedder-Policy', 'require-corp');
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
