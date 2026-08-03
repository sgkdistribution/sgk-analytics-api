// ---------------------------------------------------------------------------
// SCHEMA DISCOVERY — run this once, send me the output.
//
//   Railway -> the service -> Console tab:   npm run discover
//
// It reads metadata plus a handful of DISTINCT values from the columns that look
// like statuses or client keys, so it is safe against a live database. It prints
// NO order data, no customer names, no addresses, no prices — and no password.
// That makes the output safe to send. Your connection details are NOT: those
// belong in Railway and nowhere else.
// ---------------------------------------------------------------------------
import { query } from './db.js';

const LIKELY = /order|delivery|deliver|attempt|consign|job|client|customer|account|service|stock|item|extract|sgk/i;

async function main() {
  const db = process.env.SQL_DATABASE;
  console.log(`=== DATABASE: ${db} ===\n`);

  const tables = await query(`
    SELECT TABLE_NAME AS t, TABLE_TYPE AS kind, TABLE_ROWS AS approxRows
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
    ORDER BY TABLE_NAME
  `);
  console.log(`${tables.length} tables/views:\n`);
  for (const r of tables) {
    console.log(`  ${r.t}${r.kind === 'VIEW' ? '  (view)' : ''}${r.approxRows == null ? '' : `  ~${Number(r.approxRows).toLocaleString()} rows`}`);
  }

  const interesting = tables.filter((r) => LIKELY.test(r.t));
  const chosen = interesting.length ? interesting : tables;

  console.log('\n\n=== COLUMNS ===');
  for (const r of chosen) {
    const cols = await query(`
      SELECT COLUMN_NAME AS c, DATA_TYPE AS d, IS_NULLABLE AS n
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t
      ORDER BY ORDINAL_POSITION
    `, { t: r.t });
    let rows = null;
    try {
      const c = await query(`SELECT COUNT(*) AS n FROM \`${r.t}\``);
      rows = Number(c[0]?.n ?? 0);
    } catch { /* view that needs params, or no permission — fine */ }
    console.log(`\n--- ${r.t}${rows === null ? '' : `  (${rows.toLocaleString()} rows)`}`);
    for (const col of cols) console.log(`    ${String(col.c).padEnd(34)} ${col.d}${col.n === 'YES' ? '' : ' NOT NULL'}`);
  }

  console.log('\n\n=== DISTINCT VALUES IN STATUS / CLIENT COLUMNS ===');
  console.log('(so the service learns what "Successful", "Failed", "On Time" and each client key are actually called)\n');
  for (const r of chosen) {
    const cols = await query(`
      SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t
        AND DATA_TYPE IN ('varchar','char','text','enum')
        AND (COLUMN_NAME LIKE '%status%' OR COLUMN_NAME LIKE '%state%'
             OR COLUMN_NAME LIKE '%service%' OR COLUMN_NAME LIKE '%outcome%'
             OR COLUMN_NAME LIKE '%result%'  OR COLUMN_NAME LIKE '%client%'
             OR COLUMN_NAME LIKE '%account%' OR COLUMN_NAME LIKE '%customer%'
             OR COLUMN_NAME LIKE '%company%' OR COLUMN_NAME LIKE '%retailer%')
    `, { t: r.t });
    for (const col of cols) {
      try {
        const vals = await query(`SELECT DISTINCT \`${col.c}\` AS v FROM \`${r.t}\` WHERE \`${col.c}\` IS NOT NULL ORDER BY \`${col.c}\` LIMIT 30`);
        if (vals.length) console.log(`  ${r.t}.${col.c}: ${vals.map((x) => `"${x.v}"`).join(', ')}`);
      } catch { /* skip anything unreadable */ }
    }
  }

  console.log('\n\nDone. Send me everything above and I will finish queries.js.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nDiscovery failed:', e?.message || e);
  console.error('Check the SQL_* variables and that the MySQL user can read INFORMATION_SCHEMA.');
  process.exit(1);
});
