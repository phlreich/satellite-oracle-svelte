// src/hooks.server.ts
import { initializeDatabaseAndSetCache, refreshData } from '$lib/server/database.server';
import { scheduleJob } from 'node-schedule';

initializeDatabaseAndSetCache();

const job = scheduleJob('38 1 * * *', async function () {
    refreshData();
});