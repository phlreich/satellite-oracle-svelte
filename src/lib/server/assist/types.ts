export type AssistRole = 'user' | 'assistant';

export type AssistMessage = {
	role: AssistRole;
	content: string;
};

export type AssistSelectionMode = 'replace' | 'add' | 'remove';

export type SceneContext = {
	selectedNoradId?: number | null;
	visibleNoradIds?: number[];
	visibleCount?: number;
	timestamp?: string;
};

export type AssistRequestBody = {
	messages: AssistMessage[];
	sceneContext?: SceneContext;
	previousResponseId?: string | null;
};

export type CatalogFilterField =
	| 'norad_cat_id'
	| 'object_name'
	| 'object_type'
	| 'country_code'
	| 'launch_year'
	| 'apogee_km'
	| 'perigee_km'
	| 'period_minutes'
	| 'inclination_deg'
	| 'orbit_class'
	| 'site'
	| 'rcs_size';

export type CatalogFilterOp = 'eq' | 'neq' | 'contains' | 'in' | 'gt' | 'gte' | 'lt' | 'lte';

export type CatalogFilterScalar = string | number;

export type CatalogFilter = {
	field: CatalogFilterField;
	op: CatalogFilterOp;
	value?: CatalogFilterScalar;
	values?: CatalogFilterScalar[];
};

export type CatalogQuerySpec = {
	queryType: 'count' | 'select';
	mode?: AssistSelectionMode;
	limit?: number;
	filters: CatalogFilter[];
};

export type CatalogObjectRow = {
	noradCatId: number;
	objectName: string;
	objectType: string;
	countryCode: string;
	launchYear: number | null;
	apogeeKm: number | null;
	perigeeKm: number | null;
	periodMinutes: number | null;
	inclinationDeg: number | null;
	orbitClass: 'LEO' | 'MEO' | 'GEO' | 'HEO' | 'UNKNOWN';
	site: string | null;
	rcsSize: string | null;
};

export type CatalogFacetBucket = {
	value: string;
	count: number;
};

export type CatalogFacets = {
	objectType: CatalogFacetBucket[];
	countryCode: CatalogFacetBucket[];
	orbitClass: CatalogFacetBucket[];
	launchYear: CatalogFacetBucket[];
};

export type CatalogQueryResult = {
	queryType: 'count' | 'select';
	mode: AssistSelectionMode;
	totalCount: number;
	returnedCount: number;
	noradCatIds: number[];
	sample: CatalogObjectRow[];
	filterSummary: string;
	facets: CatalogFacets;
};

export type ObjectDetails = CatalogObjectRow & {
	epoch: string | null;
	tleLine1: string | null;
	tleLine2: string | null;
};

export type AssistResponse = {
	assistantMessage: string;
	action: {
		mode: AssistSelectionMode;
		noradCatIds: number[];
		totalCount: number;
		returnedCount: number;
		filterSummary: string;
	} | null;
	responseId: string | null;
};
