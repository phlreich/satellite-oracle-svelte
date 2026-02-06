// src/routes/oracle/+page.server.ts

import * as db from '$lib/server/database.server';
import { getCache, setCache } from '$lib/server/cache';
import fs from 'fs';
import path from 'path';
import type { PageServerLoad } from './$types';

const SCENE_DATA_PATH = path.join(process.cwd(), 'src/data/scene-data.json');

export const load: PageServerLoad = async () => {
	// Prefer static scene-data artifact; fallback to DB-backed payload if it is missing.
	if (fs.existsSync(SCENE_DATA_PATH)) {
		return { sceneData: null };
	}

	const cache = getCache();

	if (!cache.sceneData) {
		const data = await db.getSceneData();
		setCache(data);
		return { sceneData: data };
	}

	return { sceneData: cache.sceneData };
};
