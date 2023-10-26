// src/lib/server/database.server.ts
import Database from 'better-sqlite3';
import type { satcatRow } from './types.js';
import Papa from 'papaparse';
import type { ParseResult } from 'papaparse';
import fs from 'fs/promises';
import path from 'path';
import { EMAIL, PASSWORD } from '$env/static/private';


const DB_PATH = path.join(process.cwd(), 'src/data/satellite.db');

const db = new Database(DB_PATH, { verbose: console.log });
db.pragma('journal_mode = WAL');

export async function initializeDatabase() {

  try {

    function checkTableExists(tableName: string): boolean {
      const result = db.prepare(`SELECT count(*) FROM sqlite_master WHERE type='table' AND name=?;`).get(tableName) as { 'count(*)': number };
      return result['count(*)'] > 0;
    }

    function isTableNonEmpty(tableName: string): boolean {
      const result = db.prepare(`SELECT count(*) FROM ${tableName};`).get() as { 'count(*)': number };
      return result['count(*)'] > 0;
    }

    const tables = ["gp", "satcat", "boxscore"];
    const allTablesExist = tables.every(checkTableExists);
    const allTablesNonEmpty = allTablesExist && tables.every(isTableNonEmpty);

    if (!allTablesExist || !allTablesNonEmpty) {

      const createBoxscoreTable = `CREATE TABLE boxscore ( 
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
    COUNTRY_TOTAL BIGINT NOT NULL DEFAULT 0 );`;

      const createGpTable = `CREATE TABLE IF NOT EXISTS gp ( 
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
    TLE_LINE2 VARCHAR(71) );`;

      const createSatcatTable = `CREATE TABLE satcat ( 
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
    OBJECT_NUMBER INTEGER UNSIGNED );`;

      db.exec(createBoxscoreTable);
      db.exec(createGpTable);
      db.exec(createSatcatTable);

      console.log('Tables created.');
      await updateCSVs(EMAIL, PASSWORD);
      await updateSatcat();
      await updateBoxscore();
      await updateGP();
      await checkpoint();
    }

  } catch (err) {
    console.error('Error checking database tables:', err);
    // TODO implement error handling
  }
}

export function getSatcatHead(limit = 2): satcatRow[] {
  const sql = `
  SELECT * FROM satcat
limit $limit  
  `;
  const stmnt = db.prepare(sql);
  const rows = stmnt.all({ limit });
  return rows as satcatRow[];
}

export async function getSceneData() {
  const sql = `
  SELECT NORAD_CAT_ID, EPOCH, TLE_LINE1, TLE_LINE2 FROM gp;
  `;
  const stmnt = db.prepare(sql);
  const rows = stmnt.all();
  return rows;
}

// SERVER MAINTANENCE FUNCTIONS

export async function updateSatcat() {
  try {
    console.log('Updating satcat database');
    const text = await fs.readFile(process.cwd() + '/src/data/satcat.csv', 'utf8');

    const parseResult: ParseResult<{ [key: string]: string }> = Papa.parse(text, { header: true, skipEmptyLines: true });
    const data = parseResult.data;

    db.exec('BEGIN');
    db.prepare('DELETE FROM satcat').run();

    if (data.length > 0) {
      const columns = Object.keys(data[0]);

      // Create named placeholders
      const placeholders = columns.map(col => "@" + col).join(',');

      const query = `INSERT INTO satcat (${columns.join(',')}) VALUES (${placeholders})`;
      const insert = db.prepare(query);

      for (const row of data) {

        // Convert row to an object with proper named parameters
        const params: { [key: string]: string | null } = {};
        columns.forEach((col, index) => {
          params[col] = row[col] === '' ? null : row[col];
        });

        insert.run(params);
      }
    }

    db.exec('COMMIT');
  } catch (err) {
    console.error(err);
    db.exec('ROLLBACK');
  }
};

export async function updateGP() {
  try {
    console.log('Updating gp database');
    const text = await fs.readFile(process.cwd() + '/src/data/gp.csv', 'utf8');

    const parseResult: ParseResult<{ [key: string]: string }> = Papa.parse(text, { header: true, skipEmptyLines: true });
    const data = parseResult.data;

    db.exec('BEGIN');
    db.prepare('DELETE FROM gp').run();

    if (data.length > 0) {
      const columns = Object.keys(data[0]);

      // Create named placeholders
      const placeholders = columns.map(col => "@" + col).join(',');

      const query = `INSERT INTO gp (${columns.join(',')}) VALUES (${placeholders})`;
      const insert = db.prepare(query);

      for (const row of data) {

        // Convert row to an object with proper named parameters
        const params: { [key: string]: string | null } = {};
        columns.forEach((col, index) => {
          params[col] = row[col] === '' ? null : row[col];
        });

        insert.run(params);
      }
    }

    db.exec('COMMIT');
  }
  catch (err) {
    console.error(err);
  }
}


export async function updateBoxscore() {
  try {
    console.log('Updating boxscore database');
    const text = await fs.readFile(process.cwd() + '/src/data/boxscore.csv', 'utf8');

    const parseResult: ParseResult<{ [key: string]: string }> = Papa.parse(text, { header: true, skipEmptyLines: true });
    const data = parseResult.data;

    db.exec('BEGIN');
    db.prepare('DELETE FROM boxscore').run();

    if (data.length > 0) {
      const columns = Object.keys(data[0]);

      // Create named placeholders
      const placeholders = columns.map(col => "@" + col).join(',');

      const query = `INSERT INTO boxscore (${columns.join(',')}) VALUES (${placeholders})`;
      const insert = db.prepare(query);

      for (const row of data) {

        // Convert row to an object with proper named parameters
        const params: { [key: string]: string | null } = {};
        columns.forEach((col, index) => {
          params[col] = row[col] === '' ? null : row[col];
        });

        insert.run(params);
      }
    }

    db.exec('COMMIT');
  }
  catch (err) {
    console.error(err);
  }
}

async function getSpaceTrackCookie(username: string, password: string): Promise<string> {
  const loginUrl = 'https://www.space-track.org/ajaxauth/login';
  const credentials = `identity=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

  const response = await fetch(loginUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: credentials
  });

  // Check if the login is successful
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
      'Cookie': cookie
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch data: ${response.statusText}`);
  }

  return response.text();
}

export async function updateCSVs(username: string, password: string) {
  try {
    const cookie = await getSpaceTrackCookie(username, password);

    const datasets = [
      'satcat',
      'gp',
      'boxscore'
    ];
    for (const [index, dataset] of datasets.entries()) {
      const data = await fetchSpaceTrackData(cookie, 'https://www.space-track.org/basicspacedata/query/class/' + dataset + '/format/csv');
      await fs.writeFile(`${process.cwd()}/src/data/${dataset}.csv`, data, 'utf8');
    }

  } catch (err) {
    console.error("Error updating CSVs:", err);
  }
}

export async function checkpoint() {
  try {
    console.log('Triggering database checkpoint');
    await db.pragma('wal_checkpoint(TRUNCATE)');
    console.log('Checkpoint completed');
  } catch (err) {
    console.error('Error during checkpoint:', err);
  }
}
