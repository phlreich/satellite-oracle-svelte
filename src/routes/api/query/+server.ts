// src/routes/api/query/+server.ts
import { runQuery } from '$lib/server/database.server';
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
	const contentLength = request.headers.get('content-length');
	if (contentLength && Number(contentLength) > 5_000) {
		return json({ error: 'Request too large' }, { status: 413 });
	}

	try {
		const requestBody = await request.json();
		if (typeof requestBody.query !== 'string') {
			return json({ error: 'query must be a string' }, { status: 400 });
		}
		if (requestBody.query.length > 2000) {
			return json({ error: 'query too long' }, { status: 400 });
		}
		const data = await runQuery(requestBody.query);
		return json(JSON.stringify(data));
	} catch (e) {
		console.error('Error parsing request body: ', e);
		return json(e, { status: 400 });
	}
};
