import fs from 'fs/promises';
import path from 'path';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { waitForStartupInitialization } from '$lib/server/startup.server';

const SCENE_META_PATH = path.join(process.cwd(), 'src/data/scene-meta.json');

export const GET: RequestHandler = async () => {
	try {
		await waitForStartupInitialization();
		const fileContents = await fs.readFile(SCENE_META_PATH, 'utf8');
		return new Response(fileContents, {
			headers: {
				'content-type': 'application/json',
				'cache-control': 'public, max-age=300'
			}
		});
	} catch (error) {
		return json(
			{ error: 'Scene metadata artifact not available', details: String(error) },
			{ status: 503 }
		);
	}
};
