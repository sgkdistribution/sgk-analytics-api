// ---------------------------------------------------------------------------
// THE ONLY FILE THAT KNOWS THE DATABASE — now written against the REAL schema
// of stream_data_extract_sgk, not guesses.
//
// What we learned from the extract:
//   orders  one row per order.  Client = PartnerName.  Money = OrderCharges.
//           Status is carried as FLAGS (OrderStatusCompleteFlag) rather than
//           strings, which is better — no worrying about spelling or casing.
//   stops   one row per visit to a customer. This is a delivery ATTEMPT.
//           Linked to an order by OrderID, dated by RunDate, and again all the
//           outcomes are flags: StopStatusCompleteFlag, StopStatusFailedFlag,
//           StopTimeOnTimeFlag.
//   drops   finer-grained than stops (splits collection from delivery). Not
//           used here — stops is the right grain for "attempts".
//
// Every name below can still be overridden by an env var, but the defaults are
// now the actual column names, so nothing needs setting for it to work.
// ---------------------------------------------------------------------------
import { query } from './db.js';
import { avgSecondsExpr, columnTypes, configuredUnit } from './durations.js';

const env = (k, fallback) => (process.env[k] || fallback);

function ident(name) {
  const s = String(name || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/.test(s)) {
    throw new Error(`Refusing to use "${s}" as a SQL identifier — check your SCHEMA config.`);
  }
  return s.split('.').map((p) => `\`${p}\``).join('.');
}

export const SCHEMA = {
  orders:        env('SQL_ORDERS_TABLE', 'orders'),
  o_client:      env('SQL_ORDERS_CLIENT_COL', 'PartnerName'),
  o_id:          env('SQL_ORDERS_ID_COL', 'OrderID'),
  o_value:       env('SQL_ORDERS_VALUE_COL', 'OrderCharges'),      // what the client is charged
  o_weight:      env('SQL_ORDERS_WEIGHT_COL', 'OrderWeight'),
  o_cube:        env('SQL_ORDERS_CUBE_COL', 'OrderCube'),
  o_items:       env('SQL_ORDERS_ITEMS_COL', 'OrderItemsCount'),
  o_service:     env('SQL_ORDERS_SERVICE_COL', 'ServiceLevelName'),
  o_completeFlag: env('SQL_ORDERS_COMPLETE_FLAG', 'OrderStatusCompleteFlag'),
  o_date:        env('SQL_ORDERS_DATE_COL', 'OrderDate'),
  o_statusName:  env('SQL_ORDERS_STATUS_COL', 'OrderStatusName'),
  // The three durations the WMS has already worked out for us.
  //
  // NOT IN DAYS — that was an unchecked assumption written when this schema was
  // first read, and it is what put "384,329.26 days" on a client's dashboard.
  // The unit is worked out at runtime in durations.js from the column's real
  // type; see the long note at the top of that file.
  o_confToBook:  env('SQL_ORDERS_CONF_TO_BOOK', 'OrderTimeConfToBook'),
  o_bookToDone:  env('SQL_ORDERS_BOOK_TO_DONE', 'OrderTimeBookToCompleted'),
  o_confToDone:  env('SQL_ORDERS_CONF_TO_DONE', 'OrderTimeConfToCompleted'),
  o_bookReqFlag: env('SQL_ORDERS_BOOK_REQ_FLAG', 'OrderBookingReqFlag'),
  o_bookConfFlag: env('SQL_ORDERS_BOOK_CONF_FLAG', 'OrderBookingConfFlag'),

  attempts:      env('SQL_ATTEMPTS_TABLE', 'stops'),
  a_client:      env('SQL_ATTEMPTS_CLIENT_COL', 'PartnerName'),
  a_order:       env('SQL_ATTEMPTS_ORDER_COL', 'OrderID'),
  a_date:        env('SQL_ATTEMPTS_DATE_COL', 'RunDate'),
  a_okFlag:      env('SQL_ATTEMPTS_OK_FLAG', 'StopStatusCompleteFlag'),
  a_failFlag:    env('SQL_ATTEMPTS_FAIL_FLAG', 'StopStatusFailedFlag'),
  a_onTimeFlag:  env('SQL_ATTEMPTS_ONTIME_FLAG', 'StopTimeOnTimeFlag'),
  a_lateFlag:    env('SQL_ATTEMPTS_LATE_FLAG', 'StopTimeLateFlag'),
  a_earlyFlag:   env('SQL_ATTEMPTS_EARLY_FLAG', 'StopTimeEarlyFlag'),
  a_outstandFlag: env('SQL_ATTEMPTS_OUTSTANDING_FLAG', 'StopStatusOutstandingFlag'),
};

const oDate = (alias = '') => `${alias ? alias + '.' : ''}${ident(SCHEMA.o_date)}`;

// ---------------------------------------------------------------------------
// FILTERS — the client key is never optional and a caller cannot drop it.
// ---------------------------------------------------------------------------
// A company can own several PartnerName values, so the key is always a list.
function clientKeys(f) {
  const keys = Array.isArray(f.clientKey) ? f.clientKey : [f.clientKey];
  const names = keys.map((_, i) => `:ck${i}`);
  const params = {};
  keys.forEach((k, i) => { params[`ck${i}`] = k; });
  return { placeholders: names.join(', '), params };
}

// Cancelled orders are not revenue and were never delivered, so they are left
// out of every figure. Set SQL_ORDERS_EXCLUDE_STATUSES to '' to include them,
// or add more comma-separated statuses to exclude.
const EXCLUDED = String(process.env.SQL_ORDERS_EXCLUDE_STATUSES ?? 'Cancelled')
  .split(',').map((x) => x.trim()).filter(Boolean);

function excludeClause(alias, params) {
  if (!EXCLUDED.length) return '';
  const p = alias ? `${alias}.` : '';
  EXCLUDED.forEach((v, i) => { params[`ex${i}`] = v; });
  return ` AND ${p}${ident(SCHEMA.o_statusName)} NOT IN (${EXCLUDED.map((_, i) => `:ex${i}`).join(', ')})`;
}

// ---------------------------------------------------------------------------
// DATE FILTERING — the single biggest thing that made this service slow.
//
// It used to say `YEAR(OrderDate) = :year AND MONTH(OrderDate) = :month`. That
// reads naturally and it is a disaster for performance: wrapping the column in a
// function makes the condition NON-SARGABLE, so MySQL cannot use an index on the
// date at all. It has to read every row in the table and evaluate YEAR() on each
// one. On an extract this size that is the twenty-plus seconds that produced
// "Query inactivity timeout" on the dashboard.
//
// The same filter as a HALF-OPEN RANGE — `>= '2026-01-01' AND < '2027-01-01'` —
// means exactly the same thing and CAN use an index.
//
// Half-open (< the first day of the next period) rather than BETWEEN, because
// BETWEEN on a DATETIME silently drops everything after 00:00:00 on the last day.
// ---------------------------------------------------------------------------
const pad2 = (n) => String(n).padStart(2, '0');

function yearMonthRange(year, month) {
  const y = Number(year);
  if (!y) return null;
  const m = Number(month);
  if (m >= 1 && m <= 12) {
    const ny = m === 12 ? y + 1 : y;
    const nm = m === 12 ? 1 : m + 1;
    return { start: `${y}-${pad2(m)}-01`, end: `${ny}-${pad2(nm)}-01` };
  }
  return { start: `${y}-01-01`, end: `${y + 1}-01-01` };
}

/** Shared by both filters so orders and stops can never drift apart. */
function pushDateConds(conds, params, d, f) {
  const range = yearMonthRange(f.year, f.month);
  if (range) {
    conds.push(`${d} >= :rangeStart AND ${d} < :rangeEnd`);
    params.rangeStart = range.start;
    params.rangeEnd = range.end;
  } else if (f.month) {
    // A month with no year genuinely does mean "that month in any year", and
    // there is no range that expresses it. Rare, and the UI always sends a year.
    conds.push(`MONTH(${d}) = :month`);
    params.month = Number(f.month);
  }
  if (f.from) { conds.push(`${d} >= :fromDate`); params.fromDate = f.from; }
  if (f.to)   { conds.push(`${d} < DATE_ADD(:toDate, INTERVAL 1 DAY)`); params.toDate = f.to; }
}

function orderFilter(f, alias = '') {
  const p = alias ? `${alias}.` : '';
  const d = oDate(alias);
  const ck = clientKeys(f);
  const conds = [`${p}${ident(SCHEMA.o_client)} IN (${ck.placeholders})`];
  const params = { ...ck.params };

  pushDateConds(conds, params, d, f);
  if (f.service) { conds.push(`${p}${ident(SCHEMA.o_service)} = :service`); params.service = String(f.service); }

  return { where: `WHERE ${conds.join(' AND ')}${excludeClause(alias, params)}`, params, date: d };
}

// stops carry their own PartnerName and ServiceLevelName, so no join is needed.
function attemptFilter(f) {
  const d = `a.${ident(SCHEMA.a_date)}`;
  const ck = clientKeys(f);
  const conds = [`a.${ident(SCHEMA.a_client)} IN (${ck.placeholders})`];
  const params = { ...ck.params };

  pushDateConds(conds, params, d, f);
  if (f.service) { conds.push(`a.\`ServiceLevelName\` = :service`); params.service = String(f.service); }

  return { where: `WHERE ${conds.join(' AND ')}`, params, date: d };
}

// ---------------------------------------------------------------------------
// THE READS
// ---------------------------------------------------------------------------

export async function orderTotals(f) {
  const { where, params } = orderFilter(f);
  // The three duration columns come back as SECONDS whatever they are stored as.
  const t = await columnTypes(SCHEMA.orders, [SCHEMA.o_confToBook, SCHEMA.o_bookToDone, SCHEMA.o_confToDone]);
  const dur = (col) => avgSecondsExpr(t[col], ident(col));

  const rows = await query(`
    SELECT
      SUM(${ident(SCHEMA.o_value)})             AS totalSales,
      COUNT(DISTINCT ${ident(SCHEMA.o_id)})     AS totalOrders,
      SUM(COALESCE(${ident(SCHEMA.o_completeFlag)}, 0)) AS completedOrders,
      AVG(${ident(SCHEMA.o_weight)})            AS avgWeightKg,
      AVG(${ident(SCHEMA.o_cube)})              AS avgCubeM3,
      AVG(${ident(SCHEMA.o_items)})             AS avgItemsPerOrder,
      ${dur(SCHEMA.o_confToBook)}               AS avgReceivedToProposedSec,
      ${dur(SCHEMA.o_bookToDone)}               AS avgReceivedToDeliveredSec,
      ${dur(SCHEMA.o_confToDone)}               AS avgConfToCompletedSec,
      -- the RAW averages, untouched, so the diagnostic can show what the column
      -- actually holds rather than what we decided it holds
      AVG(${ident(SCHEMA.o_confToBook)})        AS rawConfToBook,
      AVG(${ident(SCHEMA.o_bookToDone)})        AS rawBookToDone,
      AVG(${ident(SCHEMA.o_confToDone)})        AS rawConfToDone,
      -- proposals the customer accepted first time round
      SUM(COALESCE(${ident(SCHEMA.o_bookReqFlag)}, 0))  AS bookingsRequested,
      SUM(COALESCE(${ident(SCHEMA.o_bookConfFlag)}, 0)) AS bookingsConfirmed
    FROM ${ident(SCHEMA.orders)}
    ${where}
  `, params);
  return { ...(rows[0] || {}), _durationUnit: configuredUnit(), _columnTypes: t };
}

/**
 * Raw duration figures for /analytics/diag/durations — column types plus MIN,
 * AVG and MAX untouched, so the unit can be settled by looking rather than by
 * anyone guessing again.
 */
export async function durationDiagnostics(f) {
  const { where, params } = orderFilter(f);
  const cols = [SCHEMA.o_confToBook, SCHEMA.o_bookToDone, SCHEMA.o_confToDone];
  const t = await columnTypes(SCHEMA.orders, cols);
  const rows = await query(`
    SELECT
      COUNT(*) AS rows_considered,
      MIN(${ident(SCHEMA.o_confToBook)}) AS minConfToBook, AVG(${ident(SCHEMA.o_confToBook)}) AS avgConfToBook, MAX(${ident(SCHEMA.o_confToBook)}) AS maxConfToBook,
      MIN(${ident(SCHEMA.o_bookToDone)}) AS minBookToDone, AVG(${ident(SCHEMA.o_bookToDone)}) AS avgBookToDone, MAX(${ident(SCHEMA.o_bookToDone)}) AS maxBookToDone,
      MIN(${ident(SCHEMA.o_confToDone)}) AS minConfToDone, AVG(${ident(SCHEMA.o_confToDone)}) AS avgConfToDone, MAX(${ident(SCHEMA.o_confToDone)}) AS maxConfToDone
    FROM ${ident(SCHEMA.orders)}
    ${where}
  `, params);
  return { columnTypes: t, unitInUse: configuredUnit(), raw: rows[0] || {} };
}

// Split of orders across the PartnerName values this company owns — the pie on
// the first page of the report.
export async function byPartner(f) {
  const { where, params } = orderFilter(f);
  return query(`
    SELECT ${ident(SCHEMA.o_client)} AS name, COUNT(DISTINCT ${ident(SCHEMA.o_id)}) AS orders
    FROM ${ident(SCHEMA.orders)}
    ${where}
    GROUP BY ${ident(SCHEMA.o_client)}
    ORDER BY orders DESC
  `, params);
}

// First time right: the order took exactly one visit, and that visit completed.
// NOTE: this no longer recomputes the order count. It used to carry a correlated
// `(SELECT COUNT(*) FROM orders o <where>)` in the select list — a second full
// pass over the same rows orderTotals had already counted, for a number the
// caller was holding anyway. OrderID is the primary key, so COUNT(*) and
// COUNT(DISTINCT OrderID) are the same figure; the server now uses totalOrders.
export async function firstTimeSuccess(f) {
  const { where, params } = orderFilter(f, 'o');
  const rows = await query(`
    SELECT
      SUM(CASE WHEN t.attempts = 1 AND t.good = 1 THEN 1 ELSE 0 END) AS firstTimeSuccessOrders
    FROM (
      SELECT a.${ident(SCHEMA.a_order)} AS OrderID,
             COUNT(*) AS attempts,
             SUM(COALESCE(a.${ident(SCHEMA.a_okFlag)}, 0)) AS good
      FROM ${ident(SCHEMA.attempts)} a
      JOIN ${ident(SCHEMA.orders)} o ON o.${ident(SCHEMA.o_id)} = a.${ident(SCHEMA.a_order)}
      ${where}
      GROUP BY a.${ident(SCHEMA.a_order)}
    ) t
  `, params);
  return rows[0] || {};
}

export async function attemptTotals(f) {
  const { where, params } = attemptFilter(f);
  const rows = await query(`
    SELECT
      COUNT(*)                                            AS total,
      SUM(COALESCE(a.${ident(SCHEMA.a_okFlag)}, 0))       AS successful,
      SUM(COALESCE(a.${ident(SCHEMA.a_failFlag)}, 0))     AS failed,
      SUM(COALESCE(a.${ident(SCHEMA.a_onTimeFlag)}, 0))    AS onTime,
      SUM(COALESCE(a.${ident(SCHEMA.a_lateFlag)}, 0))      AS late,
      SUM(COALESCE(a.${ident(SCHEMA.a_earlyFlag)}, 0))     AS early,
      SUM(COALESCE(a.${ident(SCHEMA.a_outstandFlag)}, 0))  AS outstanding
    FROM ${ident(SCHEMA.attempts)} a
    ${where}
  `, params);
  return rows[0] || {};
}

// Orders nobody has been out to yet.
export async function noAttemptCount(f) {
  const { where, params } = orderFilter(f, 'o');
  const rows = await query(`
    SELECT COUNT(*) AS noAttempt
    FROM ${ident(SCHEMA.orders)} o
    ${where}
      AND NOT EXISTS (
        SELECT 1 FROM ${ident(SCHEMA.attempts)} a
        WHERE a.${ident(SCHEMA.a_order)} = o.${ident(SCHEMA.o_id)}
      )
  `, params);
  return Number(rows[0]?.noAttempt || 0);
}

export async function byMonth(f) {
  const { where, params, date } = orderFilter(f);
  const t = await columnTypes(SCHEMA.orders, [SCHEMA.o_confToBook, SCHEMA.o_bookToDone, SCHEMA.o_confToDone]);
  const dur = (col) => avgSecondsExpr(t[col], ident(col));
  return query(`
    SELECT
      YEAR(${date}) AS y, MONTH(${date}) AS m,
      SUM(${ident(SCHEMA.o_value)})         AS sales,
      COUNT(DISTINCT ${ident(SCHEMA.o_id)}) AS orders,
      AVG(${ident(SCHEMA.o_weight)})        AS avgWeightKg,
      AVG(${ident(SCHEMA.o_cube)})          AS avgCubeM3,
      AVG(${ident(SCHEMA.o_items)})         AS avgItemsPerOrder,
      ${dur(SCHEMA.o_confToDone)}           AS avgConfToCompletedSec,
      ${dur(SCHEMA.o_bookToDone)}           AS avgReceivedToDeliveredSec,
      ${dur(SCHEMA.o_confToBook)}           AS avgReceivedToProposedSec
    FROM ${ident(SCHEMA.orders)}
    ${where}
    GROUP BY YEAR(${date}), MONTH(${date})
    ORDER BY y, m
  `, params);
}

export async function attemptsByMonth(f) {
  const { where, params, date } = attemptFilter(f);
  return query(`
    SELECT
      YEAR(${date}) AS y, MONTH(${date}) AS m,
      COUNT(*)                                        AS total,
      SUM(COALESCE(a.${ident(SCHEMA.a_okFlag)}, 0))   AS successful,
      SUM(COALESCE(a.${ident(SCHEMA.a_failFlag)}, 0)) AS failed,
      SUM(COALESCE(a.${ident(SCHEMA.a_outstandFlag)}, 0)) AS unknown
    FROM ${ident(SCHEMA.attempts)} a
    ${where}
    GROUP BY YEAR(${date}), MONTH(${date})
    ORDER BY y, m
  `, params);
}

// Weeks run Monday to Sunday. WEEKDAY() is 0 on a Monday whatever the locale.
export async function byWeek(f) {
  const { where, params, date } = orderFilter(f);
  const monday = `DATE_SUB(DATE(${date}), INTERVAL WEEKDAY(${date}) DAY)`;
  return query(`
    SELECT
      ${monday} AS weekStart,
      SUM(${ident(SCHEMA.o_value)})         AS sales,
      COUNT(DISTINCT ${ident(SCHEMA.o_id)}) AS orders,
      AVG(${ident(SCHEMA.o_weight)})        AS avgWeightKg,
      AVG(${ident(SCHEMA.o_cube)})          AS avgCubeM3,
      AVG(${ident(SCHEMA.o_items)})         AS avgItemsPerOrder
    FROM ${ident(SCHEMA.orders)}
    ${where}
    GROUP BY ${monday}
    ORDER BY weekStart
  `, params);
}

export async function facets(clientKey) {
  const d = oDate();
  const ck = clientKeys({ clientKey });
  const [years, services] = await Promise.all([
    query(`SELECT DISTINCT YEAR(${d}) AS y FROM ${ident(SCHEMA.orders)} WHERE ${ident(SCHEMA.o_client)} IN (${ck.placeholders}) AND ${d} IS NOT NULL ORDER BY y DESC`, ck.params),
    query(`SELECT DISTINCT ${ident(SCHEMA.o_service)} AS s FROM ${ident(SCHEMA.orders)} WHERE ${ident(SCHEMA.o_client)} IN (${ck.placeholders}) AND ${ident(SCHEMA.o_service)} IS NOT NULL ORDER BY s`, ck.params),
  ]);
  return {
    years: years.map((r) => Number(r.y)).filter(Boolean),
    serviceLevels: services.map((r) => String(r.s)).filter(Boolean),
  };
}

// Every PartnerName in the extract, with how many orders each has. This is what
// goes in CLIENT_MAP as sqlKey — SGK staff can read it straight off the service
// instead of anyone having to run a query by hand.
export async function partnerNames() {
  return query(`
    SELECT ${ident(SCHEMA.o_client)} AS partnerName, COUNT(*) AS orders
    FROM ${ident(SCHEMA.orders)}
    WHERE ${ident(SCHEMA.o_client)} IS NOT NULL AND ${ident(SCHEMA.o_client)} <> ''
    GROUP BY ${ident(SCHEMA.o_client)}
    ORDER BY orders DESC
  `);
}