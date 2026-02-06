import Database from 'better-sqlite3';
import path from 'path';
import { createLogger } from '$lib/server/logger';
import type {
	CatalogFacetBucket,
	CatalogFacets,
	CatalogFilter,
	CatalogFilterField,
	CatalogFilterOp,
	CatalogQueryResult,
	ObjectDetails
} from './types';

const DB_PATH = path.join(process.cwd(), 'src/data/satellite.db');
const MAX_FILTERS = 12;

const db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
db.pragma('busy_timeout = 5000');
const queryLogger = createLogger('assist.query-runtime');

type DataSource = 'catalog_v2' | 'legacy';

type SourceConfig = {
	source: DataSource;
	fromSql: string;
	fieldSql: Record<CatalogFilterField, string>;
	selectSql: string;
	detailSql: string;
	facetSql: {
		objectType: string;
		countryCode: string;
		orbitClass: string;
		launchYear: string;
	};
	noradOrderSql: string;
};

function tableExists(tableName: string): boolean {
	const row = db
		.prepare("SELECT 1 as ok FROM sqlite_master WHERE type='table' AND name = @tableName LIMIT 1")
		.get({ tableName }) as { ok?: number } | undefined;
	return row?.ok === 1;
}

function buildOrbitClassSql({
	apogee,
	period,
	inclination
}: {
	apogee: string;
	period: string;
	inclination: string;
}) {
	return `
CASE
	WHEN ${period} BETWEEN 1300 AND 1600
		AND ABS(COALESCE(${inclination}, 0)) <= 25 THEN 'GEO'
	WHEN COALESCE(${apogee}, -1) >= 0
		AND COALESCE(${apogee}, 0) <= 2000 THEN 'LEO'
	WHEN COALESCE(${apogee}, -1) > 2000
		AND COALESCE(${apogee}, 0) <= 35786 THEN 'MEO'
	WHEN COALESCE(${apogee}, -1) > 35786 THEN 'HEO'
	ELSE 'UNKNOWN'
END`;
}

const CATALOG_ORBIT_CLASS_SQL = buildOrbitClassSql({
	apogee: 'catalog_v2.apogee_km',
	period: 'catalog_v2.period_minutes',
	inclination: 'catalog_v2.inclination_deg'
});

const LEGACY_ORBIT_CLASS_SQL = buildOrbitClassSql({
	apogee: 'gp.APOAPSIS',
	period: 'COALESCE(gp.PERIOD, satcat.PERIOD)',
	inclination: 'COALESCE(gp.INCLINATION, satcat.INCLINATION)'
});

function buildSourceConfig(): SourceConfig {
	if (tableExists('catalog_v2')) {
		return {
			source: 'catalog_v2',
			fromSql: 'FROM catalog_v2',
			fieldSql: {
				norad_cat_id: 'catalog_v2.norad_cat_id',
				object_name: "COALESCE(catalog_v2.object_name, '')",
				object_type: "UPPER(COALESCE(catalog_v2.object_type, ''))",
				country_code: "UPPER(COALESCE(catalog_v2.country_code, ''))",
				launch_year: 'catalog_v2.launch_year',
				apogee_km: 'catalog_v2.apogee_km',
				perigee_km: 'catalog_v2.perigee_km',
				period_minutes: 'catalog_v2.period_minutes',
				inclination_deg: 'catalog_v2.inclination_deg',
				orbit_class: CATALOG_ORBIT_CLASS_SQL,
				site: "UPPER(COALESCE(catalog_v2.site, ''))",
				rcs_size: "UPPER(COALESCE(catalog_v2.rcs_size, ''))"
			},
			selectSql: `SELECT
				catalog_v2.norad_cat_id as norad_cat_id,
				COALESCE(catalog_v2.object_name, '') as object_name,
				UPPER(COALESCE(catalog_v2.object_type, '')) as object_type,
				UPPER(COALESCE(catalog_v2.country_code, '')) as country_code,
				catalog_v2.launch_year as launch_year,
				catalog_v2.apogee_km as apogee_km,
				catalog_v2.perigee_km as perigee_km,
				catalog_v2.period_minutes as period_minutes,
				catalog_v2.inclination_deg as inclination_deg,
				${CATALOG_ORBIT_CLASS_SQL} as orbit_class,
				catalog_v2.site as site,
				catalog_v2.rcs_size as rcs_size`,
			detailSql: `SELECT
				catalog_v2.norad_cat_id as norad_cat_id,
				COALESCE(catalog_v2.object_name, '') as object_name,
				UPPER(COALESCE(catalog_v2.object_type, '')) as object_type,
				UPPER(COALESCE(catalog_v2.country_code, '')) as country_code,
				catalog_v2.launch_year as launch_year,
				catalog_v2.apogee_km as apogee_km,
				catalog_v2.perigee_km as perigee_km,
				catalog_v2.period_minutes as period_minutes,
				catalog_v2.inclination_deg as inclination_deg,
				${CATALOG_ORBIT_CLASS_SQL} as orbit_class,
				catalog_v2.site as site,
				catalog_v2.rcs_size as rcs_size,
				catalog_v2.epoch as epoch,
				catalog_v2.tle_line1 as tle_line1,
				catalog_v2.tle_line2 as tle_line2`,
			facetSql: {
				objectType: "UPPER(COALESCE(catalog_v2.object_type, ''))",
				countryCode: "UPPER(COALESCE(catalog_v2.country_code, ''))",
				orbitClass: CATALOG_ORBIT_CLASS_SQL,
				launchYear: 'CAST(catalog_v2.launch_year as TEXT)'
			},
			noradOrderSql: 'catalog_v2.norad_cat_id'
		};
	}

	return {
		source: 'legacy',
		fromSql: 'FROM gp INNER JOIN satcat ON satcat.NORAD_CAT_ID = gp.NORAD_CAT_ID',
		fieldSql: {
			norad_cat_id: 'gp.NORAD_CAT_ID',
			object_name: "COALESCE(NULLIF(satcat.OBJECT_NAME, ''), gp.OBJECT_NAME, '')",
			object_type: "UPPER(COALESCE(NULLIF(satcat.OBJECT_TYPE, ''), gp.OBJECT_TYPE, ''))",
			country_code: "UPPER(COALESCE(NULLIF(gp.COUNTRY_CODE, ''), satcat.COUNTRY, ''))",
			launch_year: "CAST(strftime('%Y', COALESCE(gp.LAUNCH_DATE, satcat.LAUNCH)) AS INTEGER)",
			apogee_km: 'gp.APOAPSIS',
			perigee_km: 'gp.PERIAPSIS',
			period_minutes: 'COALESCE(gp.PERIOD, satcat.PERIOD)',
			inclination_deg: 'COALESCE(gp.INCLINATION, satcat.INCLINATION)',
			orbit_class: LEGACY_ORBIT_CLASS_SQL,
			site: "UPPER(COALESCE(NULLIF(gp.SITE, ''), satcat.SITE, ''))",
			rcs_size: "UPPER(COALESCE(NULLIF(gp.RCS_SIZE, ''), satcat.RCS_SIZE, ''))"
		},
		selectSql: `SELECT
			gp.NORAD_CAT_ID as norad_cat_id,
			COALESCE(NULLIF(satcat.OBJECT_NAME, ''), gp.OBJECT_NAME, '') as object_name,
			UPPER(COALESCE(NULLIF(satcat.OBJECT_TYPE, ''), gp.OBJECT_TYPE, '')) as object_type,
			UPPER(COALESCE(NULLIF(gp.COUNTRY_CODE, ''), satcat.COUNTRY, '')) as country_code,
			CAST(strftime('%Y', COALESCE(gp.LAUNCH_DATE, satcat.LAUNCH)) AS INTEGER) as launch_year,
			gp.APOAPSIS as apogee_km,
			gp.PERIAPSIS as perigee_km,
			COALESCE(gp.PERIOD, satcat.PERIOD) as period_minutes,
			COALESCE(gp.INCLINATION, satcat.INCLINATION) as inclination_deg,
			${LEGACY_ORBIT_CLASS_SQL} as orbit_class,
			COALESCE(NULLIF(gp.SITE, ''), satcat.SITE, '') as site,
			COALESCE(NULLIF(gp.RCS_SIZE, ''), satcat.RCS_SIZE, '') as rcs_size`,
		detailSql: `SELECT
			gp.NORAD_CAT_ID as norad_cat_id,
			COALESCE(NULLIF(satcat.OBJECT_NAME, ''), gp.OBJECT_NAME, '') as object_name,
			UPPER(COALESCE(NULLIF(satcat.OBJECT_TYPE, ''), gp.OBJECT_TYPE, '')) as object_type,
			UPPER(COALESCE(NULLIF(gp.COUNTRY_CODE, ''), satcat.COUNTRY, '')) as country_code,
			CAST(strftime('%Y', COALESCE(gp.LAUNCH_DATE, satcat.LAUNCH)) AS INTEGER) as launch_year,
			gp.APOAPSIS as apogee_km,
			gp.PERIAPSIS as perigee_km,
			COALESCE(gp.PERIOD, satcat.PERIOD) as period_minutes,
			COALESCE(gp.INCLINATION, satcat.INCLINATION) as inclination_deg,
			${LEGACY_ORBIT_CLASS_SQL} as orbit_class,
			COALESCE(NULLIF(gp.SITE, ''), satcat.SITE, '') as site,
			COALESCE(NULLIF(gp.RCS_SIZE, ''), satcat.RCS_SIZE, '') as rcs_size,
			gp.EPOCH as epoch,
			gp.TLE_LINE1 as tle_line1,
			gp.TLE_LINE2 as tle_line2`,
		facetSql: {
			objectType: "UPPER(COALESCE(NULLIF(satcat.OBJECT_TYPE, ''), gp.OBJECT_TYPE, ''))",
			countryCode: "UPPER(COALESCE(NULLIF(gp.COUNTRY_CODE, ''), satcat.COUNTRY, ''))",
			orbitClass: LEGACY_ORBIT_CLASS_SQL,
			launchYear: "CAST(strftime('%Y', COALESCE(gp.LAUNCH_DATE, satcat.LAUNCH)) AS TEXT)"
		},
		noradOrderSql: 'gp.NORAD_CAT_ID'
	};
}

const SOURCE = buildSourceConfig();
queryLogger.info('query runtime initialized', {
	dataSource: SOURCE.source
});

const COUNTRY_ALIASES: Record<string, string[]> = {
	german: ['GER'],
	germany: ['GER'],
	de: ['GER'],
	deu: ['GER'],
	ger: ['GER'],
	us: ['US', 'USBZ'],
	usa: ['US', 'USBZ'],
	united_states: ['US', 'USBZ'],
	united_states_of_america: ['US', 'USBZ'],
	china: ['PRC', 'CHLE', 'CHTU', 'CHBZ', 'PRES'],
	chinese: ['PRC', 'CHLE', 'CHTU', 'CHBZ', 'PRES'],
	russia: ['CIS', 'RUS'],
	russian: ['CIS', 'RUS'],
	uk: ['UK'],
	united_kingdom: ['UK']
};

const OBJECT_TYPE_ALIASES: Record<string, string> = {
	payload: 'PAYLOAD',
	satellite: 'PAYLOAD',
	satellites: 'PAYLOAD',
	active_satellite: 'PAYLOAD',
	debris: 'DEBRIS',
	fragment: 'DEBRIS',
	fragments: 'DEBRIS',
	'rocket body': 'ROCKET BODY',
	rocket: 'ROCKET BODY',
	booster: 'ROCKET BODY',
	unknown: 'UNKNOWN'
};

const ORBIT_CLASS_ALIASES: Record<string, 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'UNKNOWN'> = {
	leo: 'LEO',
	low_earth_orbit: 'LEO',
	low_earth: 'LEO',
	meo: 'MEO',
	medium_earth_orbit: 'MEO',
	medium_earth: 'MEO',
	geo: 'GEO',
	geostationary: 'GEO',
	geostationary_orbit: 'GEO',
	heo: 'HEO',
	high_earth_orbit: 'HEO',
	high_earth: 'HEO',
	unknown: 'UNKNOWN'
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

function toScalarOrUndefined(value: unknown): string | number | undefined {
	if (typeof value === 'string') {
		return value;
	}
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	return undefined;
}

function toKey(value: string | number): string {
	return String(value).trim().toLowerCase().replace(/\s+/g, '_');
}

function canonicalizeObjectTypeValue(value: string | number): string {
	const key = toKey(value);
	if (OBJECT_TYPE_ALIASES[key]) {
		return OBJECT_TYPE_ALIASES[key];
	}
	return String(value).trim().toUpperCase();
}

function canonicalizeOrbitClassValue(
	value: string | number
): 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'UNKNOWN' {
	const key = toKey(value);
	if (ORBIT_CLASS_ALIASES[key]) {
		return ORBIT_CLASS_ALIASES[key];
	}
	const raw = String(value).trim().toUpperCase();
	if (raw === 'LEO' || raw === 'MEO' || raw === 'GEO' || raw === 'HEO') {
		return raw;
	}
	return 'UNKNOWN';
}

function normalizeCountryValues(values: Array<string | number>): string[] {
	const expanded = values.flatMap((raw) => {
		const key = toKey(raw);
		if (COUNTRY_ALIASES[key]) {
			return COUNTRY_ALIASES[key];
		}
		const rawText = String(raw).trim();
		if (rawText.length === 0) {
			return [];
		}
		return [rawText.toUpperCase()];
	});
	return [...new Set(expanded)];
}

function shouldTreatCountryContainsAsEq(value: string | number): boolean {
	const key = toKey(value);
	if (COUNTRY_ALIASES[key]) {
		return true;
	}
	return /^[a-z]{2,4}$/.test(key);
}

function normalizeInValues(field: CatalogFilterField, values: Array<string | number>): string[] {
	if (field === 'country_code') {
		return normalizeCountryValues(values);
	}
	if (field === 'object_type') {
		return values.map((value) => canonicalizeObjectTypeValue(value));
	}
	if (field === 'orbit_class') {
		return values.map((value) => canonicalizeOrbitClassValue(value));
	}
	if (field === 'site' || field === 'rcs_size') {
		return values
			.map((value) => String(value).trim().toUpperCase())
			.filter((value) => value.length > 0);
	}
	return values.map((value) => String(value).trim()).filter((value) => value.length > 0);
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
		if (typeof field !== 'string' || !(field in SOURCE.fieldSql)) {
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

		if (field === 'object_type' && value !== undefined) {
			if (op === 'eq' || op === 'contains') {
				value = canonicalizeObjectTypeValue(value);
				if (op === 'contains') {
					op = 'eq';
				}
			}
		}

		if (field === 'orbit_class' && value !== undefined) {
			if (op === 'eq' || op === 'contains') {
				value = canonicalizeOrbitClassValue(value);
				if (op === 'contains') {
					op = 'eq';
				}
			}
		}

		if ((field === 'site' || field === 'rcs_size') && value !== undefined) {
			value = String(value).trim().toUpperCase();
		}

		if (Array.isArray(values) && values.length > 0) {
			values = normalizeInValues(field as CatalogFilterField, values);
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
		const sqlField = SOURCE.fieldSql[filter.field];
		const paramBase = `f${i}`;

		if (filter.op === 'in') {
			const rawValues = filter.values && filter.values.length > 0 ? filter.values : [];
			const normalizedValues = normalizeInValues(filter.field, rawValues);
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
		const normalizedScalar =
			filter.field === 'object_type'
				? canonicalizeObjectTypeValue(scalarValue)
				: filter.field === 'orbit_class'
					? canonicalizeOrbitClassValue(scalarValue)
					: filter.field === 'site' || filter.field === 'rcs_size'
						? String(scalarValue).trim().toUpperCase()
						: scalarValue;
		const numberCandidate = toNumberOrNull(normalizedScalar);
		if (numberCandidate !== null && ['gt', 'gte', 'lt', 'lte', 'eq', 'neq'].includes(filter.op)) {
			params[key] = numberCandidate;
		} else {
			params[key] = String(normalizedScalar);
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

function extractSingleObjectNameNeedle(filters: CatalogFilter[]): string | null {
	const candidates = filters.filter(
		(filter): filter is CatalogFilter & { value: string } =>
			filter.field === 'object_name' &&
			filter.op === 'contains' &&
			typeof filter.value === 'string' &&
			filter.value.trim() !== ''
	);
	if (candidates.length !== 1) {
		return null;
	}
	const normalized = candidates[0].value.trim().toLowerCase().replace(/\s+/g, ' ');
	if (normalized.length < 2) {
		return null;
	}
	return normalized;
}

function buildObjectNameRelevanceOrder(needle: string): {
	orderSql: string;
	params: Record<string, string | number>;
} {
	const objectNameSql = SOURCE.fieldSql.object_name;
	const normalizedNameSql = `LOWER(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(${objectNameSql}, '(', ' '), ')', ' '), '-', ' '), '/', ' '), '_', ' '))`;
	const scoreSql = `CASE
		WHEN LOWER(TRIM(${objectNameSql})) = @nameNeedleExact THEN 500
		WHEN LOWER(TRIM(${objectNameSql})) LIKE @nameNeedlePrefix THEN 400
		WHEN (' ' || ${normalizedNameSql} || ' ') LIKE @nameNeedleWord THEN 300
		WHEN LOWER(${objectNameSql}) LIKE @nameNeedleContains THEN 200
		ELSE 0
	END`;
	const lengthDeltaSql = `ABS(LENGTH(LOWER(${objectNameSql})) - @nameNeedleLength)`;

	return {
		orderSql: `${scoreSql} DESC, ${lengthDeltaSql} ASC, ${SOURCE.noradOrderSql} ASC`,
		params: {
			nameNeedleExact: needle,
			nameNeedlePrefix: `${needle} %`,
			nameNeedleWord: `% ${needle} %`,
			nameNeedleContains: `%${needle}%`,
			nameNeedleLength: needle.length
		}
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

function facetRowsToBuckets(rows: Array<{ value: unknown; count: number }>): CatalogFacetBucket[] {
	return rows
		.filter((row) => row.count > 0 && row.value !== null && row.value !== undefined)
		.map((row) => ({ value: String(row.value), count: row.count }))
		.filter((row) => row.value.trim() !== '');
}

function getFacetBuckets(
	valueSql: string,
	whereSql: string,
	params: Record<string, string | number>,
	limit = 8
): CatalogFacetBucket[] {
	const rows = db
		.prepare(
			`SELECT ${valueSql} as value, COUNT(*) as count
			${SOURCE.fromSql}
			WHERE ${whereSql}
			GROUP BY value
			ORDER BY count DESC
			LIMIT @facetLimit`
		)
		.all({ ...params, facetLimit: limit }) as Array<{ value: unknown; count: number }>;

	return facetRowsToBuckets(rows);
}

function buildFacets(whereSql: string, params: Record<string, string | number>): CatalogFacets {
	return {
		objectType: getFacetBuckets(SOURCE.facetSql.objectType, whereSql, params),
		countryCode: getFacetBuckets(SOURCE.facetSql.countryCode, whereSql, params),
		orbitClass: getFacetBuckets(SOURCE.facetSql.orbitClass, whereSql, params),
		launchYear: getFacetBuckets(SOURCE.facetSql.launchYear, whereSql, params)
	};
}

export function runCatalogQuery(rawSpec: unknown): CatalogQueryResult {
	const startedAt = Date.now();
	if (typeof rawSpec !== 'object' || rawSpec === null) {
		throw new Error('query spec must be an object');
	}
	const spec = rawSpec as Record<string, unknown>;
	const queryType = spec.queryType === 'count' ? 'count' : 'select';
	const mode = spec.mode === 'add' || spec.mode === 'remove' ? spec.mode : 'replace';
	const explicitLimit =
		typeof spec.limit === 'number' && Number.isFinite(spec.limit)
			? Math.floor(spec.limit)
			: undefined;
	if (explicitLimit !== undefined && explicitLimit < 1) {
		throw new Error('limit must be a positive integer');
	}
	const filters = validateFilters(spec.filters ?? []);
	queryLogger.debug('catalog query received', {
		dataSource: SOURCE.source,
		queryType,
		mode,
		limit: explicitLimit ?? null,
		filterCount: filters.length
	});

	const { whereSql, params } = buildWhere(filters);
	const facets = buildFacets(whereSql, params);

	const countRow = db
		.prepare(`SELECT COUNT(*) as count ${SOURCE.fromSql} WHERE ${whereSql}`)
		.get(params) as { count: number };
	const totalCount = countRow.count;

	if (queryType === 'count') {
		queryLogger.info('catalog query completed', {
			dataSource: SOURCE.source,
			queryType,
			totalCount,
			durationMs: Date.now() - startedAt
		});
		return {
			queryType,
			mode,
			totalCount,
			returnedCount: 0,
			noradCatIds: [],
			sample: [],
			filterSummary: summarizeFilters(filters),
			facets
		};
	}

	const objectNameNeedle = extractSingleObjectNameNeedle(filters);
	let orderSql = `${SOURCE.noradOrderSql} ASC`;
	let selectParams: Record<string, string | number> = { ...params };
	let selectLimit = explicitLimit;
	if (objectNameNeedle) {
		const relevanceOrder = buildObjectNameRelevanceOrder(objectNameNeedle);
		orderSql = relevanceOrder.orderSql;
		selectParams = { ...selectParams, ...relevanceOrder.params };
		if (explicitLimit !== undefined) {
			// Probe additional rows so the caller can see alternatives when limit is small.
			selectLimit = Math.max(explicitLimit, 10);
		}
	}

	const limitClause = selectLimit === undefined ? '' : 'LIMIT @selectLimit';
	const rows = db
		.prepare(
			`${SOURCE.selectSql}
					${SOURCE.fromSql}
					WHERE ${whereSql}
					ORDER BY ${orderSql}
					${limitClause}`
		)
		.all(selectLimit === undefined ? selectParams : { ...selectParams, selectLimit }) as Array<{
		norad_cat_id: number;
		object_name: string;
		object_type: string;
		country_code: string;
		launch_year: number | null;
		apogee_km: number | null;
		perigee_km: number | null;
		period_minutes: number | null;
		inclination_deg: number | null;
		orbit_class: 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'UNKNOWN';
		site: string | null;
		rcs_size: string | null;
	}>;

	const selectedRows = explicitLimit === undefined ? rows : rows.slice(0, explicitLimit);
	const sampleRows = rows.slice(0, 10);
	const sample = sampleRows.map((row) => ({
		noradCatId: row.norad_cat_id,
		objectName: row.object_name,
		objectType: row.object_type,
		countryCode: row.country_code,
		launchYear: row.launch_year,
		apogeeKm: row.apogee_km,
		perigeeKm: row.perigee_km,
		periodMinutes: row.period_minutes,
		inclinationDeg: row.inclination_deg,
		orbitClass: row.orbit_class,
		site: row.site,
		rcsSize: row.rcs_size
	}));
	queryLogger.info('catalog query completed', {
		dataSource: SOURCE.source,
		queryType,
		mode,
		totalCount,
		returnedCount: selectedRows.length,
		probeCount: rows.length,
		durationMs: Date.now() - startedAt
	});

	return {
		queryType,
		mode,
		totalCount,
		returnedCount: selectedRows.length,
		noradCatIds: selectedRows.map((row) => row.norad_cat_id),
		sample,
		filterSummary: summarizeFilters(filters),
		facets
	};
}

export function getObjectDetails(noradCatId: number): ObjectDetails | null {
	const startedAt = Date.now();
	if (!Number.isInteger(noradCatId) || noradCatId <= 0) {
		throw new Error('norad_cat_id must be a positive integer');
	}

	const whereNoradSql =
		SOURCE.source === 'catalog_v2'
			? 'catalog_v2.norad_cat_id = @noradCatId'
			: 'gp.NORAD_CAT_ID = @noradCatId';

	const row = db
		.prepare(
			`${SOURCE.detailSql}
			${SOURCE.fromSql}
			WHERE ${whereNoradSql}
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
				orbit_class: 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'UNKNOWN';
				site: string | null;
				rcs_size: string | null;
				epoch: string | null;
				tle_line1: string | null;
				tle_line2: string | null;
		  }
		| undefined;

	if (!row) {
		queryLogger.warn('object details not found', {
			dataSource: SOURCE.source,
			noradCatId,
			durationMs: Date.now() - startedAt
		});
		return null;
	}

	const result: ObjectDetails = {
		noradCatId: row.norad_cat_id,
		objectName: row.object_name,
		objectType: row.object_type,
		countryCode: row.country_code,
		launchYear: row.launch_year,
		apogeeKm: row.apogee_km,
		perigeeKm: row.perigee_km,
		periodMinutes: row.period_minutes,
		inclinationDeg: row.inclination_deg,
		orbitClass: row.orbit_class,
		site: row.site,
		rcsSize: row.rcs_size,
		epoch: row.epoch,
		tleLine1: row.tle_line1,
		tleLine2: row.tle_line2
	};
	queryLogger.info('object details fetched', {
		dataSource: SOURCE.source,
		noradCatId: result.noradCatId,
		orbitClass: result.orbitClass,
		durationMs: Date.now() - startedAt
	});
	return result;
}
