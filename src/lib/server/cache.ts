// src/lib/server/cache.ts
type SceneData = Array<[string, string, string, number, string]>;

let cache: { sceneData: SceneData | null; lastUpdated: number } = {
	sceneData: null,
	lastUpdated: 0
};

export function getCache() {
	return cache;
}

export function setCache(data: SceneData) {
	cache = {
		sceneData: data,
		lastUpdated: Date.now()
	};
	console.log('Cache updated');
}
