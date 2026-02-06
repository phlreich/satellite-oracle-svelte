import fs from 'fs/promises';
import path from 'path';
import { json } from '@sveltejs/kit';
import { getCache, setCache } from '$lib/server/cache';
import { getSceneData } from '$lib/server/database.server';
import type { RequestHandler } from './$types';

const SCENE_DATA_PATH = path.join(process.cwd(), 'src/data/scene-data.json');

export const GET: RequestHandler = async () => {
	try {
		const fileContents = await fs.readFile(SCENE_DATA_PATH, 'utf8');
		return new Response(fileContents, {
			headers: {
				'content-type': 'application/json',
				'cache-control': 'public, max-age=300'
			}
		});
	} catch {
		// Fallback used in dev startup races before artifacts are generated.
		const cache = getCache();
		if (cache.sceneData) {
			return json(cache.sceneData, {
				headers: {
					'cache-control': 'no-store'
				}
			});
		}

		const sceneData = await getSceneData();
		setCache(sceneData);
		return json(sceneData, {
			headers: {
				'cache-control': 'no-store'
			}
		});
	}
};
