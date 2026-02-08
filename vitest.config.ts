import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vitest/config';

export default defineConfig({
	plugins: [sveltekit()],
	test: {
		environment: 'node',
		globals: true,
		include: ['tests/**/*.test.ts'],
		setupFiles: ['tests/setup/no-network.ts'],
		clearMocks: true,
		restoreMocks: true
	}
});
