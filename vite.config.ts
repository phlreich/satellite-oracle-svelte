// vite.config.ts
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NextHandleFunction } from 'connect';

const viteServerConfig: Plugin = {
	name: 'add headers',
	configureServer: (server) => {
		server.middlewares.use(
			(req: IncomingMessage, res: ServerResponse, next: NextHandleFunction) => {
				res.setHeader('Access-Control-Allow-Origin', '*');
				res.setHeader('Access-Control-Allow-Methods', 'GET');
				res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
				res.setHeader('Cross-Origin-Embedder-Policy', 'credentialless');
				next();
			}
		);
	}
};

export default defineConfig({
	plugins: [viteServerConfig, sveltekit()],
	server: {
		hmr: false // Disable HMR completely
	}
});
