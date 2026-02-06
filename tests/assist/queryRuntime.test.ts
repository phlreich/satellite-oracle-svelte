import { describe, expect, it } from 'vitest';
import { runCatalogQuery } from '../../src/lib/server/assist/queryRuntime';

function runCount(
	filters: Array<{
		field:
			| 'norad_cat_id'
			| 'object_name'
			| 'object_type'
			| 'country_code'
			| 'launch_year'
			| 'apogee_km'
			| 'perigee_km'
			| 'period_minutes'
			| 'inclination_deg';
		op: 'eq' | 'neq' | 'contains' | 'in' | 'gt' | 'gte' | 'lt' | 'lte';
		value?: string | number;
		values?: Array<string | number>;
	}>
) {
	return runCatalogQuery({ queryType: 'count', filters }).totalCount;
}

describe('queryRuntime normalization', () => {
	it('maps Germany aliases to canonical GER country code', () => {
		const germanyAliasCount = runCount([
			{ field: 'country_code', op: 'eq', value: 'germany' },
			{ field: 'object_type', op: 'eq', value: 'PAYLOAD' }
		]);
		const gerCount = runCount([
			{ field: 'country_code', op: 'eq', value: 'GER' },
			{ field: 'object_type', op: 'eq', value: 'PAYLOAD' }
		]);

		expect(germanyAliasCount).toBe(gerCount);
		expect(gerCount).toBeGreaterThan(0);
	});

	it('normalizes object_type contains payload to canonical equality', () => {
		const normalizedContainsCount = runCount([
			{ field: 'country_code', op: 'eq', value: 'germany' },
			{ field: 'object_type', op: 'contains', value: 'payload' }
		]);
		const canonicalEqCount = runCount([
			{ field: 'country_code', op: 'eq', value: 'germany' },
			{ field: 'object_type', op: 'eq', value: 'PAYLOAD' }
		]);

		expect(normalizedContainsCount).toBe(canonicalEqCount);
	});

	it('accepts numeric scalar filters and matches string numeric filters', () => {
		const numericValueCount = runCount([{ field: 'launch_year', op: 'lt', value: 2000 }]);
		const stringValueCount = runCount([{ field: 'launch_year', op: 'lt', value: '2000' }]);

		expect(numericValueCount).toBe(stringValueCount);
	});
});
