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
  // The three durations the WMS has already worked out for us, in days.
  o_confToBook:  env('SQL_ORDERS_CONF_TO_BOOK', 'OrderTimeConfToBook'),
  o_bookToDone:  env('SQL_ORDERS_BOOK_TO_DONE', 'OrderTimeBookToCompleted'),
  o_confToDone:  env('SQL_ORDERS_CONF_TO_DONE', 'OrderTimeConfToCompleted'),

  attempts:      env('SQL_ATTEMPTS_TABLE', 'stops'),
  a_client:      env('SQL_ATTEMPTS_CLIENT_COL', 'PartnerName'),
  a_order:       env('SQL_ATTEMPTS_ORDER_COL', 'OrderID'),
  a_date:        env('SQL_ATTEMPTS_DATE_COL', 'RunDate'),
  a_okFlag:      env('SQL_ATTEMPTS_OK_FLAG', 'StopStatusCompleteFlag'),
  a_failFlag:    env('SQL_ATTEMPTS_FAIL_FLAG', 'StopStatusFailedFlag'),
  a_onTimeFlag:  env('SQL_ATTEMPTS_ONTIME_FLAG', 'StopTimeOnTimeFlag'),
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

function orderFilter(f, alias = '') {
  const p = alias ? `${alias}.` : '';
  const d = oDate(alias);
  const ck = clientKeys(f);
  const conds = [`${p}${ident(SCHEMA.o_client)} IN (${ck.placeholders})`];
  const params = { ...ck.params };

  if (f.year)  { conds.push(`YEAR(${d}) = :year`);   params.year = Number(f.year); }
  if (f.month) { conds.push(`MONTH(${d}) = :month`); params.month = Number(f.month); }
  if (f.from)  { conds.push(`${d} >= :fromDate`);    params.fromDate = f.from; }
  if (f.to)    { conds.push(`${d} < DATE_ADD(:toDate, INTERVAL 1 DAY)`); params.toDate = f.to; }
  if (f.service) { conds.push(`${p}${ident(SCHEMA.o_service)} = :service`); params.service = String(f.service); }

  return { where: `WHERE ${conds.join(' AND ')}${excludeClause(alias, params)}`, params, date: d };
}

// stops carry their own PartnerName and ServiceLevelName, so no join is needed.
function attemptFilter(f) {
  const d = `a.${ident(SCHEMA.a_date)}`;
  const ck = clientKeys(f);
  const conds = [`a.${ident(SCHEMA.a_client)} IN (${ck.placeholders})`];
  const params = { ...ck.params };

  if (f.year)  { conds.push(`YEAR(${d}) = :year`);   params.year = Number(f.year); }
  if (f.month) { conds.push(`MONTH(${d}) = :month`); params.month = Number(f.month); }
  if (f.from)  { conds.push(`${d} >= :fromDate`);    params.fromDate = f.from; }
  if (f.to)    { conds.push(`${d} < DATE_ADD(:toDate, INTERVAL 1 DAY)`); params.toDate = f.to; }
  if (f.service) { conds.push(`a.\`ServiceLevelName\` = :service`); params.service = String(f.service); }

  return { where: `WHERE ${conds.join(' AND ')}`, params, date: d };
}

// ---------------------------------------------------------------------------
// THE READS
// ---------------------------------------------------------------------------

export async function orderTotals(f) {
  const { where, params } = orderFilter(f);
  const rows = await query(`
    SELECT
      SUM(${ident(SCHEMA.o_value)})             AS totalSales,
      COUNT(DISTINCT ${ident(SCHEMA.o_id)})     AS totalOrders,
      SUM(COALESCE(${ident(SCHEMA.o_completeFlag)}, 0)) AS completedOrders,
      AVG(${ident(SCHEMA.o_weight)})            AS avgWeightKg,
      AVG(${ident(SCHEMA.o_cube)})              AS avgCubeM3,
      AVG(${ident(SCHEMA.o_items)})             AS avgItemsPerOrder,
      AVG(${ident(SCHEMA.o_confToBook)})        AS avgReceivedToProposedDays,
      AVG(${ident(SCHEMA.o_bookToDone)})        AS avgReceivedToDeliveredDays,
      AVG(${ident(SCHEMA.o_confToDone)})        AS avgCreatedToDeliveredDays
    FROM ${ident(SCHEMA.orders)}
    ${where}
  `, params);
  return rows[0] || {};
}

// First time right: the order took exactly one visit, and that visit completed.
export async function firstTimeSuccess(f) {
  const { where, params } = orderFilter(f, 'o');
  const rows = await query(`
    SELECT
      (SELECT COUNT(*) FROM ${ident(SCHEMA.orders)} o ${where}) AS scopedOrders,
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
      SUM(COALESCE(a.${ident(SCHEMA.a_onTimeFlag)}, 0))   AS onTime
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
  return query(`
    SELECT
      YEAR(${date}) AS y, MONTH(${date}) AS m,
      SUM(${ident(SCHEMA.o_value)})         AS sales,
      COUNT(DISTINCT ${ident(SCHEMA.o_id)}) AS orders,
      AVG(${ident(SCHEMA.o_weight)})        AS avgWeightKg,
      AVG(${ident(SCHEMA.o_cube)})          AS avgCubeM3,
      AVG(${ident(SCHEMA.o_items)})         AS avgItemsPerOrder
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
      SUM(COALESCE(a.${ident(SCHEMA.a_failFlag)}, 0)) AS failed
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
      AVG(${ident(SCHEMA.o_cube)})          AS avgCubeM3
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
