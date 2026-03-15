// vite.config.ts
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig, type Plugin } from 'vite';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { NextHandleFunction } from 'connect';

const viteServerConfig: Plugin = {
	name: 'add headers',
	configureServer: (server) => {
		const warmupStartup = () => {
			const port = server.config.server.port ?? 5173;
			const host = server.config.server.host === true ? '127.0.0.1' : server.config.server.host;
			const baseUrl = `http://${host ?? '127.0.0.1'}:${port}`;
			void fetch(`${baseUrl}/health`).catch(() => {});
		};
		server.httpServer?.once('listening', warmupStartup);

		server.middlewares.use(
			(req: IncomingMessage, res: ServerResponse, next: NextHandleFunction) => {
				res.setHeader('Access-Control-Allow-Origin', '*');
				res.setHeader('Access-Control-Allow-Methods', 'GET');
				res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
				res.setHeader('Cross-Origin-Embedder-Policy', 'require-corp');
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
