// src/routes/oracle/+page.server.ts
import * as db from '$lib/server/database.server';
import type { PageServerLoad } from './$types';

export const load: PageServerLoad = async () => {
    const data = await db.getSceneData();
    return { sceneData: data };
};