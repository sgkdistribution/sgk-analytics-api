// ---------------------------------------------------------------------------
// SCHEMA DISCOVERY — run this once, send me the output.
//
//   npm install
//   npm run discover              (with the SQL_* variables set in .env or your shell)
//
// It reads nothing but metadata plus a handful of DISTINCT values from the
// columns that look like statuses, so it is safe to run against production. It
// prints NO order data, no customer names, no addresses, no prices.
//
// It does not print your password either — so the output is safe to paste to me
// in a chat, which your connection details are NOT. Keep those in Railway.
// ---------------------------------------------------------------------------
import { query } from './db.js';

const LIKELY = /order|delivery|deliver|attempt|consign|job|client|customer|account|service|stock|item/i;

async function main() {
  console.log('=== TABLES AND VIEWS ===\n');
  const tables = await query(`
    SELECT TABLE_SCHEMA AS s, TABLE_NAME AS t, TABLE_TYPE AS kind
    FROM INFORMATION_SCHEMA.TABLES
    ORDER BY TABLE_SCHEMA, TABLE_NAME
  `);
  const interesting = tables.filter((r) => LIKELY.test(r.t));
  console.log(`${tables.length} objects total, ${interesting.length} look relevant:\n`);
  for (const r of interesting) console.log(`  ${r.s}.${r.t}  (${r.kind === 'VIEW' ? 'view' : 'table'})`);

  console.log('\n\n=== COLUMNS ON THOSE OBJECTS ===');
  for (const r of interesting) {
    const cols = await query(`
      SELECT COLUMN_NAME AS c, DATA_TYPE AS d, IS_NULLABLE AS n
      FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @s AND TABLE_NAME = @t
      ORDER BY ORDINAL_POSITION
    `, { s: r.s, t: r.t });
    let rows = null;
    try {
      const c = await query(`SELECT COUNT(*) AS n FROM [${r.s}].[${r.t}]`);
      rows = Number(c[0]?.n ?? 0);
    } catch { /* permission or view that needs params — fine */ }
    console.log(`\n--- ${r.s}.${r.t}${rows === null ? '' : `  (${rows.toLocaleString()} rows)`}`);
    for (const col of cols) console.log(`    ${col.c.padEnd(34)} ${col.d}${col.n === 'YES' ? '' : ' NOT NULL'}`);
  }

  console.log('\n\n=== DISTINCT VALUES IN STATUS-LIKE COLUMNS ===');
  console.log('(so the service knows what "Successful", "Failed" and "On Time" are actually called)\n');
  for (const r of interesting) {
    const cols = await query(`
      SELECT COLUMN_NAME AS c FROM INFORMATION_SCHEMA.COLUMNS
      WHERE TABLE_SCHEMA = @s AND TABLE_NAME = @t
        AND DATA_TYPE IN ('varchar','nvarchar','char','nchar')
        AND (COLUMN_NAME LIKE '%status%' OR COLUMN_NAME LIKE '%state%'
             OR COLUMN_NAME LIKE '%service%level%' OR COLUMN_NAME LIKE '%outcome%'
             OR COLUMN_NAME LIKE '%result%' OR COLUMN_NAME LIKE '%client%' OR COLUMN_NAME LIKE '%account%')
    `, { s: r.s, t: r.t });
    for (const col of cols) {
      try {
        const vals = await query(`SELECT DISTINCT TOP 25 [${col.c}] AS v FROM [${r.s}].[${r.t}] WHERE [${col.c}] IS NOT NULL ORDER BY [${col.c}]`);
        if (vals.length) console.log(`  ${r.s}.${r.t}.${col.c}: ${vals.map((x) => `"${x.v}"`).join(', ')}`);
      } catch { /* skip anything we cannot read */ }
    }
  }

  console.log('\n\nDone. Send me everything above and I will finish queries.js.');
  process.exit(0);
}

main().catch((e) => {
  console.error('\nDiscovery failed:', e?.message || e);
  console.error('Check the SQL_* settings and that the login can read INFORMATION_SCHEMA.');
  process.exit(1);
});
