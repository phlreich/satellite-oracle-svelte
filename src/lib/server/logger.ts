import crypto from 'node:crypto';

type LogLevel = 'debug' | 'info' | 'warn' | 'error';
type LogMeta = Record<string, unknown>;

const LEVEL_WEIGHT: Record<LogLevel, number> = {
	debug: 10,
	info: 20,
	warn: 30,
	error: 40
};

const configuredLevel = (() => {
	const defaultLevel = process.env.NODE_ENV === 'test' ? 'warn' : 'info';
	const raw = (process.env.LOG_LEVEL ?? defaultLevel).toLowerCase().trim();
	if (raw === 'debug' || raw === 'info' || raw === 'warn' || raw === 'error') {
		return raw;
	}
	return 'info';
})();

const useJson =
	(process.env.LOG_FORMAT ?? '').toLowerCase().trim() === 'json' ||
	process.env.NODE_ENV === 'production';

function shouldLog(level: LogLevel): boolean {
	return LEVEL_WEIGHT[level] >= LEVEL_WEIGHT[configuredLevel as LogLevel];
}

function serializeMeta(meta?: LogMeta): LogMeta | undefined {
	if (!meta) {
		return undefined;
	}
	const out: LogMeta = {};
	for (const [key, value] of Object.entries(meta)) {
		if (value instanceof Error) {
			out[key] = serializeError(value);
			continue;
		}
		out[key] = value;
	}
	return out;
}

function prettyFormat(scope: string, level: LogLevel, message: string, meta?: LogMeta): string {
	const ts = new Date().toISOString();
	const tag = `${ts} ${level.toUpperCase()} ${scope}`;
	if (!meta || Object.keys(meta).length === 0) {
		return `[${tag}] ${message}`;
	}
	return `[${tag}] ${message} ${JSON.stringify(meta)}`;
}

function write(scope: string, level: LogLevel, message: string, meta?: LogMeta) {
	if (!shouldLog(level)) {
		return;
	}
	const serializedMeta = serializeMeta(meta);
	if (useJson) {
		const entry = {
			timestamp: new Date().toISOString(),
			level,
			scope,
			message,
			...(serializedMeta ?? {})
		};
		process.stdout.write(`${JSON.stringify(entry)}\n`);
		return;
	}
	process.stdout.write(`${prettyFormat(scope, level, message, serializedMeta)}\n`);
}

export function serializeError(error: unknown): LogMeta {
	if (error instanceof Error) {
		return {
			name: error.name,
			message: error.message,
			stack: error.stack
		};
	}
	if (typeof error === 'object' && error !== null) {
		return { ...(error as Record<string, unknown>) };
	}
	return { message: String(error) };
}

export function newRequestId(): string {
	return crypto.randomUUID();
}

export function createLogger(scope: string, baseMeta?: LogMeta) {
	const mergeMeta = (meta?: LogMeta): LogMeta | undefined => {
		if (!baseMeta && !meta) {
			return undefined;
		}
		return {
			...(baseMeta ?? {}),
			...(meta ?? {})
		};
	};

	return {
		scope,
		child: (meta?: LogMeta) => createLogger(scope, mergeMeta(meta)),
		debug: (message: string, meta?: LogMeta) => write(scope, 'debug', message, mergeMeta(meta)),
		info: (message: string, meta?: LogMeta) => write(scope, 'info', message, mergeMeta(meta)),
		warn: (message: string, meta?: LogMeta) => write(scope, 'warn', message, mergeMeta(meta)),
		error: (message: string, meta?: LogMeta) => write(scope, 'error', message, mergeMeta(meta))
	};
}

export const appLogger = createLogger('app');
