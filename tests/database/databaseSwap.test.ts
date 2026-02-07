import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('$env/dynamic/private', () => ({
	env: {
		TOKEN_DW: '',
		EMAIL: '',
		PASSWORD: ''
	}
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

describe.sequential('database refresh swap smoke', () => {
	const originalCwd = process.cwd();
	let tempDir = '';

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sat-oracle-swap-'));
		const dataDir = path.join(tempDir, 'src/data');
		fs.mkdirSync(dataDir, { recursive: true });
		fs.writeFileSync(path.join(dataDir, 'satcat.csv'), SATCAT_CSV, 'utf8');
		fs.writeFileSync(path.join(dataDir, 'boxscore.csv'), BOXSCORE_CSV, 'utf8');
		fs.writeFileSync(path.join(dataDir, 'gp.csv'), GP_CSV, 'utf8');

		const oldDbPath = path.join(dataDir, 'satellite.db');
		const oldDb = new Database(oldDbPath);
		oldDb.exec(`
			CREATE TABLE marker (value TEXT);
			INSERT INTO marker(value) VALUES ('old-live-db');
		`);
		oldDb.close();

		process.chdir(tempDir);
	});

	afterEach(() => {
		process.chdir(originalCwd);
		if (tempDir) {
			fs.rmSync(tempDir, { recursive: true, force: true });
		}
	});

	it('leaves a valid live sqlite file after refresh and keeps previous backup', async () => {
		vi.resetModules();
		const { refreshData } = await import('../../src/lib/server/database.server');

		await refreshData();

		const dataDir = path.join(tempDir, 'src/data');
		const liveDbPath = path.join(dataDir, 'satellite.db');
		const prevDbPath = path.join(dataDir, 'satellite.prev.db');
		const nextDbPath = path.join(dataDir, 'satellite.next.db');

		expect(fs.existsSync(liveDbPath)).toBe(true);
		expect(fs.existsSync(prevDbPath)).toBe(true);
		expect(fs.existsSync(nextDbPath)).toBe(false);

		const liveDb = new Database(liveDbPath, { readonly: true });
		const gpCount = (
			liveDb.prepare('SELECT COUNT(*) AS count FROM gp').get() as { count: number }
		).count;
		const joinedCount = (
			liveDb
				.prepare(
					'SELECT COUNT(*) AS count FROM gp JOIN satcat ON gp.NORAD_CAT_ID = satcat.NORAD_CAT_ID'
				)
				.get() as { count: number }
		).count;
		liveDb.close();

		expect(gpCount).toBe(1);
		expect(joinedCount).toBe(1);

		const prevDb = new Database(prevDbPath, { readonly: true });
		const marker = prevDb.prepare('SELECT value FROM marker').get() as { value: string };
		prevDb.close();
		expect(marker.value).toBe('old-live-db');
	});
});
