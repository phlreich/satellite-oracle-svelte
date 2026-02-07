import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { guardReadOnlySql } from '../../src/lib/server/assist/sqlGuard';

const DB_PATH = path.join(process.cwd(), 'src/data/satellite.db');

describe('guardReadOnlySql', () => {
	it('accepts read-only queries, including CTEs and string literals with SQL keywords', () => {
		const cte = guardReadOnlySql(
			'WITH ranked AS (SELECT NORAD_CAT_ID FROM gp LIMIT 5) SELECT * FROM ranked',
			DB_PATH
		);
		const keywordLiteral = guardReadOnlySql("SELECT 'drop table gp' AS note", DB_PATH);

		expect(cte.ok).toBe(true);
		expect(keywordLiteral.ok).toBe(true);
	});

	it('rejects pragma and attach statements', () => {
		const pragma = guardReadOnlySql('PRAGMA user_version', DB_PATH);
		const attach = guardReadOnlySql("ATTACH DATABASE '/tmp/evil.db' AS evil", DB_PATH);

		expect(pragma.ok).toBe(false);
		expect(attach.ok).toBe(false);
	});

	it('rejects blocked functions and multi-statement SQL', () => {
		const blockedFunction = guardReadOnlySql("SELECT load_extension('x')", DB_PATH);
		const multi = guardReadOnlySql('SELECT 1; SELECT 2', DB_PATH);

		expect(blockedFunction.ok).toBe(false);
		expect(multi.ok).toBe(false);
	});
});
