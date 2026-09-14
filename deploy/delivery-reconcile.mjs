// Delivery-performance reconciliation. Run ON THE LIGHTSAIL BOX.
// Uses the service's own db.js, so it picks up the credentials, the TLS client
// certificates and the timeouts already configured — nothing to type by hand.
import fs from 'node:fs';

// ---------------------------------------------------------------------------
// LOAD THE SERVICE'S OWN SETTINGS.
//
// /etc/sgk-analytics.env is a systemd EnvironmentFile, NOT a shell script, and
// the difference matters here. The SQL password contains ; ' ? and % — source
// that file with `. file` in bash and the semicolon ends the command, the quote
// opens a string, and you get a wall of syntax errors instead of a connection.
// systemd's parser is not the shell's, so the file is read properly, line by
// line, right here.
//
// Needs root only because the file is chmod 600 — which is correct, it holds
// the database password.
// ---------------------------------------------------------------------------
const ENV_FILE = process.env.SGK_ENV_FILE || '/etc/sgk-analytics.env';
if (fs.existsSync(ENV_FILE)) {
  let loaded = 0;
  for (const raw of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1);
    // systemd allows the whole value to be wrapped in one pair of quotes.
    if (val.length > 1 && ((val[0] === '"' && val.endsWith('"')) || (val[0] === "'" && val.endsWith("'")))) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
    loaded += 1;
  }
  console.log(`[env] read ${loaded} settings from ${ENV_FILE}`);
} else {
  console.log(`[env] ${ENV_FILE} not found — relying on whatever is already in the environment`);
}

// Imported AFTER the settings are in place. db.js reads them when it opens the
// pool, not when it is imported, so this order is what makes it connect.
const { query } = await import('/opt/sgk-analytics-api/db.js');

const YEAR = Number(process.argv[2] || new Date().getFullYear());
const KEYS = process.argv.slice(3).length ? process.argv.slice(3)
  : ['ROSELAND FURNITURE', 'Roseland Service Call'];

const FROM = `${YEAR}-01-01`;
const TO = `${YEAR + 1}-01-01`;
const P = KEYS.map((_, i) => `:k${i}`).join(',');
const KP = Object.fromEntries(KEYS.map((k, i) => [`k${i}`, k]));
const A = { ...KP, from: FROM, to: TO };

// Power BI page 2, read off the screenshot, so a match is obvious on sight.
const TARGET = {
  totalOrders: 67392, completedOrders: 63715, firstTimeSuccess: 47188,
  totalAttempts: 72001, successful: 66875, failed: 2543, noAttempt: 1252,
};

const head = (t) => console.log(`\n\n======== ${t} ========`);
const n = (v) => Number(v || 0);

const cols = async (table) => (await query(
  `SELECT COLUMN_NAME c FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t`, { t: table })).map((r) => String(r.c));

const run = async () => {
  const oCols = await cols('orders');
  const sCols = await cols('stops');
  const has = (list, name) => list.some((c) => c.toLowerCase() === name.toLowerCase());
  const real = (list, name) => list.find((c) => c.toLowerCase() === name.toLowerCase());

  console.log(`year ${YEAR}   partners: ${KEYS.join(' | ')}`);

  // -- 0. does the column Power BI page 2 filters on even exist here? ---------
  head('0. COLUMNS THAT MATTER');
  const typeCol = real(oCols, 'OrderTypeName')
    || oCols.find((c) => /ordertype/i.test(c))
    || oCols.find((c) => /type.*name|name.*type/i.test(c));
  console.log('orders  type column :', typeCol || 'NOT FOUND — say so and I will look elsewhere');
  console.log('orders  Type/Seq    :', oCols.filter((c) => /type|seq/i.test(c)).join(', ') || '(none)');
  console.log('stops   Seq/Attempt :', sCols.filter((c) => /seq|attempt|visit/i.test(c)).join(', ') || '(none)');
  console.log('orders  durations   :', oCols.filter((c) => /time|days/i.test(c)).join(', ') || '(none)');

  // -- 1. THE 4,359. Which order types make Power BI's 67,392? ---------------
  if (typeCol) {
    head(`1. ORDER TYPES  — find the combination that makes ${TARGET.totalOrders}`);
    const rows = await query(`
      SELECT COALESCE(\`${typeCol}\`, '(no type)') AS orderType,
             COUNT(*) AS orders,
             SUM(COALESCE(\`OrderStatusCompleteFlag\`,0)) AS completed,
             ROUND(SUM(\`OrderCharges\`),2) AS sales
      FROM \`orders\`
      WHERE \`PartnerName\` IN (${P}) AND \`OrderDate\` >= :from AND \`OrderDate\` < :to
      GROUP BY COALESCE(\`${typeCol}\`, '(no type)')
      ORDER BY orders DESC`, A);
    const all = rows.reduce((s, r) => s + n(r.orders), 0);
    let cum = 0;
    console.table(rows.map((r) => {
      cum += n(r.orders);
      return {
        orderType: r.orderType, orders: n(r.orders), completed: n(r.completed), sales: n(r.sales),
        runningTotal: cum,
        allExceptThisAndAbove: all - cum,
        MATCH: cum === TARGET.totalOrders ? '<<< these types = Power BI'
          : (all - cum) === TARGET.totalOrders ? '<<< everything BELOW this = Power BI' : '',
      };
    }));
    console.log(`every type together: ${all} orders   (Power BI page 1 = 71751, page 2 = ${TARGET.totalOrders})`);
  }

  // -- 2. TOTAL ATTEMPTS: 73,681 here vs 72,001 there ------------------------
  head(`2. TOTAL ATTEMPTS  — which line equals ${TARGET.totalAttempts}?`);
  const att = async (label, where, join) => {
    const r = await query(`
      SELECT COUNT(*) total,
             SUM(COALESCE(a.\`StopStatusCompleteFlag\`,0)) successful,
             SUM(COALESCE(a.\`StopStatusFailedFlag\`,0))   failed
      FROM \`stops\` a ${join} WHERE ${where}`, A);
    const x = r[0] || {};
    return {
      method: label, attempts: n(x.total), successful: n(x.successful), failed: n(x.failed),
      MATCH: n(x.total) === TARGET.totalAttempts ? '<<< this is Power BI' : '',
    };
  };
  const inYear = (c) => `${c} >= :from AND ${c} < :to`;
  const list = [
    await att('A. stop RunDate (what the portal does)',
      `a.\`PartnerName\` IN (${P}) AND ${inYear('a.`RunDate`')}`, ''),
    await att('B. parent ORDER date',
      `o.\`PartnerName\` IN (${P}) AND ${inYear('o.`OrderDate`')}`,
      'JOIN `orders` o ON o.`OrderID` = a.`OrderID`'),
  ];
  if (typeCol) {
    list.push(await att('C. stop RunDate, one order type only',
      `a.\`PartnerName\` IN (${P}) AND ${inYear('a.`RunDate`')} AND o.\`${typeCol}\` = 'Delivery'`,
      'JOIN `orders` o ON o.`OrderID` = a.`OrderID`'));
  }
  console.table(list);

  // -- 3. FIRST TIME SUCCESSFUL: 65,203 here vs 47,188 there -----------------
  head(`3. FIRST TIME SUCCESSFUL  — which definition equals ${TARGET.firstTimeSuccess}?`);
  const per = await query(`
    SELECT o.\`OrderID\` oid,
           COUNT(a.\`OrderID\`) attempts,
           SUM(COALESCE(a.\`StopStatusCompleteFlag\`,0)) good,
           SUM(COALESCE(a.\`StopTimeOnTimeFlag\`,0))     ontime,
           MAX(COALESCE(o.\`OrderStatusCompleteFlag\`,0)) done
           ${typeCol ? `, MAX(o.\`${typeCol}\`) otype` : ''}
    FROM \`orders\` o
    LEFT JOIN \`stops\` a ON a.\`OrderID\` = o.\`OrderID\`
    WHERE o.\`PartnerName\` IN (${P}) AND ${inYear('o.`OrderDate`')}
    GROUP BY o.\`OrderID\``, A);

  const count = (label, fn) => ({
    definition: label, orders: per.filter(fn).length,
    MATCH: per.filter(fn).length === TARGET.firstTimeSuccess ? '<<< this is Power BI' : '',
  });
  const defs = [
    count('A. exactly 1 attempt AND it completed (portal)', (r) => n(r.attempts) === 1 && n(r.good) === 1),
    count('B. exactly 1 attempt, any outcome', (r) => n(r.attempts) === 1),
    count('C. 1 attempt, completed, AND on time', (r) => n(r.attempts) === 1 && n(r.good) === 1 && n(r.ontime) === 1),
    count('D. 1 attempt, completed, AND order complete', (r) => n(r.attempts) === 1 && n(r.good) === 1 && n(r.done) === 1),
    count('E. order complete AND exactly 1 attempt', (r) => n(r.done) === 1 && n(r.attempts) === 1),
  ];
  if (typeCol) {
    defs.push(count("F. portal rule, order type 'Delivery' only",
      (r) => n(r.attempts) === 1 && n(r.good) === 1 && String(r.otype) === 'Delivery'));
  }
  console.table(defs);

  // -- 4. NO ATTEMPT: 1,771 here vs 1,252 there ------------------------------
  head(`4. NO ATTEMPT  — which definition equals ${TARGET.noAttempt}?`);
  const na = [
    count('A. no stop row at all (portal)', (r) => n(r.attempts) === 0),
    count('B. no stop row AND order not complete', (r) => n(r.attempts) === 0 && n(r.done) === 0),
  ];
  if (typeCol) na.push(count("C. no stop row, order type 'Delivery' only",
    (r) => n(r.attempts) === 0 && String(r.otype) === 'Delivery'));
  console.table(na.map((x) => ({ ...x, MATCH: x.orders === TARGET.noAttempt ? '<<< this is Power BI' : '' })));

  // -- 5. THE DURATION CARDS -------------------------------------------------
  head('5. DURATIONS — raw averages in days, so each Power BI card can be matched to its real column');
  const durs = oCols.filter((c) => /time|days/i.test(c));
  if (durs.length) {
    const sel = durs.map((c) => `ROUND(AVG(\`${c}\`)/86400,2) AS \`${c}\``).join(', ');
    console.table(await query(`
      SELECT ${sel}, COUNT(*) AS rowsConsidered FROM \`orders\`
      WHERE \`PartnerName\` IN (${P}) AND ${inYear('`OrderDate`')}`, A));
    console.log('Power BI page 2 says: Confirmed To Booked 1.38 | Booked To Delivered 1.24 | Created To Delivered 4.36');
  }
  process.exit(0);
};

run().catch((e) => { console.error('\nFAILED:', e?.message || e); process.exit(1); });
