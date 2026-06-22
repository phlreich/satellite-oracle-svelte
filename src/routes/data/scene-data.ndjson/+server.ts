import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { waitForStartupInitialization } from '$lib/server/startup.server';

const SCENE_DATA_NDJSON_PATH = path.join(process.cwd(), 'src/data/scene-data.ndjson');

export const GET: RequestHandler = async () => {
	try {
		await waitForStartupInitialization();
		await fs.promises.access(SCENE_DATA_NDJSON_PATH, fs.constants.R_OK);
		const fileStream = fs.createReadStream(SCENE_DATA_NDJSON_PATH, { encoding: 'utf8' });
		return new Response(Readable.toWeb(fileStream) as ReadableStream, {
			headers: {
				'content-type': 'application/x-ndjson; charset=utf-8',
				'cache-control': 'public, max-age=300'
			}
		});
	} catch (error) {
		return json(
			{ error: 'Scene NDJSON artifact not available', details: String(error) },
			{ status: 503 }
		);
	}
};
