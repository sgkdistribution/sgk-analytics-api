// ---------------------------------------------------------------------------
// THE ONLY FILE THAT KNOWS YOUR DATABASE.
//
// Everything else — auth, isolation, caching, the HTTP contract the portal
// talks to — is finished and does not change when the real table and column
// names land. All of it sits behind this one file.
//
// MySQL dialect (the database is MySQL on 3306, not SQL Server). The names in
// SCHEMA below are still PLACEHOLDERS, guessed from the labels on the old Power
// BI report. Run `npm run discover` and either correct them here or override any
// one of them with an env var — every key reads from env first, so a wrong guess
// is fixable on Railway without a deploy.
//
// SAFETY NOTE ON IDENTIFIERS: table and column names cannot be bound as query
// parameters, so they are interpolated. That is exactly why they come from
// server config and never from a request — and why each one goes through
// ident(), which refuses anything that is not a plain name.
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
  // --- orders -------------------------------------------------------------
  orders:            env('SQL_ORDERS_TABLE', 'orders'),
  o_client:          env('SQL_ORDERS_CLIENT_COL', 'ClientCode'),      // the per-client key
  o_id:              env('SQL_ORDERS_ID_COL', 'OrderId'),
  o_value:           env('SQL_ORDERS_VALUE_COL', 'OrderValue'),
  o_weight:          env('SQL_ORDERS_WEIGHT_COL', 'WeightKg'),
  o_cube:            env('SQL_ORDERS_CUBE_COL', 'CubeM3'),
  o_items:           env('SQL_ORDERS_ITEMS_COL', 'ItemCount'),
  o_service:         env('SQL_ORDERS_SERVICE_COL', 'ServiceLevelName'),
  o_status:          env('SQL_ORDERS_STATUS_COL', 'OrderStatus'),
  o_completedValue:  env('SQL_ORDERS_COMPLETED_VALUE', 'Completed'),
  o_created:         env('SQL_ORDERS_CREATED_COL', 'CreatedDate'),
  o_received:        env('SQL_ORDERS_RECEIVED_COL', 'ReceivedDate'),
  o_proposed:        env('SQL_ORDERS_PROPOSED_COL', 'ProposedDate'),
  o_delivered:       env('SQL_ORDERS_DELIVERED_COL', 'DeliveredDate'),

  // --- delivery attempts --------------------------------------------------
  attempts:          env('SQL_ATTEMPTS_TABLE', 'delivery_attempts'),
  a_client:          env('SQL_ATTEMPTS_CLIENT_COL', 'ClientCode'),
  a_order:           env('SQL_ATTEMPTS_ORDER_COL', 'OrderId'),
  a_date:            env('SQL_ATTEMPTS_DATE_COL', 'AttemptDate'),
  a_status:          env('SQL_ATTEMPTS_STATUS_COL', 'AttemptStatus'),
  a_successValue:    env('SQL_ATTEMPTS_SUCCESS_VALUE', 'Successful'),
  a_failValue:       env('SQL_ATTEMPTS_FAIL_VALUE', 'Failed'),
  a_onTimeCol:       env('SQL_ATTEMPTS_ONTIME_COL', 'OnTimeStatus'),
  a_onTimeValue:     env('SQL_ATTEMPTS_ONTIME_VALUE', 'On Time'),
};

// The date every figure is measured against: the delivered date where it is
// known, the created date otherwise, so a month never loses the orders that
// have not landed yet.
const orderDate = (alias = '') => {
  const p = alias ? `${alias}.` : '';
  return `COALESCE(${p}${ident(SCHEMA.o_delivered)}, ${p}${ident(SCHEMA.o_created)})`;
};

// ---------------------------------------------------------------------------
// FILTERS. Note the shape: the company key is not optional and cannot be
// dropped by a caller — the WHERE clause always starts with it.
// ---------------------------------------------------------------------------
function orderFilter(f, alias = '') {
  const p = alias ? `${alias}.` : '';
  const d = orderDate(alias);
  const conds = [`${p}${ident(SCHEMA.o_client)} = :clientKey`];
  const params = { clientKey: f.clientKey };

  if (f.year)  { conds.push(`YEAR(${d}) = :year`);   params.year = Number(f.year); }
  if (f.month) { conds.push(`MONTH(${d}) = :month`); params.month = Number(f.month); }
  if (f.from)  { conds.push(`${d} >= :fromDate`);    params.fromDate = f.from; }
  if (f.to)    { conds.push(`${d} < DATE_ADD(:toDate, INTERVAL 1 DAY)`); params.toDate = f.to; }
  if (f.service) { conds.push(`${p}${ident(SCHEMA.o_service)} = :service`); params.service = String(f.service); }

  return { where: `WHERE ${conds.join(' AND ')}`, params, date: d };
}

// Attempts carry no service level of their own, so that filter joins back to
// the order the attempt belongs to.
function attemptFilter(f) {
  const d = `a.${ident(SCHEMA.a_date)}`;
  const conds = [`a.${ident(SCHEMA.a_client)} = :clientKey`];
  const params = { clientKey: f.clientKey };

  if (f.year)  { conds.push(`YEAR(${d}) = :year`);   params.year = Number(f.year); }
  if (f.month) { conds.push(`MONTH(${d}) = :month`); params.month = Number(f.month); }
  if (f.from)  { conds.push(`${d} >= :fromDate`);    params.fromDate = f.from; }
  if (f.to)    { conds.push(`${d} < DATE_ADD(:toDate, INTERVAL 1 DAY)`); params.toDate = f.to; }

  let join = '';
  if (f.service) {
    join = `JOIN ${ident(SCHEMA.orders)} o ON o.${ident(SCHEMA.o_id)} = a.${ident(SCHEMA.a_order)}`;
    conds.push(`o.${ident(SCHEMA.o_service)} = :service`);
    params.service = String(f.service);
  }
  return { join, where: `WHERE ${conds.join(' AND ')}`, params };
}

// ---------------------------------------------------------------------------
// THE READS
// ---------------------------------------------------------------------------

export async function orderTotals(f) {
  const { where, params } = orderFilter(f);
  const rows = await query(`
    SELECT
      SUM(${ident(SCHEMA.o_value)})            AS totalSales,
      COUNT(DISTINCT ${ident(SCHEMA.o_id)})    AS totalOrders,
      SUM(CASE WHEN ${ident(SCHEMA.o_status)} = :completed THEN 1 ELSE 0 END) AS completedOrders,
      AVG(${ident(SCHEMA.o_weight)})           AS avgWeightKg,
      AVG(${ident(SCHEMA.o_cube)})             AS avgCubeM3,
      AVG(${ident(SCHEMA.o_items)})            AS avgItemsPerOrder,
      AVG(DATEDIFF(${ident(SCHEMA.o_proposed)},  ${ident(SCHEMA.o_received)})) AS avgReceivedToProposedDays,
      AVG(DATEDIFF(${ident(SCHEMA.o_delivered)}, ${ident(SCHEMA.o_received)})) AS avgReceivedToDeliveredDays,
      AVG(DATEDIFF(${ident(SCHEMA.o_delivered)}, ${ident(SCHEMA.o_created)}))  AS avgCreatedToDeliveredDays
    FROM ${ident(SCHEMA.orders)}
    ${where}
  `, { ...params, completed: SCHEMA.o_completedValue });
  return rows[0] || {};
}

// An order is first-time successful when it had exactly one attempt and it worked.
export async function firstTimeSuccess(f) {
  const { where, params } = orderFilter(f, 'o');
  const rows = await query(`
    SELECT
      (SELECT COUNT(*) FROM ${ident(SCHEMA.orders)} o ${where}) AS scopedOrders,
      SUM(CASE WHEN t.attempts = 1 AND t.good = 1 THEN 1 ELSE 0 END) AS firstTimeSuccessOrders
    FROM (
      SELECT a.${ident(SCHEMA.a_order)} AS OrderId,
             COUNT(*) AS attempts,
             SUM(CASE WHEN a.${ident(SCHEMA.a_status)} = :success THEN 1 ELSE 0 END) AS good
      FROM ${ident(SCHEMA.attempts)} a
      JOIN ${ident(SCHEMA.orders)} o ON o.${ident(SCHEMA.o_id)} = a.${ident(SCHEMA.a_order)}
      ${where}
      GROUP BY a.${ident(SCHEMA.a_order)}
    ) t
  `, { ...params, success: SCHEMA.a_successValue });
  return rows[0] || {};
}

export async function attemptTotals(f) {
  const { join, where, params } = attemptFilter(f);
  const rows = await query(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN a.${ident(SCHEMA.a_status)}   = :success THEN 1 ELSE 0 END) AS successful,
      SUM(CASE WHEN a.${ident(SCHEMA.a_status)}   = :fail    THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN a.${ident(SCHEMA.a_onTimeCol)} = :onTime THEN 1 ELSE 0 END) AS onTime
    FROM ${ident(SCHEMA.attempts)} a
    ${join}
    ${where}
  `, { ...params, success: SCHEMA.a_successValue, fail: SCHEMA.a_failValue, onTime: SCHEMA.a_onTimeValue });
  return rows[0] || {};
}

// Orders that never got an attempt at all.
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
  const { join, where, params } = attemptFilter(f);
  const d = `a.${ident(SCHEMA.a_date)}`;
  return query(`
    SELECT
      YEAR(${d}) AS y, MONTH(${d}) AS m,
      COUNT(*) AS total,
      SUM(CASE WHEN a.${ident(SCHEMA.a_status)} = :success THEN 1 ELSE 0 END) AS successful,
      SUM(CASE WHEN a.${ident(SCHEMA.a_status)} = :fail    THEN 1 ELSE 0 END) AS failed
    FROM ${ident(SCHEMA.attempts)} a
    ${join}
    ${where}
    GROUP BY YEAR(${d}), MONTH(${d})
    ORDER BY y, m
  `, { ...params, success: SCHEMA.a_successValue, fail: SCHEMA.a_failValue });
}

// Weeks run Monday to Sunday. WEEKDAY() is 0 on a Monday, so this lands on the
// Monday of that week whatever the server's locale is set to.
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

// For the filter row: which years and service levels this client actually has.
export async function facets(clientKey) {
  const d = orderDate();
  const [years, services] = await Promise.all([
    query(`SELECT DISTINCT YEAR(${d}) AS y FROM ${ident(SCHEMA.orders)} WHERE ${ident(SCHEMA.o_client)} = :clientKey ORDER BY y DESC`, { clientKey }),
    query(`SELECT DISTINCT ${ident(SCHEMA.o_service)} AS s FROM ${ident(SCHEMA.orders)} WHERE ${ident(SCHEMA.o_client)} = :clientKey AND ${ident(SCHEMA.o_service)} IS NOT NULL ORDER BY s`, { clientKey }),
  ]);
  return {
    years: years.map((r) => Number(r.y)).filter(Boolean),
    serviceLevels: services.map((r) => String(r.s)).filter(Boolean),
  };
}
