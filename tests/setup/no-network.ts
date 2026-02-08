import { beforeEach, vi } from 'vitest';

beforeEach(() => {
	vi.stubGlobal('fetch', ((input: string | URL | Request) => {
		const url =
			typeof input === 'string'
				? input
				: input instanceof URL
					? input.href
					: input.url;
		throw new Error(`Unexpected network call during test: ${url}`);
	}) as typeof fetch);
});
