const normalizeBase = (value) => {
	if (!value || value === '/') return '';
	return `/${value.replace(/^\/+|\/+$/g, '')}`;
};

const basePath = normalizeBase(process.env.APP_BASE_PATH ?? '/satellite-oracle');
const port = Number(process.env.PORT ?? 3000);
const warmupUrl = `http://127.0.0.1:${port}${basePath}/health`;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

await import('../build/index.js');

void (async () => {
	for (let attempt = 0; attempt < 40; attempt++) {
		try {
			await fetch(warmupUrl);
			return;
		} catch {
			await sleep(250);
		}
	}
})();
