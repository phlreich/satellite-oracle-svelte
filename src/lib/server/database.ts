import Database from 'better-sqlite3';
// import { DB_PATH } from '$env/static/private';
import type { satcatRow } from './types.js';
import Papa from 'papaparse';
import type { ParseResult } from 'papaparse';
const DB_PATH = '../../data/satellite.db'
import fs from 'fs/promises';

const db = new Database(DB_PATH, { verbose: console.log });

export function getSatcatHead(limit = 10): satcatRow[] {
  const sql = `
  select * from satcat
limit $limit  
  `;
  const stmnt = db.prepare(sql);
  const rows = stmnt.all({ limit });
  return rows as satcatRow[];
}

export async function updateSatcat() {
  try {
    //const response = await fetch('https://celestrak.com/pub/satcat.csv');
    //const text = await response.text();
    const text = await fs.readFile('../../data/satcat.csv', 'utf8');

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
    
      console.log("Expected number of values:", columns.length);
    
      for (const row of data) {
        if (Object.values(row).length !== columns.length) {
          console.log("Mismatched row:", row);
          continue; // Skip this row
        }
    
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

// updateSatcat();
console.log(getSatcatHead(10));

// const s = [...Array(17)].map((_,i)=>"$"+(i+1)).join(','); // $1,$2,$3,...,$17
// const updateSatcatData = async (pool) => {
//   try {
//     const response = await fetch('https://celestrak.com/pub/satcat.csv');
//     const data = Papa.parse(await response.text(), { header: true }).data.slice(0, -1);
//     await pool.query('TRUNCATE TABLE satcatdata');
//     const query = `INSERT INTO satcatdata (${Object.keys(data[0])}) VALUES (${s})`;
//     await Promise.all(data.map(row =>
//       pool.query(query, Object.values(row).map(value => value === '' ? null : value))
//     ));
//   } catch (err) {
//     console.error(err);
//   }
// };