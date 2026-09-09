// ---------------------------------------------------------------------------
// THE ONLY FILE THAT KNOWS THE DATABASE.
//
// It no longer knows it by ASSUMPTION. Every table and column name used below is
// resolved against the live database first (see schema.js) and the SQL is built
// from what is really there. That is the difference between "somebody renamed a
// column and the whole dashboard went dark" and "somebody renamed a column and
// nothing happened".
//
// What the extract holds:
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
// Those are the names as at the last discovery run. They are the FIRST thing
// looked for, not the only thing: if the extract has moved on, schema.js finds
// where it moved to, and anything that is genuinely gone is left out of the SQL
// so its tile shows a dash instead of taking the page down with it.
//
// Every name can still be pinned with an env var (SQL_ORDERS_CLIENT_COL and
// friends) — that is checked before anything else.
// ---------------------------------------------------------------------------
import { query } from './db.js';
import { avgSecondsExpr, sumSecondsExpr, columnTypes, configuredUnit } from './durations.js';
import { resolveSchema, ident, CONFIGURED } from './schema.js';

/**
 * The names this service EXPECTS, before the database is consulted.
 *
 * Kept as a named export because it is the readable statement of intent; the
 * names actually used in a query come from `await resolveSchema()`.
 */
export const SCHEMA = CONFIGURED;

/**
 * A column, quoted — or the literal NULL when the database does not have it.
 *
 * This is the whole graceful-degradation mechanism, and it is deliberately
 * boring: `SUM(NULL)` and `AVG(NULL)` are valid MySQL and both return NULL, so a
 * missing measure arrives at the dashboard as "no figure" and every other column
 * in the same SELECT is completely unaffected.
 */
const col = (name) => (name ? ident(name) : 'NULL');

/**
 * The same, for a column on an aliased table.
 *
 * It has to be its own helper rather than `a.` + col(): a missing column has to
 * collapse to the bare literal `NULL`, and `a.NULL` is not valid SQL — it would
 * turn a missing flag into a syntax error and take the whole read down, which is
 * the exact failure this file exists to stop.
 */
const aliasCol = (alias, name) => (name ? `${alias}.${ident(name)}` : 'NULL');

/** Is this column really there? Used where NULL is not a valid substitute. */
const has = (name) => Boolean(name);

const oDate = (S, alias = '') => `${alias ? alias + '.' : ''}${ident(S.o_date)}`;

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

function excludeClause(S, alias, params) {
  // No status column in the extract any more means nothing to exclude ON. Left
  // out rather than faked: including cancelled orders is a visible, explainable
  // difference, and it is reported by /health as an unavailable column.
  if (!EXCLUDED.length || !has(S.o_statusName)) return '';
  const p = alias ? `${alias}.` : '';
  EXCLUDED.forEach((v, i) => { params[`ex${i}`] = v; });
  return ` AND ${p}${ident(S.o_statusName)} NOT IN (${EXCLUDED.map((_, i) => `:ex${i}`).join(', ')})`;
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

function orderFilter(S, f, alias = '') {
  const p = alias ? `${alias}.` : '';
  const d = oDate(S, alias);
  const ck = clientKeys(f);
  const conds = [`${p}${ident(S.o_client)} IN (${ck.placeholders})`];
  const params = { ...ck.params };

  pushDateConds(conds, params, d, f);
  // A service filter with no service column would silently match nothing. The
  // dropdown is fed from the same column, so it is empty in that case and this
  // never fires — but if one is passed by hand it is ignored rather than
  // quietly emptying the dashboard.
  if (f.service && has(S.o_service)) { conds.push(`${p}${ident(S.o_service)} = :service`); params.service = String(f.service); }

  return { where: `WHERE ${conds.join(' AND ')}${excludeClause(S, alias, params)}`, params, date: d };
}

// stops carry their own PartnerName and ServiceLevelName, so no join is needed.
function attemptFilter(S, f) {
  const d = `a.${ident(S.a_date)}`;
  const ck = clientKeys(f);
  const conds = [`a.${ident(S.a_client)} IN (${ck.placeholders})`];
  const params = { ...ck.params };

  pushDateConds(conds, params, d, f);
  if (f.service && has(S.a_service)) { conds.push(`a.${ident(S.a_service)} = :service`); params.service = String(f.service); }

  return { where: `WHERE ${conds.join(' AND ')}`, params, date: d };
}

/**
 * The three duration columns' real types — asked for only for the ones that
 * exist, so a renamed column cannot make this fail.
 */
async function durationTypes(S) {
  const cols = [S.o_confToBook, S.o_bookToDone, S.o_confToDone].filter(Boolean);
  return cols.length ? columnTypes(S.orders, cols) : {};
}

/** AVG of a duration column in seconds, or NULL when the column is not there. */
const durAvg = (types, name) => (name ? avgSecondsExpr(types[name], ident(name)) : 'NULL');
/** SUM of a duration column in seconds, or NULL when the column is not there. */
const durSum = (types, name) => (name ? sumSecondsExpr(types[name], ident(name)) : 'NULL');

// ---------------------------------------------------------------------------
// THE READS
// ---------------------------------------------------------------------------

export async function orderTotals(f) {
  const S = await resolveSchema();
  const { where, params } = orderFilter(S, f);
  // The three duration columns come back as SECONDS whatever they are stored as.
  const t = await durationTypes(S);

  const rows = await query(`
    SELECT
      SUM(${col(S.o_value)})               AS totalSales,
      COUNT(DISTINCT ${ident(S.o_id)})     AS totalOrders,
      SUM(COALESCE(${col(S.o_completeFlag)}, 0)) AS completedOrders,
      AVG(${col(S.o_weight)})              AS avgWeightKg,
      AVG(${col(S.o_cube)})                AS avgCubeM3,
      AVG(${col(S.o_items)})               AS avgItemsPerOrder,
      ${durAvg(t, S.o_confToBook)}         AS avgReceivedToProposedSec,
      ${durAvg(t, S.o_bookToDone)}         AS avgReceivedToDeliveredSec,
      ${durAvg(t, S.o_confToDone)}         AS avgConfToCompletedSec,
      -- the RAW averages, untouched, so the diagnostic can show what the column
      -- actually holds rather than what we decided it holds
      AVG(${col(S.o_confToBook)})          AS rawConfToBook,
      AVG(${col(S.o_bookToDone)})          AS rawBookToDone,
      AVG(${col(S.o_confToDone)})          AS rawConfToDone,
      -- proposals the customer accepted first time round
      SUM(COALESCE(${col(S.o_bookReqFlag)}, 0))  AS bookingsRequested,
      SUM(COALESCE(${col(S.o_bookConfFlag)}, 0)) AS bookingsConfirmed
    FROM ${ident(S.orders)}
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
  const S = await resolveSchema();
  const { where, params } = orderFilter(S, f);
  const t = await durationTypes(S);
  const rows = await query(`
    SELECT
      COUNT(*) AS rows_considered,
      MIN(${col(S.o_confToBook)}) AS minConfToBook, AVG(${col(S.o_confToBook)}) AS avgConfToBook, MAX(${col(S.o_confToBook)}) AS maxConfToBook,
      MIN(${col(S.o_bookToDone)}) AS minBookToDone, AVG(${col(S.o_bookToDone)}) AS avgBookToDone, MAX(${col(S.o_bookToDone)}) AS maxBookToDone,
      MIN(${col(S.o_confToDone)}) AS minConfToDone, AVG(${col(S.o_confToDone)}) AS avgConfToDone, MAX(${col(S.o_confToDone)}) AS maxConfToDone
    FROM ${ident(S.orders)}
    ${where}
  `, params);
  return { columnTypes: t, unitInUse: configuredUnit(), raw: rows[0] || {} };
}

// Split of orders across the PartnerName values this company owns — the pie on
// the first page of the report.
export async function byPartner(f) {
  const S = await resolveSchema();
  const { where, params } = orderFilter(S, f);
  return query(`
    SELECT ${ident(S.o_client)} AS name, COUNT(DISTINCT ${ident(S.o_id)}) AS orders
    FROM ${ident(S.orders)}
    ${where}
    GROUP BY ${ident(S.o_client)}
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
  const S = await resolveSchema();
  if (!S.attempts) return {};
  const { where, params } = orderFilter(S, f, 'o');
  const rows = await query(`
    SELECT
      SUM(CASE WHEN t.attempts = 1 AND t.good = 1 THEN 1 ELSE 0 END) AS firstTimeSuccessOrders
    FROM (
      SELECT a.${ident(S.a_order)} AS OrderID,
             COUNT(*) AS attempts,
             SUM(COALESCE(${aliasCol('a', S.a_okFlag)}, 0)) AS good
      FROM ${ident(S.attempts)} a
      JOIN ${ident(S.orders)} o ON o.${ident(S.o_id)} = a.${ident(S.a_order)}
      ${where}
      GROUP BY a.${ident(S.a_order)}
    ) t
  `, params);
  return rows[0] || {};
}

export async function attemptTotals(f) {
  const S = await resolveSchema();
  if (!S.attempts) return {};
  const { where, params } = attemptFilter(S, f);
  const rows = await query(`
    SELECT
      COUNT(*)                                       AS total,
      SUM(COALESCE(${aliasCol('a', S.a_okFlag)}, 0))        AS successful,
      SUM(COALESCE(${aliasCol('a', S.a_failFlag)}, 0))      AS failed,
      SUM(COALESCE(${aliasCol('a', S.a_onTimeFlag)}, 0))    AS onTime,
      SUM(COALESCE(${aliasCol('a', S.a_lateFlag)}, 0))      AS late,
      SUM(COALESCE(${aliasCol('a', S.a_earlyFlag)}, 0))     AS early,
      SUM(COALESCE(${aliasCol('a', S.a_outstandFlag)}, 0))  AS outstanding
    FROM ${ident(S.attempts)} a
    ${where}
  `, params);
  return rows[0] || {};
}

// Orders nobody has been out to yet.
export async function noAttemptCount(f) {
  const S = await resolveSchema();
  if (!S.attempts) return 0;
  const { where, params } = orderFilter(S, f, 'o');
  const rows = await query(`
    SELECT COUNT(*) AS noAttempt
    FROM ${ident(S.orders)} o
    ${where}
      AND NOT EXISTS (
        SELECT 1 FROM ${ident(S.attempts)} a
        WHERE a.${ident(S.a_order)} = o.${ident(S.o_id)}
      )
  `, params);
  return Number(rows[0]?.noAttempt || 0);
}

export async function byMonth(f) {
  const S = await resolveSchema();
  const { where, params, date } = orderFilter(S, f);
  const t = await durationTypes(S);
  return query(`
    SELECT
      YEAR(${date}) AS y, MONTH(${date}) AS m,
      SUM(${col(S.o_value)})           AS sales,
      COUNT(DISTINCT ${ident(S.o_id)}) AS orders,
      AVG(${col(S.o_weight)})          AS avgWeightKg,
      AVG(${col(S.o_cube)})            AS avgCubeM3,
      AVG(${col(S.o_items)})           AS avgItemsPerOrder,
      ${durAvg(t, S.o_confToDone)}     AS avgConfToCompletedSec,
      ${durAvg(t, S.o_bookToDone)}     AS avgReceivedToDeliveredSec,
      ${durAvg(t, S.o_confToBook)}     AS avgReceivedToProposedSec
    FROM ${ident(S.orders)}
    ${where}
    GROUP BY YEAR(${date}), MONTH(${date})
    ORDER BY y, m
  `, params);
}

export async function attemptsByMonth(f) {
  const S = await resolveSchema();
  if (!S.attempts) return [];
  const { where, params, date } = attemptFilter(S, f);
  return query(`
    SELECT
      YEAR(${date}) AS y, MONTH(${date}) AS m,
      COUNT(*)                                          AS total,
      SUM(COALESCE(${aliasCol('a', S.a_okFlag)}, 0))           AS successful,
      SUM(COALESCE(${aliasCol('a', S.a_failFlag)}, 0))         AS failed,
      SUM(COALESCE(${aliasCol('a', S.a_outstandFlag)}, 0))     AS unknown
    FROM ${ident(S.attempts)} a
    ${where}
    GROUP BY YEAR(${date}), MONTH(${date})
    ORDER BY y, m
  `, params);
}

// Weeks run Monday to Sunday. WEEKDAY() is 0 on a Monday whatever the locale.
export async function byWeek(f) {
  const S = await resolveSchema();
  const { where, params, date } = orderFilter(S, f);
  const monday = `DATE_SUB(DATE(${date}), INTERVAL WEEKDAY(${date}) DAY)`;
  return query(`
    SELECT
      ${monday} AS weekStart,
      SUM(${col(S.o_value)})           AS sales,
      COUNT(DISTINCT ${ident(S.o_id)}) AS orders,
      AVG(${col(S.o_weight)})          AS avgWeightKg,
      AVG(${col(S.o_cube)})            AS avgCubeM3,
      AVG(${col(S.o_items)})           AS avgItemsPerOrder
    FROM ${ident(S.orders)}
    ${where}
    GROUP BY ${monday}
    ORDER BY weekStart
  `, params);
}

// ---------------------------------------------------------------------------
// THE YEAR, IN THREE QUERIES.
//
// This replaces nine per-view queries with three per YEAR. Everything the
// dashboard shows for the whole year, any single month, any week and any partner
// is added up from these three results in memory — so changing the month costs
// no database work at all. See rollup.js for how, and why averages are carried
// as SUM + COUNT rather than as averages.
//
// The month is deliberately DROPPED from the filter here: the point is to read
// the year once and slice it afterwards.
// ---------------------------------------------------------------------------
export async function yearRollup(f) {
  const S = await resolveSchema();
  const yearOnly = { ...f, month: null };
  const { where, params, date } = orderFilter(S, yearOnly);
  const aFilter = S.attempts ? attemptFilter(S, yearOnly) : null;
  const oScoped = orderFilter(S, yearOnly, 'o');
  const monday = `DATE_SUB(DATE(${date}), INTERVAL WEEKDAY(${date}) DAY)`;

  const t = await durationTypes(S);

  // 1. ORDERS, at (month, week, partner) grain — about 120 rows for a year.
  const ordersP = query(`
    SELECT
      YEAR(${date}) AS y, MONTH(${date}) AS m,
      ${monday} AS weekStart,
      ${ident(S.o_client)} AS partner,
      SUM(${col(S.o_value)})                       AS sales,
      COUNT(DISTINCT ${ident(S.o_id)})             AS orders,
      SUM(COALESCE(${col(S.o_completeFlag)}, 0))   AS completed,
      SUM(COALESCE(${col(S.o_bookReqFlag)}, 0))    AS bookReq,
      SUM(COALESCE(${col(S.o_bookConfFlag)}, 0))   AS bookConf,
      SUM(${col(S.o_weight)}) AS weightSum, COUNT(${col(S.o_weight)}) AS weightCnt,
      SUM(${col(S.o_cube)})   AS cubeSum,   COUNT(${col(S.o_cube)})   AS cubeCnt,
      SUM(${col(S.o_items)})  AS itemsSum,  COUNT(${col(S.o_items)})  AS itemsCnt,
      ${durSum(t, S.o_confToBook)} AS confToBookSum, COUNT(${col(S.o_confToBook)}) AS confToBookCnt,
      ${durSum(t, S.o_bookToDone)} AS bookToDoneSum, COUNT(${col(S.o_bookToDone)}) AS bookToDoneCnt,
      ${durSum(t, S.o_confToDone)} AS confToDoneSum, COUNT(${col(S.o_confToDone)}) AS confToDoneCnt
    FROM ${ident(S.orders)}
    ${where}
    GROUP BY y, m, weekStart, partner
  `, params);

  // 2. ATTEMPTS, by month. Skipped entirely when the extract has no attempts
  //    table — the orders half of the dashboard still loads.
  const attemptsP = aFilter ? query(`
    SELECT
      YEAR(${aFilter.date}) AS y, MONTH(${aFilter.date}) AS m,
      COUNT(*)                                       AS total,
      SUM(COALESCE(${aliasCol('a', S.a_okFlag)}, 0))        AS successful,
      SUM(COALESCE(${aliasCol('a', S.a_failFlag)}, 0))      AS failed,
      SUM(COALESCE(${aliasCol('a', S.a_onTimeFlag)}, 0))    AS onTime,
      SUM(COALESCE(${aliasCol('a', S.a_lateFlag)}, 0))      AS late,
      SUM(COALESCE(${aliasCol('a', S.a_earlyFlag)}, 0))     AS early,
      SUM(COALESCE(${aliasCol('a', S.a_outstandFlag)}, 0))  AS outstanding
    FROM ${ident(S.attempts)} a
    ${aFilter.where}
    GROUP BY y, m
  `, aFilter.params) : Promise.resolve([]);

  // 3. PER-ORDER attempt counts, by month — first-time success and the orders
  //    nobody has been out to. A LEFT JOIN gets both from ONE pass; they used to
  //    be two separate queries over the same two tables.
  const perOrderP = S.attempts ? query(`
    SELECT t.y, t.m,
      SUM(CASE WHEN t.attempts = 0 THEN 1 ELSE 0 END)                    AS noAttempt,
      SUM(CASE WHEN t.attempts = 1 AND t.good = 1 THEN 1 ELSE 0 END)     AS firstTime,
      COUNT(*)                                                           AS scopedOrders
    FROM (
      SELECT YEAR(${oDate(S, 'o')}) AS y, MONTH(${oDate(S, 'o')}) AS m,
             o.${ident(S.o_id)} AS oid,
             COUNT(a.${ident(S.a_order)}) AS attempts,
             SUM(COALESCE(${aliasCol('a', S.a_okFlag)}, 0)) AS good
      FROM ${ident(S.orders)} o
      LEFT JOIN ${ident(S.attempts)} a ON a.${ident(S.a_order)} = o.${ident(S.o_id)}
      ${oScoped.where}
      GROUP BY y, m, oid
    ) t
    GROUP BY t.y, t.m
  `, oScoped.params) : Promise.resolve([]);

  const [orderRows, attemptRows, perOrderRows] = await Promise.all([ordersP, attemptsP, perOrderP]);
  return { orderRows, attemptRows, perOrderRows, durationUnit: configuredUnit() };
}

export async function facets(clientKey) {
  const S = await resolveSchema();
  const d = oDate(S);
  const ck = clientKeys({ clientKey });
  const [years, services] = await Promise.all([
    query(`SELECT DISTINCT YEAR(${d}) AS y FROM ${ident(S.orders)} WHERE ${ident(S.o_client)} IN (${ck.placeholders}) AND ${d} IS NOT NULL ORDER BY y DESC`, ck.params),
    // No service column means no Service Level dropdown, rather than no dashboard.
    has(S.o_service)
      ? query(`SELECT DISTINCT ${ident(S.o_service)} AS s FROM ${ident(S.orders)} WHERE ${ident(S.o_client)} IN (${ck.placeholders}) AND ${ident(S.o_service)} IS NOT NULL ORDER BY s`, ck.params)
      : Promise.resolve([]),
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
  const S = await resolveSchema();
  return query(`
    SELECT ${ident(S.o_client)} AS partnerName, COUNT(*) AS orders
    FROM ${ident(S.orders)}
    WHERE ${ident(S.o_client)} IS NOT NULL AND ${ident(S.o_client)} <> ''
    GROUP BY ${ident(S.o_client)}
    ORDER BY orders DESC
  `);
}