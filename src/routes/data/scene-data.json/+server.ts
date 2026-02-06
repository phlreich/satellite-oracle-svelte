import fs from 'fs/promises';
import path from 'path';
import { json } from '@sveltejs/kit';
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
	} catch (error) {
		return json(
			{ error: 'Scene data artifact not available', details: String(error) },
			{ status: 503 }
		);
	}
};
