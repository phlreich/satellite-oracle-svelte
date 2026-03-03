import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { fetchMock } = vi.hoisted(() => ({
	fetchMock: vi.fn()
}));

const SATCAT_CSV = `INTLDES,NORAD_CAT_ID,OBJECT_TYPE,SATNAME,COUNTRY,LAUNCH,SITE,DECAY,PERIOD,INCLINATION,APOGEE,PERIGEE,COMMENT,COMMENTCODE,RCSVALUE,RCS_SIZE,FILE,LAUNCH_YEAR,LAUNCH_NUM,LAUNCH_PIECE,CURRENT,OBJECT_NAME,OBJECT_ID,OBJECT_NUMBER
2020-001A,99901,PAYLOAD,TEST SAT,US,2020-01-01,AFETR,,,,,,,,0,,0,2020,1,A,Y,TEST SAT,2020-001A,99901
`;

const BOXSCORE_CSV = `COUNTRY,SPADOC_CD
ALL,ALL
`;

const GP_CSV = `CCSDS_OMM_VERS,COMMENT,CREATION_DATE,ORIGINATOR,OBJECT_NAME,OBJECT_ID,CENTER_NAME,REF_FRAME,TIME_SYSTEM,MEAN_ELEMENT_THEORY,EPOCH,MEAN_MOTION,ECCENTRICITY,INCLINATION,RA_OF_ASC_NODE,ARG_OF_PERICENTER,MEAN_ANOMALY,EPHEMERIS_TYPE,CLASSIFICATION_TYPE,NORAD_CAT_ID,ELEMENT_SET_NO,REV_AT_EPOCH,BSTAR,MEAN_MOTION_DOT,MEAN_MOTION_DDOT,SEMIMAJOR_AXIS,PERIOD,APOAPSIS,PERIAPSIS,OBJECT_TYPE,RCS_SIZE,COUNTRY_CODE,LAUNCH_DATE,SITE,DECAY_DATE,FILE,GP_ID,TLE_LINE0,TLE_LINE1,TLE_LINE2
3.0,TEST,,18 SPCS,TEST SAT,2020-001A,EARTH,TEME,UTC,SGP4,2026-01-01T00:00:00,15.1,0.0001,53,0,0,0,0,U,99901,1,1,0,0,0,6800,95,500,500,PAYLOAD,SMALL,US,2020-01-01,AFETR,,1,1,0 TEST SAT,1 99901U 20001A   26001.00000000  .00000000  00000-0  00000-0 0  9991,2 99901  53.0000 000.0000 0001000 000.0000 000.0000 15.10000000    01
`;

describe.sequential('database refresh DISCOS fallback', () => {
	const originalCwd = process.cwd();
	let tempDir = '';

	beforeEach(() => {
		fetchMock.mockReset();
		vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch);

		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-oracle-discos-fallback-'));
		const dataDir = path.join(tempDir, 'src/data');
		fs.mkdirSync(dataDir, { recursive: true });
		fs.writeFileSync(path.join(dataDir, 'satcat.csv'), SATCAT_CSV, 'utf8');
		fs.writeFileSync(path.join(dataDir, 'boxscore.csv'), BOXSCORE_CSV, 'utf8');
		fs.writeFileSync(path.join(dataDir, 'gp.csv'), GP_CSV, 'utf8');

		process.chdir(tempDir);
	});

	afterEach(() => {
		vi.doUnmock('$env/dynamic/private');
		vi.unstubAllGlobals();
		process.chdir(originalCwd);
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('keeps the last DISCOS snapshot when the upstream refresh fails', async () => {
		vi.resetModules();
		vi.doMock('$env/dynamic/private', () => ({
			env: {
				TOKEN_DW: 'test-token',
				EMAIL: '',
				PASSWORD: ''
			}
		}));
		const { ensureDiscosTables } = await import('../../src/lib/server/discos.server');

		const liveDbPath = path.join(tempDir, 'src/data/satellite.db');
		const oldDb = new Database(liveDbPath);
		ensureDiscosTables(oldDb);
		oldDb
			.prepare(
				`INSERT INTO discos_objects (
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
				) VALUES (
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
				)`
			)
			.run({
				discos_object_id: 'legacy-1',
				norad_cat_id: 99901,
				cospar_id: '2020-001A',
				name: 'LEGACY SAT',
				object_class: 'Payload',
				mission: 'Legacy',
				active: 1,
				pred_decay_date: null,
				mass: 120,
				launch_id: 'launch-1',
				launch_epoch: '2020-01-01T00:00:00Z',
				launch_cospar_no: '2020-001',
				launch_failure: 0,
				launch_vehicle_name: 'Falcon 9',
				launch_site_name: 'Cape Canaveral',
				updated_at: '2026-03-02T01:49:56.716Z'
			});
		oldDb
			.prepare(
				`INSERT INTO discos_object_entities (
					discos_object_id,
					norad_cat_id,
					role,
					entity_id,
					entity_type,
					entity_name
				) VALUES (
					@discos_object_id,
					@norad_cat_id,
					@role,
					@entity_id,
					@entity_type,
					@entity_name
				)`
			)
			.run({
				discos_object_id: 'legacy-1',
				norad_cat_id: 99901,
				role: 'operator',
				entity_id: 'org-1',
				entity_type: 'organisation',
				entity_name: 'NASA'
			});
		oldDb.close();

		fetchMock.mockResolvedValueOnce(
			new Response('<html><body><h1>Service Unavailable</h1></body></html>', {
				status: 503,
				headers: {
					'Content-Type': 'text/html'
				}
			})
		);

		const { refreshData } = await import('../../src/lib/server/database.server');
		await refreshData();

		expect(fetchMock).toHaveBeenCalledTimes(1);

		const liveDb = new Database(liveDbPath, { readonly: true });
		const satcatCount = (
			liveDb.prepare('SELECT COUNT(*) AS count FROM satcat').get() as { count: number }
		).count;
		const gpCount = (liveDb.prepare('SELECT COUNT(*) AS count FROM gp').get() as { count: number })
			.count;
		const discosObjectCount = (
			liveDb.prepare('SELECT COUNT(*) AS count FROM discos_objects').get() as { count: number }
		).count;
		const discosEntityCount = (
			liveDb
				.prepare('SELECT COUNT(*) AS count FROM discos_object_entities')
				.get() as { count: number }
		).count;
		const retainedObject = liveDb
			.prepare(
				'SELECT discos_object_id, name, updated_at FROM discos_objects WHERE norad_cat_id = 99901'
			)
			.get() as {
			discos_object_id: string;
			name: string;
			updated_at: string;
		};
		liveDb.close();

		expect(satcatCount).toBe(1);
		expect(gpCount).toBe(1);
		expect(discosObjectCount).toBe(1);
		expect(discosEntityCount).toBe(1);
		expect(retainedObject).toEqual({
			discos_object_id: 'legacy-1',
			name: 'LEGACY SAT',
			updated_at: '2026-03-02T01:49:56.716Z'
		});
	});
});
