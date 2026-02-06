import Database from 'better-sqlite3';
import path from 'path';
import type {
	CatalogFilter,
	CatalogFilterField,
	CatalogFilterOp,
	CatalogQueryResult,
	ObjectDetails
} from './types';

const DB_PATH = path.join(process.cwd(), 'src/data/satellite.db');
const MAX_FILTERS = 12;
const MAX_LIMIT = 10000;
const DEFAULT_LIMIT = 2500;

const db = new Database(DB_PATH);
db.pragma('busy_timeout = 5000');

const COUNTRY_ALIASES: Record<string, string[]> = {
	german: ['GER'],
	germany: ['GER'],
	de: ['GER'],
	deu: ['GER'],
	us: ['US', 'USBZ'],
	usa: ['US', 'USBZ'],
	united_states: ['US', 'USBZ'],
	china: ['PRC', 'CHLE', 'CHTU', 'CHBZ', 'PRES']
};

const OBJECT_TYPE_ALIASES: Record<string, string> = {
	payload: 'PAYLOAD',
	satellite: 'PAYLOAD',
	satellites: 'PAYLOAD',
	debris: 'DEBRIS',
	'rocket body': 'ROCKET BODY',
	rocket: 'ROCKET BODY',
	unknown: 'UNKNOWN'
};

const FIELD_SQL: Record<CatalogFilterField, string> = {
	norad_cat_id: 'gp.NORAD_CAT_ID',
	object_name: "COALESCE(NULLIF(satcat.OBJECT_NAME, ''), gp.OBJECT_NAME, '')",
	object_type: "COALESCE(NULLIF(satcat.OBJECT_TYPE, ''), gp.OBJECT_TYPE, '')",
	country_code: "UPPER(COALESCE(NULLIF(gp.COUNTRY_CODE, ''), satcat.COUNTRY, ''))",
	launch_year: "CAST(strftime('%Y', COALESCE(gp.LAUNCH_DATE, satcat.LAUNCH)) AS INTEGER)",
	apogee_km: 'gp.APOAPSIS',
	perigee_km: 'gp.PERIAPSIS',
	period_minutes: 'COALESCE(gp.PERIOD, satcat.PERIOD)',
	inclination_deg: 'COALESCE(gp.INCLINATION, satcat.INCLINATION)'
};
const ALLOWED_FILTER_OPS: CatalogFilterOp[] = [
	'eq',
	'neq',
	'contains',
	'in',
	'gt',
	'gte',
	'lt',
	'lte'
];

function toNumberOrNull(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
		return Number(value);
	}
	return null;
}

function normalizeCountryValues(values: Array<string | number>): string[] {
	const expanded = values.flatMap((raw) => {
		const rawText = String(raw).trim();
		const key = rawText.toLowerCase().replace(/\s+/g, '_');
		if (COUNTRY_ALIASES[key]) {
			return COUNTRY_ALIASES[key];
		}
		if (rawText.length === 0) {
			return [];
		}
		return [rawText.toUpperCase()];
	});
	return [...new Set(expanded)];
}

function toScalarOrUndefined(value: unknown): string | number | undefined {
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	return undefined;
}

function canonicalizeObjectTypeValue(value: string | number): string {
	const text = String(value).trim();
	if (text.length === 0) {
		return text;
	}
	const key = text.toLowerCase().replace(/\s+/g, ' ');
	return OBJECT_TYPE_ALIASES[key] ?? text.toUpperCase();
}

function shouldTreatCountryContainsAsEq(value: string | number): boolean {
	const text = String(value).trim().toLowerCase().replace(/\s+/g, '_');
	if (COUNTRY_ALIASES[text]) {
		return true;
	}
	return /^[a-z]{2,4}$/.test(text);
}

function validateFilters(filters: unknown): CatalogFilter[] {
	if (!Array.isArray(filters)) {
		throw new Error('filters must be an array');
	}
	if (filters.length > MAX_FILTERS) {
		throw new Error(`at most ${MAX_FILTERS} filters are allowed`);
	}

	return filters.map((filter, index) => {
		if (typeof filter !== 'object' || filter === null) {
			throw new Error(`filter at index ${index} must be an object`);
		}
		const typed = filter as Record<string, unknown>;
		const field = typed.field;
		let op = typed.op;
		if (typeof field !== 'string' || !(field in FIELD_SQL)) {
			throw new Error(`unsupported filter field at index ${index}`);
		}
		if (typeof op !== 'string' || !ALLOWED_FILTER_OPS.includes(op as CatalogFilterOp)) {
			throw new Error(`unsupported filter op at index ${index}`);
		}
		let value = toScalarOrUndefined(typed.value);
		let values = Array.isArray(typed.values)
			? typed.values.filter(
					(item): item is string | number => toScalarOrUndefined(item) !== undefined
				)
			: undefined;

		if (field === 'country_code' && op === 'contains' && value !== undefined) {
			if (shouldTreatCountryContainsAsEq(value)) {
				op = 'eq';
			}
		}

		if (field === 'object_type') {
			if (value !== undefined && (op === 'eq' || op === 'contains')) {
				value = canonicalizeObjectTypeValue(value);
				if (op === 'contains') {
					op = 'eq';
				}
			}
			if (Array.isArray(values) && values.length > 0) {
				values = values.map((candidate) => canonicalizeObjectTypeValue(candidate));
			}
		}

		return {
			field: field as CatalogFilterField,
			op: op as CatalogFilterOp,
			value,
			values
		};
	});
}

function buildWhere(filters: CatalogFilter[]) {
	const clauses: string[] = [];
	const params: Record<string, string | number> = {};

	for (let i = 0; i < filters.length; i++) {
		const filter = filters[i];
		const sqlField = FIELD_SQL[filter.field];
		const paramBase = `f${i}`;

		if (filter.op === 'in') {
			const rawValues = filter.values && filter.values.length > 0 ? filter.values : [];
			const normalizedValues =
				filter.field === 'country_code'
					? normalizeCountryValues(rawValues)
					: rawValues.map((value) => String(value).trim()).filter((value) => value.length > 0);
			if (normalizedValues.length === 0) {
				throw new Error(`filter ${i} uses 'in' but no values were provided`);
			}
			const placeholders = normalizedValues.map((value, valueIndex) => {
				const key = `${paramBase}_${valueIndex}`;
				params[key] = value;
				return `@${key}`;
			});
			clauses.push(`${sqlField} IN (${placeholders.join(', ')})`);
			continue;
		}

		if (filter.value === undefined || String(filter.value).trim() === '') {
			throw new Error(`filter ${i} is missing value`);
		}

		if (filter.field === 'country_code') {
			const countryValues = normalizeCountryValues([filter.value]);
			if (countryValues.length > 1) {
				const placeholders = countryValues.map((value, valueIndex) => {
					const key = `${paramBase}_${valueIndex}`;
					params[key] = value;
					return `@${key}`;
				});
				if (filter.op === 'eq') {
					clauses.push(`${sqlField} IN (${placeholders.join(', ')})`);
					continue;
				}
				if (filter.op === 'neq') {
					clauses.push(`${sqlField} NOT IN (${placeholders.join(', ')})`);
					continue;
				}
			}
			if (countryValues.length === 1 && (filter.op === 'eq' || filter.op === 'neq')) {
				const key = `${paramBase}_value`;
				params[key] = countryValues[0];
				if (filter.op === 'eq') {
					clauses.push(`${sqlField} = @${key}`);
				} else {
					clauses.push(`${sqlField} != @${key}`);
				}
				continue;
			}
		}

		const key = `${paramBase}_value`;
		const scalarValue = filter.value;
		const numberCandidate = toNumberOrNull(scalarValue);
		if (numberCandidate !== null && ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'].includes(filter.op)) {
			params[key] = numberCandidate;
		} else {
			params[key] = String(scalarValue);
		}

		switch (filter.op) {
			case 'eq':
				clauses.push(`${sqlField} = @${key}`);
				break;
			case 'neq':
				clauses.push(`${sqlField} != @${key}`);
				break;
			case 'contains':
				params[key] = `%${String(params[key]).toLowerCase()}%`;
				clauses.push(`LOWER(${sqlField}) LIKE @${key}`);
				break;
			case 'gt':
				clauses.push(`${sqlField} > @${key}`);
				break;
			case 'gte':
				clauses.push(`${sqlField} >= @${key}`);
				break;
			case 'lt':
				clauses.push(`${sqlField} < @${key}`);
				break;
			case 'lte':
				clauses.push(`${sqlField} <= @${key}`);
				break;
			default:
				throw new Error(`Unsupported operator ${filter.op}`);
		}
	}

	return {
		whereSql: clauses.length > 0 ? clauses.join(' AND ') : '1 = 1',
		params
	};
}

function summarizeFilters(filters: CatalogFilter[]) {
	if (filters.length === 0) {
		return 'no filters';
	}
	return filters
		.map((filter) => {
			if (filter.op === 'in') {
				return `${filter.field} in [${(filter.values ?? []).join(', ')}]`;
			}
			return `${filter.field} ${filter.op} ${filter.value ?? ''}`;
		})
		.join(' AND ');
}

const FROM_SQL = 'FROM gp INNER JOIN satcat ON satcat.NORAD_CAT_ID = gp.NORAD_CAT_ID';

export function runCatalogQuery(rawSpec: unknown): CatalogQueryResult {
	if (typeof rawSpec !== 'object' || rawSpec === null) {
		throw new Error('query spec must be an object');
	}
	const spec = rawSpec as Record<string, unknown>;
	const queryType = spec.queryType === 'count' ? 'count' : 'select';
	const mode = spec.mode === 'add' || spec.mode === 'remove' ? spec.mode : 'replace';
	const limitRaw = Number(spec.limit ?? DEFAULT_LIMIT);
	const limit = Math.max(
		1,
		Math.min(MAX_LIMIT, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : DEFAULT_LIMIT)
	);
	const filters = validateFilters(spec.filters ?? []);

	const { whereSql, params } = buildWhere(filters);

	const countRow = db
		.prepare(`SELECT COUNT(*) as count ${FROM_SQL} WHERE ${whereSql}`)
		.get(params) as { count: number };
	const totalCount = countRow.count;

	if (queryType === 'count') {
		return {
			queryType,
			mode,
			totalCount,
			returnedCount: 0,
			noradCatIds: [],
			sample: [],
			filterSummary: summarizeFilters(filters)
		};
	}

	const rows = db
		.prepare(
			`SELECT
				gp.NORAD_CAT_ID as norad_cat_id,
				COALESCE(NULLIF(satcat.OBJECT_NAME, ''), gp.OBJECT_NAME, '') as object_name,
				COALESCE(NULLIF(satcat.OBJECT_TYPE, ''), gp.OBJECT_TYPE, '') as object_type,
				UPPER(COALESCE(NULLIF(gp.COUNTRY_CODE, ''), satcat.COUNTRY, '')) as country_code,
				CAST(strftime('%Y', COALESCE(gp.LAUNCH_DATE, satcat.LAUNCH)) AS INTEGER) as launch_year,
				gp.APOAPSIS as apogee_km,
				gp.PERIAPSIS as perigee_km,
				COALESCE(gp.PERIOD, satcat.PERIOD) as period_minutes,
				COALESCE(gp.INCLINATION, satcat.INCLINATION) as inclination_deg
			${FROM_SQL}
			WHERE ${whereSql}
			ORDER BY gp.NORAD_CAT_ID ASC
			LIMIT @limit`
		)
		.all({ ...params, limit }) as Array<{
		norad_cat_id: number;
		object_name: string;
		object_type: string;
		country_code: string;
		launch_year: number | null;
		apogee_km: number | null;
		perigee_km: number | null;
		period_minutes: number | null;
		inclination_deg: number | null;
	}>;

	const sample = rows.slice(0, 10).map((row) => ({
		noradCatId: row.norad_cat_id,
		objectName: row.object_name,
		objectType: row.object_type,
		countryCode: row.country_code,
		launchYear: row.launch_year,
		apogeeKm: row.apogee_km,
		perigeeKm: row.perigee_km,
		periodMinutes: row.period_minutes,
		inclinationDeg: row.inclination_deg
	}));

	return {
		queryType,
		mode,
		totalCount,
		returnedCount: rows.length,
		noradCatIds: rows.map((row) => row.norad_cat_id),
		sample,
		filterSummary: summarizeFilters(filters)
	};
}

export function getObjectDetails(noradCatId: number): ObjectDetails | null {
	if (!Number.isInteger(noradCatId) || noradCatId <= 0) {
		throw new Error('norad_cat_id must be a positive integer');
	}
	const row = db
		.prepare(
			`SELECT
				gp.NORAD_CAT_ID as norad_cat_id,
				COALESCE(NULLIF(satcat.OBJECT_NAME, ''), gp.OBJECT_NAME, '') as object_name,
				COALESCE(NULLIF(satcat.OBJECT_TYPE, ''), gp.OBJECT_TYPE, '') as object_type,
				UPPER(COALESCE(NULLIF(gp.COUNTRY_CODE, ''), satcat.COUNTRY, '')) as country_code,
				CAST(strftime('%Y', COALESCE(gp.LAUNCH_DATE, satcat.LAUNCH)) AS INTEGER) as launch_year,
				gp.APOAPSIS as apogee_km,
				gp.PERIAPSIS as perigee_km,
				COALESCE(gp.PERIOD, satcat.PERIOD) as period_minutes,
				COALESCE(gp.INCLINATION, satcat.INCLINATION) as inclination_deg,
				gp.EPOCH as epoch,
				gp.TLE_LINE1 as tle_line1,
				gp.TLE_LINE2 as tle_line2
			${FROM_SQL}
			WHERE gp.NORAD_CAT_ID = @noradCatId
			LIMIT 1`
		)
		.get({ noradCatId }) as
		| {
				norad_cat_id: number;
				object_name: string;
				object_type: string;
				country_code: string;
				launch_year: number | null;
				apogee_km: number | null;
				perigee_km: number | null;
				period_minutes: number | null;
				inclination_deg: number | null;
				epoch: string | null;
				tle_line1: string | null;
				tle_line2: string | null;
		  }
		| undefined;

	if (!row) {
		return null;
	}

	return {
		noradCatId: row.norad_cat_id,
		objectName: row.object_name,
		objectType: row.object_type,
		countryCode: row.country_code,
		launchYear: row.launch_year,
		apogeeKm: row.apogee_km,
		perigeeKm: row.perigee_km,
		periodMinutes: row.period_minutes,
		inclinationDeg: row.inclination_deg,
		epoch: row.epoch,
		tleLine1: row.tle_line1,
		tleLine2: row.tle_line2
	};
}
