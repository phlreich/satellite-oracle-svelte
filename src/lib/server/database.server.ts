import Database from 'better-sqlite3';
import Papa from 'papaparse';
import type { ParseResult } from 'papaparse';
import fs from 'fs/promises';
import nfs from 'fs';
import path from 'path';
import { gzip } from 'zlib';
import { promisify } from 'util';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import { env } from '$env/dynamic/private';
import { createLogger, serializeError } from './logger';
import { ensureDiscosTables, refreshDiscosData } from './discos.server';

const DB_PATH = path.join(process.cwd(), 'src/data/satellite.db');
const DB_NEXT_PATH = path.join(process.cwd(), 'src/data/satellite.next.db');
const DB_PREV_PATH = path.join(process.cwd(), 'src/data/satellite.prev.db');
const SCENE_DATA_PATH = path.join(process.cwd(), 'src/data/scene-data.json');
const SCENE_DATA_GZIP_PATH = `${SCENE_DATA_PATH}.gz`;
const gzipAsync = promisify(gzip);
const dbLogger = createLogger('db.maintenance');

const DATASETS = ['satcat', 'boxscore', 'gp'] as const;

function removeIfExistsSync(filePath: string) {
	if (nfs.existsSync(filePath)) {
		nfs.rmSync(filePath, { force: true });
	}
}

function resetDatabaseFiles(filePath: string) {
	removeIfExistsSync(filePath);
	removeIfExistsSync(`${filePath}-wal`);
	removeIfExistsSync(`${filePath}-shm`);
}

function createCoreTables(db: Database.Database) {
	db.exec(`
		CREATE TABLE IF NOT EXISTS boxscore (
			COUNTRY VARCHAR(100) NOT NULL,
			SPADOC_CD VARCHAR(6),
			ORBITAL_TBA DECIMAL(23,0),
			ORBITAL_PAYLOAD_COUNT DECIMAL(23,0),
			ORBITAL_ROCKET_BODY_COUNT DECIMAL(23,0),
			ORBITAL_DEBRIS_COUNT DECIMAL(23,0),
			ORBITAL_TOTAL_COUNT DECIMAL(23,0),
			DECAYED_PAYLOAD_COUNT DECIMAL(23,0),
			DECAYED_ROCKET_BODY_COUNT DECIMAL(23,0),
			DECAYED_DEBRIS_COUNT DECIMAL(23,0),
			DECAYED_TOTAL_COUNT DECIMAL(23,0),
			COUNTRY_TOTAL BIGINT NOT NULL DEFAULT 0
		);

		CREATE TABLE IF NOT EXISTS gp (
			CCSDS_OMM_VERS VARCHAR(3) NOT NULL,
			COMMENT VARCHAR(33) NOT NULL,
			CREATION_DATE DATETIME,
			ORIGINATOR VARCHAR(7) NOT NULL,
			OBJECT_NAME VARCHAR(25),
			OBJECT_ID VARCHAR(12),
			CENTER_NAME VARCHAR(5) NOT NULL,
			REF_FRAME VARCHAR(4) NOT NULL,
			TIME_SYSTEM VARCHAR(3) NOT NULL,
			MEAN_ELEMENT_THEORY VARCHAR(4) NOT NULL,
			EPOCH DATETIME,
			MEAN_MOTION DECIMAL(13,8),
			ECCENTRICITY DECIMAL(13,8),
			INCLINATION DECIMAL(7,4),
			RA_OF_ASC_NODE DECIMAL(7,4),
			ARG_OF_PERICENTER DECIMAL(7,4),
			MEAN_ANOMALY DECIMAL(7,4),
			EPHEMERIS_TYPE TINYINT,
			CLASSIFICATION_TYPE CHAR(1),
			NORAD_CAT_ID INTEGER UNSIGNED PRIMARY KEY NOT NULL,
			ELEMENT_SET_NO SMALLINT UNSIGNED,
			REV_AT_EPOCH MEDIUMINT UNSIGNED,
			BSTAR DECIMAL(19,14),
			MEAN_MOTION_DOT DECIMAL(9,8),
			MEAN_MOTION_DDOT DECIMAL(22,13),
			SEMIMAJOR_AXIS DOUBLE(12,3),
			PERIOD DOUBLE(12,3),
			APOAPSIS DOUBLE(12,3),
			PERIAPSIS DOUBLE(12,3),
			OBJECT_TYPE VARCHAR(12),
			RCS_SIZE CHAR(6),
			COUNTRY_CODE CHAR(6),
			LAUNCH_DATE DATE,
			SITE CHAR(5),
			DECAY_DATE DATE,
			FILE BIGINT UNSIGNED,
			GP_ID INTEGER UNSIGNED NOT NULL,
			TLE_LINE0 VARCHAR(27),
			TLE_LINE1 VARCHAR(71),
			TLE_LINE2 VARCHAR(71)
		);

		CREATE TABLE IF NOT EXISTS satcat (
			INTLDES CHAR(12) NOT NULL,
			NORAD_CAT_ID INTEGER UNSIGNED PRIMARY KEY NOT NULL,
			OBJECT_TYPE VARCHAR(12),
			SATNAME CHAR(25) NOT NULL,
			COUNTRY CHAR(6) NOT NULL,
			LAUNCH DATE,
			SITE CHAR(5),
			DECAY DATE,
			PERIOD DECIMAL(12,2),
			INCLINATION DECIMAL(12,2),
			APOGEE INTEGER UNSIGNED,
			PERIGEE INTEGER UNSIGNED,
			COMMENT CHAR(32),
			COMMENTCODE TINYINT UNSIGNED,
			RCSVALUE INTEGER NOT NULL DEFAULT 0,
			RCS_SIZE VARCHAR(6),
			FILE SMALLINT UNSIGNED NOT NULL DEFAULT 0,
			LAUNCH_YEAR SMALLINT UNSIGNED NOT NULL DEFAULT 0,
			LAUNCH_NUM SMALLINT UNSIGNED NOT NULL DEFAULT 0,
			LAUNCH_PIECE VARCHAR(3) NOT NULL,
			CURRENT CHAR(1) NOT NULL DEFAULT 'N' CHECK (CURRENT IN ('Y', 'N')),
			OBJECT_NAME CHAR(25) NOT NULL,
			OBJECT_ID CHAR(12) NOT NULL,
			OBJECT_NUMBER INTEGER UNSIGNED
		);
	`);
}

async function loadCsvIntoTable(
	db: Database.Database,
	table: string,
	csvPath: string,
	insertMode: 'insert' | 'replace'
) {
	const startedAt = Date.now();
	dbLogger.info(`${table} update started`);
	const text = await fs.readFile(csvPath, 'utf8');
	const parseResult: ParseResult<{ [key: string]: string }> = Papa.parse(text, {
		header: true,
		skipEmptyLines: true
	});
	const rows = parseResult.data;

	db.exec('BEGIN');
	try {
		db.prepare(`DELETE FROM ${table}`).run();
		if (rows.length > 0) {
			const columns = Object.keys(rows[0]);
			const placeholders = columns.map((col) => `@${col}`).join(',');
			const verb = insertMode === 'replace' ? 'INSERT OR REPLACE' : 'INSERT';
			const insert = db.prepare(
				`${verb} INTO ${table} (${columns.join(',')}) VALUES (${placeholders})`
			);
			for (const row of rows) {
				const params: { [key: string]: string | null } = {};
				for (const col of columns) {
					params[col] = row[col] === '' ? null : row[col];
				}
				insert.run(params);
			}
		}
		db.exec('COMMIT');
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}

	dbLogger.info(`${table} update completed`, {
		rowCount: rows.length,
		durationMs: Date.now() - startedAt
	});
}

async function deleteUnusedRows(db: Database.Database) {
	const startedAt = Date.now();
	dbLogger.info('deleting unused rows started');
	db.exec('BEGIN');
	try {
		db.exec(`
			DELETE FROM satcat
			WHERE NOT EXISTS (
				SELECT 1 FROM gp
				WHERE gp.norad_cat_id = satcat.norad_cat_id
				AND gp.decay_date IS NULL
			)
			OR current != 'Y'
			OR comment IS NOT NULL
			OR comment != ''
		`);

		db.exec(`
			DELETE FROM gp
			WHERE decay_date IS NOT NULL
			OR NOT EXISTS (
				SELECT 1 FROM satcat
				WHERE gp.norad_cat_id = satcat.norad_cat_id
				AND satcat.current = 'Y'
				AND (satcat.comment IS NULL OR satcat.comment = '')
			)
		`);

		db.exec('COMMIT');
		dbLogger.info('deleting unused rows completed', {
			durationMs: Date.now() - startedAt
		});
	} catch (error) {
		db.exec('ROLLBACK');
		throw error;
	}
}

interface SatelliteRow {
	EPOCH: string;
	TLE_LINE1: string;
	TLE_LINE2: string;
	NORAD_CAT_ID: number;
	OBJECT_NAME: string;
}

export async function getSceneData(
	dbPath = DB_PATH
): Promise<Array<[string, string, string, number, string]>> {
	const db = new Database(dbPath, { readonly: true, fileMustExist: true });
	try {
		const sql = `
		SELECT gp.EPOCH, gp.TLE_LINE1, gp.TLE_LINE2, gp.NORAD_CAT_ID, satcat.OBJECT_NAME
		FROM gp JOIN satcat ON gp.NORAD_CAT_ID = satcat.NORAD_CAT_ID
		`;
		const rows = db.prepare(sql).all() as SatelliteRow[];
		return rows.map((row) => [
			row.EPOCH,
			row.TLE_LINE1,
			row.TLE_LINE2,
			row.NORAD_CAT_ID,
			row.OBJECT_NAME
		]);
	} finally {
		db.close();
	}
}

async function writeSceneDataArtifacts(sceneData: Array<[string, string, string, number, string]>) {
	const json = JSON.stringify(sceneData);
	const gzipBuffer = await gzipAsync(json, { level: 9 });
	const tmpSceneDataPath = `${SCENE_DATA_PATH}.tmp`;
	const tmpSceneDataGzipPath = `${SCENE_DATA_GZIP_PATH}.tmp`;

	await fs.writeFile(tmpSceneDataPath, json, 'utf8');
	await fs.writeFile(tmpSceneDataGzipPath, gzipBuffer);
	await fs.rename(tmpSceneDataPath, SCENE_DATA_PATH);
	await fs.rename(tmpSceneDataGzipPath, SCENE_DATA_GZIP_PATH);
	dbLogger.info('scene-data artifacts updated', {
		sceneDataPath: SCENE_DATA_PATH,
		sceneDataKb: Math.round(json.length / 1024),
		sceneDataGzipPath: SCENE_DATA_GZIP_PATH,
		sceneDataGzipKb: Math.round(gzipBuffer.length / 1024)
	});
}

async function getSpaceTrackCookie(username: string, password: string): Promise<string> {
	const loginUrl = 'https://www.space-track.org/ajaxauth/login';
	const credentials = `identity=${encodeURIComponent(username)}&password=${encodeURIComponent(
		password
	)}`;

	const response = await fetch(loginUrl, {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded'
		},
		body: credentials
	});

	if (!response.ok) {
		throw new Error('Login failed');
	}

	const cookie = response.headers.get('Set-Cookie');
	if (cookie === null) {
		throw new Error('Failed to retrieve cookie');
	}

	return cookie;
}

async function fetchSpaceTrackData(cookie: string, url: string): Promise<string> {
	const response = await fetch(url, {
		headers: {
			Cookie: cookie
		}
	});

	if (!response.ok) {
		throw new Error(`Failed to fetch data: ${response.statusText}`);
	}

	return response.text();
}

export async function updateCSVs(username?: string, password?: string) {
	const startedAt = Date.now();
	try {
		if (!username || !password) {
			dbLogger.warn('missing credentials; skipping CSV refresh');
			return;
		}
		const cookie = await getSpaceTrackCookie(username, password);

		for (const dataset of DATASETS) {
			const data = await fetchSpaceTrackData(
				cookie,
				`https://www.space-track.org/basicspacedata/query/class/${dataset}/format/csv`
			);
			await fs.writeFile(`${process.cwd()}/src/data/${dataset}.csv`, data, 'utf8');
			dbLogger.debug('dataset CSV refreshed', { dataset, bytes: data.length });
		}
		dbLogger.info('CSV refresh completed', { durationMs: Date.now() - startedAt });
	} catch (error) {
		dbLogger.error('CSV refresh failed', {
			durationMs: Date.now() - startedAt,
			error: serializeError(error)
		});
	}
}

async function ensureSourceCsvs() {
	const missing = DATASETS.filter(
		(dataset) => !nfs.existsSync(`${process.cwd()}/src/data/${dataset}.csv`)
	);
	if (missing.length === 0) {
		dbLogger.info('source CSV files present; skipping download');
		return;
	}
	dbLogger.info('source CSV files missing; downloading', { missing });
	await updateCSVs(env.EMAIL, env.PASSWORD);
	const stillMissing = DATASETS.filter(
		(dataset) => !nfs.existsSync(`${process.cwd()}/src/data/${dataset}.csv`)
	);
	if (stillMissing.length > 0) {
		throw new Error(`Missing source CSV files after refresh: ${stillMissing.join(', ')}`);
	}
}

async function buildNextDatabase(targetPath: string) {
	const startedAt = Date.now();
	resetDatabaseFiles(targetPath);
	const db = new Database(targetPath);
	try {
		createCoreTables(db);
		ensureDiscosTables(db);
		await loadCsvIntoTable(db, 'satcat', `${process.cwd()}/src/data/satcat.csv`, 'insert');
		await loadCsvIntoTable(db, 'boxscore', `${process.cwd()}/src/data/boxscore.csv`, 'insert');
		await loadCsvIntoTable(db, 'gp', `${process.cwd()}/src/data/gp.csv`, 'replace');
		await deleteUnusedRows(db);
		await refreshDiscosData(db);
		dbLogger.info('next database build completed', {
			targetPath,
			durationMs: Date.now() - startedAt
		});
	} finally {
		db.close();
	}
}

async function swapInNextDatabase() {
	if (nfs.existsSync(DB_PREV_PATH)) {
		await fs.rm(DB_PREV_PATH, { force: true });
	}
	if (nfs.existsSync(DB_PATH)) {
		await fs.rename(DB_PATH, DB_PREV_PATH);
	}
	await fs.rename(DB_NEXT_PATH, DB_PATH);
	removeIfExistsSync(`${DB_PATH}-wal`);
	removeIfExistsSync(`${DB_PATH}-shm`);
	removeIfExistsSync(`${DB_NEXT_PATH}-wal`);
	removeIfExistsSync(`${DB_NEXT_PATH}-shm`);
	dbLogger.info('database swap completed', {
		livePath: DB_PATH,
		backupPath: DB_PREV_PATH
	});
}

async function buildAndSwapDatabase() {
	await buildNextDatabase(DB_NEXT_PATH);
	await swapInNextDatabase();
	const sceneData = await getSceneData(DB_PATH);
	await writeSceneDataArtifacts(sceneData);
	return sceneData.length;
}

export async function initializeDatabaseAndSetCache() {
	const startTime = Date.now();
	dbLogger.info('database initialization started');
	try {
		await ensureSourceCsvs();
		const sceneDataRows = await buildAndSwapDatabase();
		dbLogger.info('database initialization completed', {
			durationMs: Date.now() - startTime,
			sceneDataRows
		});
	} catch (error) {
		dbLogger.error('database initialization failed', {
			durationMs: Date.now() - startTime,
			error: serializeError(error)
		});
	}
}

export async function refreshData() {
	const startTime = Date.now();
	dbLogger.info('scheduled database refresh started', { startTime });
	await updateCSVs(env.EMAIL, env.PASSWORD);
	await ensureSourceCsvs();
	const sceneDataRows = await buildAndSwapDatabase();
	const endTime = Date.now();
	dbLogger.info('scheduled database refresh completed', {
		endTime,
		durationSeconds: (endTime - startTime) / 1000,
		sceneDataRows
	});
}
