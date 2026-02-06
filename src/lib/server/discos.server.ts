import type Database from 'better-sqlite3';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { env } from '$env/dynamic/private';
import { createLogger, serializeError } from './logger';

const DISCO_BASE_URL = 'https://discosweb.esoc.esa.int/api';
const DISCO_PAGE_SIZE = 100;
const DISCO_MIN_REQUEST_INTERVAL_MS = 750;
const DISCO_MAX_RETRIES = 5;

type JsonApiIdentifier = {
	id: string;
	type: string;
};

type JsonApiRelationship = {
	data?: JsonApiIdentifier | JsonApiIdentifier[] | null;
};

type JsonApiResource = {
	id: string;
	type: string;
	attributes?: Record<string, unknown>;
	relationships?: Record<string, JsonApiRelationship>;
};

type JsonApiDocument = {
	data: JsonApiResource[];
	included?: JsonApiResource[];
	meta?: {
		pagination?: {
			currentPage?: number;
			totalPages?: number;
		};
	};
};

const discosLogger = createLogger('db.discos');

function sleep(ms: number) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function asNumber(value: unknown): number | null {
	if (typeof value === 'number' && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) {
		return Number(value);
	}
	return null;
}

function asBooleanInt(value: unknown): number | null {
	if (typeof value !== 'boolean') {
		return null;
	}
	return value ? 1 : 0;
}

function getRelationshipIdentifiers(resource: JsonApiResource, name: string): JsonApiIdentifier[] {
	const data = resource.relationships?.[name]?.data;
	if (!data) {
		return [];
	}
	if (Array.isArray(data)) {
		return data.filter((entry): entry is JsonApiIdentifier => Boolean(entry?.id && entry?.type));
	}
	if (typeof data.id === 'string' && typeof data.type === 'string') {
		return [data];
	}
	return [];
}

function resourceKey(resource: JsonApiIdentifier): string {
	return `${resource.type}:${resource.id}`;
}

function buildResourceIndex(resources: JsonApiResource[]): Map<string, JsonApiResource> {
	const index = new Map<string, JsonApiResource>();
	for (const resource of resources) {
		if (!resource.id || !resource.type) {
			continue;
		}
		index.set(resourceKey({ id: resource.id, type: resource.type }), resource);
	}
	return index;
}

function parseRetryAfterMs(headerValue: string | null): number {
	if (!headerValue) {
		return 60_000;
	}
	const seconds = Number.parseInt(headerValue, 10);
	if (Number.isFinite(seconds) && seconds > 0) {
		return seconds * 1000;
	}
	return 60_000;
}

export function ensureDiscosTables(db: Database.Database) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS discos_objects (
			discos_object_id TEXT PRIMARY KEY,
			norad_cat_id INTEGER,
			cospar_id TEXT,
			name TEXT,
			object_class TEXT,
			mission TEXT,
			active INTEGER,
			pred_decay_date TEXT,
			mass REAL,
			launch_id TEXT,
			launch_epoch TEXT,
			launch_cospar_no TEXT,
			launch_failure INTEGER,
			launch_vehicle_name TEXT,
			launch_site_name TEXT,
			updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
		);

		CREATE TABLE IF NOT EXISTS discos_object_entities (
			discos_object_id TEXT NOT NULL,
			norad_cat_id INTEGER,
			role TEXT NOT NULL CHECK (role IN ('launch', 'operator', 'state')),
			entity_id TEXT NOT NULL,
			entity_type TEXT,
			entity_name TEXT,
			PRIMARY KEY (discos_object_id, role, entity_id)
		);

		CREATE INDEX IF NOT EXISTS idx_discos_objects_norad ON discos_objects(norad_cat_id);
		CREATE INDEX IF NOT EXISTS idx_discos_objects_cospar ON discos_objects(cospar_id);
		CREATE INDEX IF NOT EXISTS idx_discos_objects_launch_epoch ON discos_objects(launch_epoch);
		CREATE INDEX IF NOT EXISTS idx_discos_entities_role ON discos_object_entities(role);
		CREATE INDEX IF NOT EXISTS idx_discos_entities_name ON discos_object_entities(entity_name);
		CREATE INDEX IF NOT EXISTS idx_discos_entities_norad ON discos_object_entities(norad_cat_id);
	`);
}

async function fetchObjectsPage({
	token,
	pageNumber,
	lastRequestAt
}: {
	token: string;
	pageNumber: number;
	lastRequestAt: number;
}): Promise<{ document: JsonApiDocument; requestedAt: number }> {
	let retries = 0;
	let requestAt = lastRequestAt;
	while (retries <= DISCO_MAX_RETRIES) {
		const elapsed = Date.now() - requestAt;
		if (elapsed < DISCO_MIN_REQUEST_INTERVAL_MS) {
			await sleep(DISCO_MIN_REQUEST_INTERVAL_MS - elapsed);
		}
		const params = new URLSearchParams();
		params.set('page[size]', String(DISCO_PAGE_SIZE));
		params.set('page[number]', String(pageNumber));
		params.set('include', 'launch,launch.entities,launch.vehicle,launch.site,operators,states');
		params.set(
			'fields[object]',
			'satno,cosparId,name,objectClass,mass,mission,predDecayDate,active'
		);
		params.set('fields[launch]', 'epoch,flightNo,cosparLaunchNo,failure');
		params.set('fields[vehicle]', 'name');
		params.set('fields[launchSite]', 'name,latitude,longitude,altitude');
		params.set('fields[country]', 'name');
		params.set('fields[organisation]', 'name');
		const url = `${DISCO_BASE_URL}/objects?${params.toString()}`;

		requestAt = Date.now();
		const response = await fetch(url, {
			headers: {
				Authorization: `Bearer ${token}`,
				'DiscosWeb-Api-Version': '2',
				Accept: 'application/vnd.api+json'
			}
		});

		if (response.status === 429) {
			const retryAfterMs = parseRetryAfterMs(response.headers.get('Retry-After'));
			discosLogger.warn('discos request throttled', {
				pageNumber,
				retries,
				retryAfterMs,
				limit: response.headers.get('X-RateLimit-Limit'),
				remaining: response.headers.get('X-RateLimit-Remaining'),
				reset: response.headers.get('X-RateLimit-Reset')
			});
			await sleep(retryAfterMs);
			retries += 1;
			continue;
		}

		if (!response.ok) {
			const bodyText = await response.text();
			throw new Error(`DISCOS request failed (${response.status}): ${bodyText.slice(0, 400)}`);
		}

		const document = (await response.json()) as JsonApiDocument;
		if (!Array.isArray(document.data)) {
			throw new Error('DISCOS response missing expected data array.');
		}

		discosLogger.debug('discos page fetched', {
			pageNumber,
			objectsInPage: document.data.length,
			includedCount: Array.isArray(document.included) ? document.included.length : 0,
			limit: response.headers.get('X-RateLimit-Limit'),
			remaining: response.headers.get('X-RateLimit-Remaining'),
			reset: response.headers.get('X-RateLimit-Reset')
		});

		return { document, requestedAt: requestAt };
	}

	throw new Error(`DISCOS request exceeded retry budget on page ${pageNumber}.`);
}

export async function refreshDiscosData(db: Database.Database): Promise<void> {
	const token = asString(env.TOKEN_DW);
	if (!token) {
		discosLogger.info('discos refresh skipped: TOKEN_DW is not set');
		return;
	}

	const startedAt = Date.now();
	ensureDiscosTables(db);
	discosLogger.info('discos refresh started');

	const insertObject = db.prepare(`
		INSERT OR REPLACE INTO discos_objects (
			discos_object_id,
			norad_cat_id,
			cospar_id,
			name,
			object_class,
			mission,
			active,
			pred_decay_date,
			mass,
			launch_id,
			launch_epoch,
			launch_cospar_no,
			launch_failure,
			launch_vehicle_name,
			launch_site_name,
			updated_at
		)
		VALUES (
			@discos_object_id,
			@norad_cat_id,
			@cospar_id,
			@name,
			@object_class,
			@mission,
			@active,
			@pred_decay_date,
			@mass,
			@launch_id,
			@launch_epoch,
			@launch_cospar_no,
			@launch_failure,
			@launch_vehicle_name,
			@launch_site_name,
			@updated_at
		)
	`);

	const insertEntity = db.prepare(`
		INSERT OR REPLACE INTO discos_object_entities (
			discos_object_id,
			norad_cat_id,
			role,
			entity_id,
			entity_type,
			entity_name
		)
		VALUES (
			@discos_object_id,
			@norad_cat_id,
			@role,
			@entity_id,
			@entity_type,
			@entity_name
		)
	`);

	let transactionStarted = false;
	let insertedObjects = 0;
	let insertedEntities = 0;
	let page = 1;
	let totalPages: number | null = null;
	let lastRequestAt = 0;

	try {
		db.exec('BEGIN');
		transactionStarted = true;
		db.prepare('DELETE FROM discos_object_entities').run();
		db.prepare('DELETE FROM discos_objects').run();

		while (true) {
			const { document, requestedAt } = await fetchObjectsPage({
				token,
				pageNumber: page,
				lastRequestAt
			});
			lastRequestAt = requestedAt;
			totalPages =
				typeof document.meta?.pagination?.totalPages === 'number'
					? document.meta.pagination.totalPages
					: totalPages;

			const allResources = [
				...document.data,
				...(Array.isArray(document.included) ? document.included : [])
			];
			const resourceIndex = buildResourceIndex(allResources);

			for (const objectResource of document.data) {
				if (objectResource.type !== 'object') {
					continue;
				}

				const objectAttrs = objectResource.attributes ?? {};
				const noradCatId = asNumber(objectAttrs.satno);
				const launchRef = getRelationshipIdentifiers(objectResource, 'launch')[0] ?? null;
				const launchResource = launchRef ? resourceIndex.get(resourceKey(launchRef)) : null;
				const launchAttrs = launchResource?.attributes ?? {};

				const vehicleRef = launchResource
					? (getRelationshipIdentifiers(launchResource, 'vehicle')[0] ?? null)
					: null;
				const siteRef = launchResource
					? (getRelationshipIdentifiers(launchResource, 'site')[0] ?? null)
					: null;
				const vehicleResource = vehicleRef ? resourceIndex.get(resourceKey(vehicleRef)) : null;
				const siteResource = siteRef ? resourceIndex.get(resourceKey(siteRef)) : null;

				insertObject.run({
					discos_object_id: objectResource.id,
					norad_cat_id: noradCatId,
					cospar_id: asString(objectAttrs.cosparId),
					name: asString(objectAttrs.name),
					object_class: asString(objectAttrs.objectClass),
					mission: asString(objectAttrs.mission),
					active: asBooleanInt(objectAttrs.active),
					pred_decay_date: asString(objectAttrs.predDecayDate),
					mass: asNumber(objectAttrs.mass),
					launch_id: launchRef?.id ?? null,
					launch_epoch: asString(launchAttrs.epoch),
					launch_cospar_no: asString(launchAttrs.cosparLaunchNo),
					launch_failure: asBooleanInt(launchAttrs.failure),
					launch_vehicle_name: asString(vehicleResource?.attributes?.name),
					launch_site_name: asString(siteResource?.attributes?.name),
					updated_at: new Date().toISOString()
				});
				insertedObjects += 1;

				const entityGroups: Array<{
					role: 'launch' | 'operator' | 'state';
					refs: JsonApiIdentifier[];
				}> = [
					{
						role: 'launch',
						refs: launchResource ? getRelationshipIdentifiers(launchResource, 'entities') : []
					},
					{ role: 'operator', refs: getRelationshipIdentifiers(objectResource, 'operators') },
					{ role: 'state', refs: getRelationshipIdentifiers(objectResource, 'states') }
				];

				for (const group of entityGroups) {
					for (const ref of group.refs) {
						const entityResource = resourceIndex.get(resourceKey(ref));
						insertEntity.run({
							discos_object_id: objectResource.id,
							norad_cat_id: noradCatId,
							role: group.role,
							entity_id: ref.id,
							entity_type: ref.type,
							entity_name: asString(entityResource?.attributes?.name)
						});
						insertedEntities += 1;
					}
				}
			}

			discosLogger.info('discos page processed', {
				page,
				totalPages,
				objectsInPage: document.data.length,
				insertedObjects,
				insertedEntities
			});

			if (document.data.length === 0) {
				break;
			}
			if (totalPages !== null && page >= totalPages) {
				break;
			}
			if (totalPages === null && document.data.length < DISCO_PAGE_SIZE) {
				break;
			}

			page += 1;
		}

		db.exec('COMMIT');
		transactionStarted = false;
		discosLogger.info('discos refresh completed', {
			pages: page,
			insertedObjects,
			insertedEntities,
			durationMs: Date.now() - startedAt
		});
	} catch (error) {
		if (transactionStarted) {
			db.exec('ROLLBACK');
		}
		discosLogger.error('discos refresh failed', {
			error: serializeError(error),
			durationMs: Date.now() - startedAt,
			insertedObjects,
			insertedEntities
		});
	}
}
