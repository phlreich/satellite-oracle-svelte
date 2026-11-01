import { defineEnvVars } from '@sveltejs/kit/env';

// Optional runtime variables preserve the existing empty-value fallbacks.
export const variables = defineEnvVars({
	TOKEN_DW: { schema: (input) => input ?? '' },
	EMAIL: { schema: (input) => input ?? '' },
	PASSWORD: { schema: (input) => input ?? '' },
	ASSIST_TRACE: { schema: (input) => input ?? '' },
	ASSIST_LOG_FULL: { schema: (input) => input ?? '' },
	OPENAI_API_KEY: { schema: (input) => input ?? '' },
	OPENAI_ASSIST_MODEL: { schema: (input) => input ?? '' }
});
