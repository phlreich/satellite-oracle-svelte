import { defineConfig, mergeConfig } from 'vitest/config';
import viteConfig from './vite.config.ts';

export default mergeConfig(
	viteConfig,
	defineConfig({
		test: {
			environment: 'node',
			globals: true,
			include: ['tests/**/*.test.ts'],
			setupFiles: ['tests/setup/no-network.ts'],
			clearMocks: true,
			restoreMocks: true
		}
	})
);
