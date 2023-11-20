// src/routes/api/query/+server.ts
import { runQuery } from "$lib/server/database.server";
import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request }) => {
    try {
        const requestBody = await request.json();
        const data = await runQuery(requestBody.query);
        return json(JSON.stringify(data));
    } catch (e) {
        console.error('Error parsing request body: ', e);
        return json(e, { status: 400 });
    }
};
