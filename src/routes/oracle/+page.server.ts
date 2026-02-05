// src/routes/oracle/+page.server.ts

import * as db from '$lib/server/database.server';
import { getCache, setCache } from '$lib/server/cache';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
	// const startTime = performance.now();
	const cache = getCache();

	if (!cache.sceneData) {
		const data = await db.getSceneData();
		setCache(data);
		// const endTime = performance.now();
		// console.log(`No cache found, retrieved data from database - data retrieval took ${endTime - startTime} milliseconds`);
		return { sceneData: data };
	}
	// const endTime = performance.now();
	// console.log(`Used cache - data retrieval took ${endTime - startTime} milliseconds`);

	return { sceneData: cache.sceneData };
};
