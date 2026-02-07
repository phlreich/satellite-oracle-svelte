import { DatabaseSync, constants } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const MAX_SQL_LENGTH = 20_000;

const ALLOWED_ACTION_CODES = new Set<number>([
	constants.SQLITE_SELECT,
	constants.SQLITE_READ,
	constants.SQLITE_FUNCTION,
	constants.SQLITE_RECURSIVE
]);

const BLOCKED_FUNCTIONS = new Set<string>(['load_extension', 'readfile', 'writefile']);

type SqlGuardOk = {
	ok: true;
	sql: string;
};

type SqlGuardError = {
	ok: false;
	error: string;
};

export type SqlGuardResult = SqlGuardOk | SqlGuardError;

function toReadonlyUri(dbPath: string): string {
	const fileUrl = pathToFileURL(dbPath);
	fileUrl.searchParams.set('mode', 'ro');
	return fileUrl.toString();
}

function hasAdditionalStatementTail(text: string): boolean {
	let index = 0;
	while (index < text.length) {
		const char = text[index];

		if (/\s/.test(char) || char === ';') {
			index += 1;
			continue;
		}

		if (char === '-' && text[index + 1] === '-') {
			index += 2;
			while (index < text.length && text[index] !== '\n') {
				index += 1;
			}
			continue;
		}

		if (char === '/' && text[index + 1] === '*') {
			const closeIndex = text.indexOf('*/', index + 2);
			if (closeIndex < 0) {
				return true;
			}
			index = closeIndex + 2;
			continue;
		}

		return true;
	}
	return false;
}

export function guardReadOnlySql(rawSql: unknown, dbPath: string): SqlGuardResult {
	if (typeof rawSql !== 'string') {
		return { ok: false, error: 'sql_select requires sql as a string.' };
	}

	const sql = rawSql.trim();
	if (sql.length === 0) {
		return { ok: false, error: 'sql_select requires a non-empty SQL string.' };
	}
	if (sql.length > MAX_SQL_LENGTH) {
		return { ok: false, error: `SQL is too long. Max length is ${MAX_SQL_LENGTH} characters.` };
	}

	let deniedAction: number | null = null;
	let deniedFunction: string | null = null;
	const db = new DatabaseSync(toReadonlyUri(dbPath));

	try {
		db.setAuthorizer((actionCode, _arg1, arg2) => {
			if (actionCode === constants.SQLITE_FUNCTION) {
				const functionName = typeof arg2 === 'string' ? arg2.toLowerCase() : '';
				if (functionName && BLOCKED_FUNCTIONS.has(functionName)) {
					deniedAction = actionCode;
					deniedFunction = functionName;
					return constants.SQLITE_DENY;
				}
			}

			if (!ALLOWED_ACTION_CODES.has(actionCode)) {
				deniedAction = actionCode;
				return constants.SQLITE_DENY;
			}

			return constants.SQLITE_OK;
		});

		const statement = db.prepare(sql);
		const trailingText = sql.slice(statement.sourceSQL.length);
		if (hasAdditionalStatementTail(trailingText)) {
			return { ok: false, error: 'sql_select only allows one SQL statement per call.' };
		}
		if (statement.columns().length === 0) {
			return { ok: false, error: 'Query must return rows.' };
		}

		return { ok: true, sql };
	} catch (error) {
		if (deniedFunction) {
			return {
				ok: false,
				error: `SQL function '${deniedFunction}' is not allowed in sql_select.`
			};
		}
		if (deniedAction !== null) {
			return { ok: false, error: 'sql_select only allows read-only query statements.' };
		}
		return {
			ok: false,
			error: error instanceof Error ? error.message : 'SQL validation failed.'
		};
	} finally {
		db.close();
	}
}
