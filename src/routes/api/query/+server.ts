// src/routes/api/+server.ts
import { runQuery } from "$lib/server/database.server";

export async function POST(request: Request) {
    try {
        const body = JSON.parse(await request.text());
        const { query } = body;
        const data = await runQuery(query);
        return {
            status: 200,
            body: data
        };
    } catch (e) {
        return {
            status: 500,
            body: e
        };
    }
}