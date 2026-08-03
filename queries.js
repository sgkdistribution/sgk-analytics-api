// ---------------------------------------------------------------------------
// THE ONLY FILE THAT KNOWS YOUR DATABASE.
//
// Everything else in this service — auth, isolation, caching, the HTTP contract
// the portal talks to — is finished and will not change when the real table and
// column names land. All of that lives behind this one file.
//
// The names in SCHEMA below are PLACEHOLDERS taken from the field labels on the
// existing Power BI report (Total Order Sales, Avg Order Weight kg,
// ServiceLevelName, and so on). They are an educated guess at what Go2Stream
// calls things, not fact. Run `npm run discover` against the database and either
// correct them here or override each one with an env var — every key below reads
// from env first, so you can fix a wrong guess on Railway without a deploy.
//
// SAFETY NOTE ON IDENTIFIERS: table and column names cannot be bound as SQL
// parameters, so they are interpolated. That is exactly why they come from
// server config and never from a request — and why every one is passed through
// ident() first, which refuses anything that is not a plain name.
// ---------------------------------------------------------------------------
import { query } from './db.js';

const env = (k, fallback) => (process.env[k] || fallback);

// Reject anything that is not a bare identifier or schema.name pair.
function ident(name) {
  const s = String(name || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/.test(s)) {
    throw new Error(`Refusing to use "${s}" as a SQL identifier — check your SCHEMA config.`);
  }
  return s.split('.').map((p) => `[${p}]`).join('.');
}

export const SCHEMA = {
  // --- orders -------------------------------------------------------------
  orders:            env('SQL_ORDERS_TABLE', 'dbo.Orders'),
  o_client:          env('SQL_ORDERS_CLIENT_COL', 'ClientCode'),      // <- the per-client key
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
  attempts:          env('SQL_ATTEMPTS_TABLE', 'dbo.DeliveryAttempts'),
  a_client:          env('SQL_ATTEMPTS_CLIENT_COL', 'ClientCode'),
  a_order:           env('SQL_ATTEMPTS_ORDER_COL', 'OrderId'),
  a_date:            env('SQL_ATTEMPTS_DATE_COL', 'AttemptDate'),
  a_status:          env('SQL_ATTEMPTS_STATUS_COL', 'AttemptStatus'),
  a_successValue:    env('SQL_ATTEMPTS_SUCCESS_VALUE', 'Successful'),
  a_failValue:       env('SQL_ATTEMPTS_FAIL_VALUE', 'Failed'),
  a_onTimeCol:       env('SQL_ATTEMPTS_ONTIME_COL', 'OnTimeStatus'),
  a_onTimeValue:     env('SQL_ATTEMPTS_ONTIME_VALUE', 'On Time'),
};

// The date every figure is measured against. Orders are counted on the day they
// were delivered where that is known, and on their created date otherwise, so a
// month never loses the orders that have not landed yet.
const ORDER_DATE = () => `COALESCE(__A__${ident(SCHEMA.o_delivered)}, __A__${ident(SCHEMA.o_created)})`;

// ---------------------------------------------------------------------------
// FILTERS. Note the shape: the company key is not optional and not a parameter
// the caller can drop — buildWhere always starts with it.
// ---------------------------------------------------------------------------
function buildWhere({ clientCol, dateExpr, serviceCol, alias = '' }, f) {
  const p = alias ? `${alias}.` : '';
  const col = (c) => `${p}${ident(c)}`;
  const date = alias ? dateExpr.replaceAll('__A__', `${alias}.`) : dateExpr.replaceAll('__A__', '');

  const conds = [`${col(clientCol)} = @clientKey`];
  const params = { clientKey: f.clientKey };

  if (f.year)  { conds.push(`YEAR(${date}) = @year`);   params.year = Number(f.year); }
  if (f.month) { conds.push(`MONTH(${date}) = @month`); params.month = Number(f.month); }
  if (f.from)  { conds.push(`${date} >= @from`);        params.from = new Date(f.from); }
  if (f.to)    { conds.push(`${date} < DATEADD(day, 1, @to)`); params.to = new Date(f.to); }
  if (f.service && serviceCol) { conds.push(`${col(serviceCol)} = @service`); params.service = String(f.service); }

  return { where: `WHERE ${conds.join(' AND ')}`, params, date };
}

const orderFilter = (f, alias = '') => buildWhere(
  { clientCol: SCHEMA.o_client, dateExpr: ORDER_DATE(), serviceCol: SCHEMA.o_service, alias }, f,
);

// Attempts carry no service level of their own, so that filter is applied by
// joining back to the order the attempt belongs to.
function attemptFilter(f) {
  const conds = [`a.${ident(SCHEMA.a_client)} = @clientKey`];
  const params = { clientKey: f.clientKey };
  const d = `a.${ident(SCHEMA.a_date)}`;
  if (f.year)  { conds.push(`YEAR(${d}) = @year`);   params.year = Number(f.year); }
  if (f.month) { conds.push(`MONTH(${d}) = @month`); params.month = Number(f.month); }
  if (f.from)  { conds.push(`${d} >= @from`);        params.from = new Date(f.from); }
  if (f.to)    { conds.push(`${d} < DATEADD(day, 1, @to)`); params.to = new Date(f.to); }
  let join = '';
  if (f.service) {
    join = `JOIN ${ident(SCHEMA.orders)} o ON o.${ident(SCHEMA.o_id)} = a.${ident(SCHEMA.a_order)}`;
    conds.push(`o.${ident(SCHEMA.o_service)} = @service`);
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
      SUM(CAST(${ident(SCHEMA.o_value)}  AS decimal(18,2))) AS totalSales,
      COUNT(DISTINCT ${ident(SCHEMA.o_id)})                 AS totalOrders,
      SUM(CASE WHEN ${ident(SCHEMA.o_status)} = @completed THEN 1 ELSE 0 END) AS completedOrders,
      AVG(CAST(${ident(SCHEMA.o_weight)} AS decimal(18,4))) AS avgWeightKg,
      AVG(CAST(${ident(SCHEMA.o_cube)}   AS decimal(18,4))) AS avgCubeM3,
      AVG(CAST(${ident(SCHEMA.o_items)}  AS decimal(18,4))) AS avgItemsPerOrder,
      AVG(CAST(DATEDIFF(day, ${ident(SCHEMA.o_received)}, ${ident(SCHEMA.o_proposed)})  AS decimal(18,4))) AS avgReceivedToProposedDays,
      AVG(CAST(DATEDIFF(day, ${ident(SCHEMA.o_received)}, ${ident(SCHEMA.o_delivered)}) AS decimal(18,4))) AS avgReceivedToDeliveredDays,
      AVG(CAST(DATEDIFF(day, ${ident(SCHEMA.o_created)},  ${ident(SCHEMA.o_delivered)}) AS decimal(18,4))) AS avgCreatedToDeliveredDays
    FROM ${ident(SCHEMA.orders)}
    ${where}
  `, { ...params, completed: SCHEMA.o_completedValue });
  return rows[0] || {};
}

// An order counted as first-time successful: exactly one attempt, and it worked.
export async function firstTimeSuccess(f) {
  const { where, params } = orderFilter(f);
  const rows = await query(`
    WITH scoped AS (
      SELECT ${ident(SCHEMA.o_id)} AS OrderId FROM ${ident(SCHEMA.orders)} ${where}
    ),
    tally AS (
      SELECT a.${ident(SCHEMA.a_order)} AS OrderId,
             COUNT(*) AS attempts,
             SUM(CASE WHEN a.${ident(SCHEMA.a_status)} = @success THEN 1 ELSE 0 END) AS good
      FROM ${ident(SCHEMA.attempts)} a
      JOIN scoped s ON s.OrderId = a.${ident(SCHEMA.a_order)}
      GROUP BY a.${ident(SCHEMA.a_order)}
    )
    SELECT
      (SELECT COUNT(*) FROM scoped) AS scopedOrders,
      SUM(CASE WHEN attempts = 1 AND good = 1 THEN 1 ELSE 0 END) AS firstTimeSuccessOrders
    FROM tally
  `, { ...params, success: SCHEMA.a_successValue });
  return rows[0] || {};
}

export async function attemptTotals(f) {
  const { join, where, params } = attemptFilter(f);
  const rows = await query(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN a.${ident(SCHEMA.a_status)} = @success THEN 1 ELSE 0 END) AS successful,
      SUM(CASE WHEN a.${ident(SCHEMA.a_status)} = @fail    THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN a.${ident(SCHEMA.a_onTimeCol)} = @onTime THEN 1 ELSE 0 END) AS onTime
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
  const { where, params } = orderFilter(f);
  const d = ORDER_DATE().replaceAll('__A__', '');
  return query(`
    SELECT
      YEAR(${d}) AS y, MONTH(${d}) AS m,
      SUM(CAST(${ident(SCHEMA.o_value)} AS decimal(18,2)))  AS sales,
      COUNT(DISTINCT ${ident(SCHEMA.o_id)})                 AS orders,
      AVG(CAST(${ident(SCHEMA.o_weight)} AS decimal(18,4))) AS avgWeightKg,
      AVG(CAST(${ident(SCHEMA.o_cube)}   AS decimal(18,4))) AS avgCubeM3,
      AVG(CAST(${ident(SCHEMA.o_items)}  AS decimal(18,4))) AS avgItemsPerOrder
    FROM ${ident(SCHEMA.orders)}
    ${where}
    GROUP BY YEAR(${d}), MONTH(${d})
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
      SUM(CASE WHEN a.${ident(SCHEMA.a_status)} = @success THEN 1 ELSE 0 END) AS successful,
      SUM(CASE WHEN a.${ident(SCHEMA.a_status)} = @fail    THEN 1 ELSE 0 END) AS failed
    FROM ${ident(SCHEMA.attempts)} a
    ${join}
    ${where}
    GROUP BY YEAR(${d}), MONTH(${d})
    ORDER BY y, m
  `, { ...params, success: SCHEMA.a_successValue, fail: SCHEMA.a_failValue });
}

// Weeks run Monday to Sunday regardless of the server's DATEFIRST setting.
export async function byWeek(f) {
  const { where, params } = orderFilter(f);
  const d = ORDER_DATE().replaceAll('__A__', '');
  const monday = `DATEADD(day, -((DATEPART(weekday, ${d}) + @@DATEFIRST - 2) % 7), CAST(${d} AS date))`;
  return query(`
    SELECT
      ${monday} AS weekStart,
      SUM(CAST(${ident(SCHEMA.o_value)} AS decimal(18,2)))  AS sales,
      COUNT(DISTINCT ${ident(SCHEMA.o_id)})                 AS orders,
      AVG(CAST(${ident(SCHEMA.o_weight)} AS decimal(18,4))) AS avgWeightKg,
      AVG(CAST(${ident(SCHEMA.o_cube)}   AS decimal(18,4))) AS avgCubeM3
    FROM ${ident(SCHEMA.orders)}
    ${where}
    GROUP BY ${monday}
    ORDER BY weekStart
  `, params);
}

// For the filter row: which years and service levels this client actually has.
export async function facets(clientKey) {
  const d = ORDER_DATE().replaceAll('__A__', '');
  const [years, services] = await Promise.all([
    query(`SELECT DISTINCT YEAR(${d}) AS y FROM ${ident(SCHEMA.orders)} WHERE ${ident(SCHEMA.o_client)} = @clientKey ORDER BY y DESC`, { clientKey }),
    query(`SELECT DISTINCT ${ident(SCHEMA.o_service)} AS s FROM ${ident(SCHEMA.orders)} WHERE ${ident(SCHEMA.o_client)} = @clientKey AND ${ident(SCHEMA.o_service)} IS NOT NULL ORDER BY s`, { clientKey }),
  ]);
  return {
    years: years.map((r) => Number(r.y)).filter(Boolean),
    serviceLevels: services.map((r) => String(r.s)).filter(Boolean),
  };
}
