import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({
	fetchMock: vi.fn()
}));

vi.mock('$env/dynamic/private', () => ({ env: { TOKEN_DW: 'test-token' } }));

import { ensureDiscosTables, refreshDiscosData } from '../../src/lib/server/discos.server';

describe('discos refresh', () => {
	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it('creates discos tables', () => {
		const db = new Database(':memory:');
		ensureDiscosTables(db);

		const tables = db
			.prepare(
				"SELECT name FROM sqlite_master WHERE type='table' AND name IN ('discos_objects', 'discos_object_entities') ORDER BY name"
			)
			.all() as Array<{ name: string }>;
		expect(tables).toEqual([{ name: 'discos_object_entities' }, { name: 'discos_objects' }]);
	});

	it('imports one page of objects with launch and entity context', async () => {
		const db = new Database(':memory:');
		const doc = {
			data: [
				{
					id: '100',
					type: 'object',
					attributes: {
						satno: 42069,
						cosparId: '2020-001A',
						name: 'TEST SAT',
						objectClass: 'Payload',
						mass: 120,
						mission: 'Demo',
						predDecayDate: '2030-01-01T00:00:00Z',
						active: true
					},
					relationships: {
						launch: { data: { id: 'L1', type: 'launch' } },
						operators: { data: [{ id: 'E1', type: 'organisation' }] },
						states: { data: [{ id: 'E2', type: 'country' }] }
					}
				}
			],
			included: [
				{
					id: 'L1',
					type: 'launch',
					attributes: {
						epoch: '2020-01-07T00:00:00Z',
						cosparLaunchNo: '2020-001',
						failure: false
					},
					relationships: {
						entities: {
							data: [
								{ id: 'E1', type: 'organisation' },
								{ id: 'E2', type: 'country' }
							]
						},
						vehicle: { data: { id: 'V1', type: 'vehicle' } },
						site: { data: { id: 'S1', type: 'launchSite' } }
					}
				},
				{ id: 'V1', type: 'vehicle', attributes: { name: 'Falcon 9' } },
				{ id: 'S1', type: 'launchSite', attributes: { name: 'Cape Canaveral' } },
				{ id: 'E1', type: 'organisation', attributes: { name: 'NASA' } },
				{ id: 'E2', type: 'country', attributes: { name: 'United States' } }
			],
			meta: {
				pagination: {
					currentPage: 1,
					totalPages: 1
				}
			}
		};

		fetchMock.mockResolvedValueOnce(
			new Response(JSON.stringify(doc), {
				status: 200,
				headers: {
					'X-RateLimit-Limit': '100',
					'X-RateLimit-Remaining': '99',
					'X-RateLimit-Reset': '1770416349'
				}
			})
		);

		await refreshDiscosData(db);

		expect(fetchMock).toHaveBeenCalledTimes(1);
		const objectRow = db
			.prepare(
				'SELECT norad_cat_id, cospar_id, launch_cospar_no, launch_failure, launch_vehicle_name, launch_site_name FROM discos_objects'
			)
			.get() as {
			norad_cat_id: number;
			cospar_id: string;
			launch_cospar_no: string;
			launch_failure: number;
			launch_vehicle_name: string;
			launch_site_name: string;
		};

		expect(objectRow).toEqual({
			norad_cat_id: 42069,
			cospar_id: '2020-001A',
			launch_cospar_no: '2020-001',
			launch_failure: 0,
			launch_vehicle_name: 'Falcon 9',
			launch_site_name: 'Cape Canaveral'
		});

		const entityRows = db
			.prepare(
				'SELECT role, entity_type, entity_name FROM discos_object_entities ORDER BY role, entity_name'
			)
			.all() as Array<{ role: string; entity_type: string; entity_name: string }>;

		expect(entityRows).toEqual([
			{ role: 'launch', entity_type: 'organisation', entity_name: 'NASA' },
			{ role: 'launch', entity_type: 'country', entity_name: 'United States' },
			{ role: 'operator', entity_type: 'organisation', entity_name: 'NASA' },
			{ role: 'state', entity_type: 'country', entity_name: 'United States' }
		]);
	});
});
