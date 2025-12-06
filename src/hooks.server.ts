// src/hooks.server.ts
import type { Handle } from '@sveltejs/kit';
import { initializeDatabaseAndSetCache, refreshData } from '$lib/server/database.server';
import { scheduleJob } from 'node-schedule';

initializeDatabaseAndSetCache();

const job = scheduleJob('38 1 * * *', async function () {
	refreshData();
});

export const handle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event);
	response.headers.set('Cross-Origin-Opener-Policy', 'same-origin');
	response.headers.set('Cross-Origin-Embedder-Policy', 'credentialless');
	response.headers.set('Cross-Origin-Resource-Policy', 'same-origin');
	return response;
};