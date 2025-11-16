// svelte.config.js
import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const dev = process.env.NODE_ENV === 'development';
const baseFromEnv = process.env.APP_BASE_PATH ?? '/satellite-oracle';
const sanitizeBase = (value) => {
	if (!value || value === '/') return '';
	return `/${value.replace(/^\/+|\/+$/g, '')}`;
};
const normalizedBase = sanitizeBase(baseFromEnv);

/** @type {import('@sveltejs/kit').Config} */
const config = {
	// Consult https://kit.svelte.dev/docs/integrations#preprocessors
	// for more information about preprocessors
	preprocess: vitePreprocess(),

	kit: {
		adapter: adapter(),
		paths: {
			base: dev ? '' : normalizedBase
		}
	}
};

export default config;
