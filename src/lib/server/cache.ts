// src/lib/server/cache.ts
import { createLogger } from './logger';

type SceneData = Array<[string, string, string, number, string]>;

let cache: { sceneData: SceneData | null; lastUpdated: number } = {
	sceneData: null,
	lastUpdated: 0
};
const cacheLogger = createLogger('server.cache');

export function getCache() {
	return cache;
}

export function setCache(data: SceneData) {
	cache = {
		sceneData: data,
		lastUpdated: Date.now()
	};
	cacheLogger.info('cache updated', { rowCount: data.length, lastUpdated: cache.lastUpdated });
}
