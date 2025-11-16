// src/routes/+page.ts
import { redirect } from '@sveltejs/kit';
import { base } from '$app/paths';

export async function load() {
	redirect(302, `${base}/oracle`);
}