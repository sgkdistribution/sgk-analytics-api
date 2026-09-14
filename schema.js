// ---------------------------------------------------------------------------
// THE SCHEMA, RESOLVED AT RUNTIME — not hard-coded, not guessed.
//
// WHY THIS FILE EXISTS.
//
// queries.js used to carry the table and column names as fixed strings with env
// overrides. That works right up until somebody changes the extract — renames a
// column, renames a table, drops one — and then EVERY read fails at once, the
// whole dashboard goes dark, and the only clue on screen is a MySQL error about
// one column (or, worse, nothing at all).
//
// So the names are no longer assumed. On the first read this asks the database
// what it actually has, matches each thing the dashboard needs against the real
// column list, and builds the SQL from what is really there.
//
// HOW A NAME IS MATCHED, in order. Every step is an exact comparison against a
// name the database reported — none of this is fuzzy, because a fuzzy match on a
// money column is how you put a wrong number in front of a client:
//
//   1. the env override / current name   (SQL_ORDERS_VALUE_COL, 'OrderCharges')
//   2. a known previous name             ('OrderValue' — what this service was
//                                         first written against)
//   3. the same name ignoring case       (MySQL column names are case
//                                         insensitive; table names on Linux are
//                                         NOT, so `Orders` vs `orders` matters)
//   4. the same name ignoring case AND punctuation
//                                        ('Order_ID' matches 'OrderID')
//
// WHAT HAPPENS WHEN SOMETHING IS GENUINELY GONE.
//
//   REQUIRED (the orders table, the client column, the order id, the order
//   date) — the request fails with a message naming the missing piece and
//   listing what the database does have. There is no sensible dashboard without
//   these, and a loud, specific error is worth ten times a blank screen.
//
//   EVERYTHING ELSE — the measure is dropped and its tile shows a dash. A
//   missing weight column must never become a zero, and it must never take the
//   sales figure down with it. Partial figures that are all correct beat a dead
//   dashboard, and beat a complete one with an invented number in it.
//
// What it resolved to is logged at startup and reported on /health, so the
// answer to "which column is it using for sales" is one look, not an argument.
// ---------------------------------------------------------------------------
import { query } from './db.js';

const env = (k, fallback) => (process.env[k] || fallback);

/**
 * Quote an identifier for MySQL, refusing anything that is not one.
 *
 * This lives here rather than in queries.js so exactly ONE file decides how a
 * name is quoted — the same reason durations.js takes the quoted column in
 * rather than quoting it itself.
 */
export function ident(name) {
  const s = String(name || '').trim();
  if (!/^[A-Za-z_][A-Za-z0-9_$]*(\.[A-Za-z_][A-Za-z0-9_$]*)?$/.test(s)) {
    throw new Error(`Refusing to use "${s}" as a SQL identifier — check your SCHEMA config.`);
  }
  return s.split('.').map((p) => `\`${p}\``).join('.');
}

// ---------------------------------------------------------------------------
// THE NAMES WE EXPECT — env override first, then the name the extract uses now.
// This is the same map queries.js has always had, moved here so the resolver and
// the queries cannot drift apart.
// ---------------------------------------------------------------------------
export const CONFIGURED = {
  orders:         env('SQL_ORDERS_TABLE', 'orders'),
  o_client:       env('SQL_ORDERS_CLIENT_COL', 'PartnerName'),
  o_id:           env('SQL_ORDERS_ID_COL', 'OrderID'),
  // The human-facing order reference. NOT used for any figure — it exists only
  // so /analytics/reconcile can reproduce Power BI's "Count of Order Number"
  // slice exactly and show where a remaining difference comes from.
  o_number:       env('SQL_ORDERS_NUMBER_COL', 'OrderNumber'),
  o_value:        env('SQL_ORDERS_VALUE_COL', 'OrderCharges'),      // what the client is charged
  o_weight:       env('SQL_ORDERS_WEIGHT_COL', 'OrderWeight'),
  o_cube:         env('SQL_ORDERS_CUBE_COL', 'OrderCube'),
  o_items:        env('SQL_ORDERS_ITEMS_COL', 'OrderItemsCount'),
  o_service:      env('SQL_ORDERS_SERVICE_COL', 'ServiceLevelName'),
  o_completeFlag: env('SQL_ORDERS_COMPLETE_FLAG', 'OrderStatusCompleteFlag'),
  // Order-level "delivered on time". This is what Power BI's "First Time
  // Successful Orders" is actually built on — NOT anything about attempts.
  o_delOnTimeFlag: env('SQL_ORDERS_DEL_ONTIME_FLAG', 'DelOnTimeFlag'),
  // The two dates the client's Power BI report buckets by on its delivery page.
  o_confirmedDate: env('SQL_ORDERS_CONFIRMED_DATE_COL', 'OrderConfirmedDate'),
  o_completedDate: env('SQL_ORDERS_COMPLETED_DATE_COL', 'OrderCompletedDate'),
  o_date:         env('SQL_ORDERS_DATE_COL', 'OrderDate'),
  o_statusName:   env('SQL_ORDERS_STATUS_COL', 'OrderStatusName'),
  o_confToBook:   env('SQL_ORDERS_CONF_TO_BOOK', 'OrderTimeConfToBook'),
  o_bookToDone:   env('SQL_ORDERS_BOOK_TO_DONE', 'OrderTimeBookToCompleted'),
  o_confToDone:   env('SQL_ORDERS_CONF_TO_DONE', 'OrderTimeConfToCompleted'),
  o_bookReqFlag:  env('SQL_ORDERS_BOOK_REQ_FLAG', 'OrderBookingReqFlag'),
  o_bookConfFlag: env('SQL_ORDERS_BOOK_CONF_FLAG', 'OrderBookingConfFlag'),

  attempts:       env('SQL_ATTEMPTS_TABLE', 'stops'),
  a_client:       env('SQL_ATTEMPTS_CLIENT_COL', 'PartnerName'),
  a_order:        env('SQL_ATTEMPTS_ORDER_COL', 'OrderID'),
  a_date:         env('SQL_ATTEMPTS_DATE_COL', 'RunDate'),
  a_service:      env('SQL_ATTEMPTS_SERVICE_COL', 'ServiceLevelName'),
  a_okFlag:       env('SQL_ATTEMPTS_OK_FLAG', 'StopStatusCompleteFlag'),
  a_failFlag:     env('SQL_ATTEMPTS_FAIL_FLAG', 'StopStatusFailedFlag'),
  a_onTimeFlag:   env('SQL_ATTEMPTS_ONTIME_FLAG', 'StopTimeOnTimeFlag'),
  a_lateFlag:     env('SQL_ATTEMPTS_LATE_FLAG', 'StopTimeLateFlag'),
  a_earlyFlag:    env('SQL_ATTEMPTS_EARLY_FLAG', 'StopTimeEarlyFlag'),
  a_outstandFlag: env('SQL_ATTEMPTS_OUTSTANDING_FLAG', 'StopStatusOutstandingFlag'),
};

// ---------------------------------------------------------------------------
// KNOWN PREVIOUS AND ALTERNATIVE NAMES.
//
// Two generations of naming already exist in this repo's own history: the guesses
// this service was first written against (ClientCode, OrderValue, WeightKg,
// delivery_attempts, AttemptDate) and the real extract names discovered later
// (PartnerName, OrderCharges, OrderWeight, stops, RunDate). Both are listed, so
// the service works whichever way round the extract is, and so a rename BACK
// does not break it either.
//
// Deliberately conservative. A name is only ever accepted from this list if the
// database reports it exactly — nothing here matches on "looks like a weight".
// ---------------------------------------------------------------------------
const ALIASES = {
  orders:         ['orders', 'Orders', 'order', 'sgk_orders', 'orders_extract', 'vw_orders', 'v_orders'],
  o_client:       ['PartnerName', 'ClientCode', 'ClientName', 'PartnerCode', 'Partner', 'Client', 'CustomerName', 'AccountName'],
  o_id:           ['OrderID', 'OrderId', 'Order_ID', 'OrderNo', 'OrderNumber', 'OrderRef'],
  o_number:       ['OrderNumber', 'OrderNo', 'OrderRef', 'OrderReference', 'CustomerOrderNumber'],
  o_value:        ['OrderCharges', 'OrderValue', 'OrderCharge', 'Charges', 'TotalCharges', 'OrderNetValue', 'NetValue', 'OrderPrice'],
  o_weight:       ['OrderWeight', 'WeightKg', 'Weight', 'TotalWeight', 'OrderWeightKg'],
  o_cube:         ['OrderCube', 'CubeM3', 'Cube', 'TotalCube', 'OrderVolume', 'Volume'],
  o_items:        ['OrderItemsCount', 'ItemCount', 'ItemsCount', 'OrderItems', 'Items', 'TotalItems', 'LineCount'],
  o_service:      ['ServiceLevelName', 'ServiceLevel', 'ServiceName', 'Service'],
  o_completeFlag: ['OrderStatusCompleteFlag', 'OrderCompleteFlag', 'OrderStatusComplete', 'CompleteFlag'],
  o_delOnTimeFlag: ['DelOnTimeFlag', 'DeliveredOnTimeFlag', 'OnTimeFlag', 'DelOnTime'],
  o_confirmedDate: ['OrderConfirmedDate', 'ConfirmedDate', 'OrderConfDate'],
  o_completedDate: ['OrderCompletedDate', 'CompletedDate', 'OrderDeliveredDate'],
  o_date:         ['OrderDate', 'CreatedDate', 'OrderCreatedDate', 'OrderReceivedDate', 'ReceivedDate', 'OrderDateTime'],
  o_statusName:   ['OrderStatusName', 'OrderStatus', 'StatusName', 'Status'],
  o_confToBook:   ['OrderTimeConfToBook', 'OrderTimeConfirmedToBooked', 'TimeConfToBook'],
  o_bookToDone:   ['OrderTimeBookToCompleted', 'OrderTimeBookedToCompleted', 'TimeBookToCompleted'],
  o_confToDone:   ['OrderTimeConfToCompleted', 'OrderTimeConfirmedToCompleted', 'TimeConfToCompleted'],
  o_bookReqFlag:  ['OrderBookingReqFlag', 'OrderBookingRequestedFlag', 'BookingReqFlag'],
  o_bookConfFlag: ['OrderBookingConfFlag', 'OrderBookingConfirmedFlag', 'BookingConfFlag'],

  attempts:       ['stops', 'Stops', 'stop', 'delivery_attempts', 'attempts', 'deliveryattempts', 'vw_stops', 'v_stops'],
  a_client:       ['PartnerName', 'ClientCode', 'ClientName', 'PartnerCode', 'Partner', 'Client'],
  a_order:        ['OrderID', 'OrderId', 'Order_ID', 'OrderNo', 'OrderNumber'],
  a_date:         ['RunDate', 'AttemptDate', 'StopDate', 'DeliveryDate', 'RunDateTime', 'Date'],
  a_service:      ['ServiceLevelName', 'ServiceLevel', 'ServiceName', 'Service'],
  a_okFlag:       ['StopStatusCompleteFlag', 'StopCompleteFlag', 'StopStatusComplete', 'CompleteFlag', 'SuccessFlag'],
  a_failFlag:     ['StopStatusFailedFlag', 'StopFailedFlag', 'StopStatusFailed', 'FailedFlag', 'FailFlag'],
  a_onTimeFlag:   ['StopTimeOnTimeFlag', 'StopOnTimeFlag', 'OnTimeFlag'],
  a_lateFlag:     ['StopTimeLateFlag', 'StopLateFlag', 'LateFlag'],
  a_earlyFlag:    ['StopTimeEarlyFlag', 'StopEarlyFlag', 'EarlyFlag'],
  a_outstandFlag: ['StopStatusOutstandingFlag', 'StopOutstandingFlag', 'OutstandingFlag', 'UnknownFlag'],
};

/**
 * WITHOUT THESE THERE IS NO DASHBOARD.
 *
 * The client column especially: it is what keeps one company out of another's
 * figures. If it cannot be resolved the service must refuse to answer, never
 * quietly read the table without it.
 */
const REQUIRED_ORDER_FIELDS = ['o_client', 'o_id', 'o_date'];

/** Everything the attempts half needs before it is worth reading at all. */
const REQUIRED_ATTEMPT_FIELDS = ['a_client', 'a_order', 'a_date'];

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Exact, then case-insensitive, then ignoring punctuation. Never fuzzy. */
function pick(candidates, available) {
  const byExact = new Map(available.map((a) => [a, a]));
  const byLower = new Map(available.map((a) => [a.toLowerCase(), a]));
  const byNorm = new Map(available.map((a) => [norm(a), a]));
  for (const c of candidates) {
    if (!c) continue;
    const hit = byExact.get(c) || byLower.get(String(c).toLowerCase()) || byNorm.get(norm(c));
    if (hit) return hit;
  }
  return null;
}

/** The configured name first, then the known alternatives, with no duplicates. */
const candidatesFor = (key) => [...new Set([CONFIGURED[key], ...(ALIASES[key] || [])])];

async function tableNames() {
  const rows = await query(`
    SELECT TABLE_NAME AS t
    FROM INFORMATION_SCHEMA.TABLES
    WHERE TABLE_SCHEMA = DATABASE()
  `);
  return rows.map((r) => String(r.t));
}

async function columnNames(table) {
  const rows = await query(`
    SELECT COLUMN_NAME AS c
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t
  `, { t: table });
  return rows.map((r) => String(r.c));
}

let resolvedPromise = null;
let failedAt = 0;
let report = { state: 'not resolved yet' };

const NEGATIVE_CACHE_MS = 30000;

/** What the last resolution concluded — for /health and the startup log. */
export function schemaReport() {
  return report;
}

/** Throw away the cached answer so the next request re-reads the database. */
export function forgetSchema() {
  resolvedPromise = null;
  failedAt = 0;
}

/**
 * The resolved schema: the same shape queries.js has always used, except that a
 * name which does not exist in the database comes back as `null` instead of a
 * string that would blow the query up.
 *
 * Read once and remembered. A FAILURE is remembered for 30 seconds only, so a
 * database that comes back, or a column that gets put back, does not need the
 * service restarted.
 */
export function resolveSchema() {
  if (resolvedPromise) return resolvedPromise;
  if (failedAt && Date.now() - failedAt < NEGATIVE_CACHE_MS) {
    return Promise.reject(new Error(report.error || 'The analytics schema could not be read.'));
  }

  resolvedPromise = (async () => {
    const tables = await tableNames();

    const ordersTable = pick(candidatesFor('orders'), tables);
    if (!ordersTable) {
      throw new Error(
        `The orders table could not be found in this database. Looked for: ${candidatesFor('orders').join(', ')}. `
        + `The database has: ${tables.slice(0, 40).join(', ')}${tables.length > 40 ? ', …' : ''}. `
        + `Set SQL_ORDERS_TABLE to the right one.`,
      );
    }

    const attemptsTable = pick(candidatesFor('attempts'), tables);
    const orderCols = await columnNames(ordersTable);
    const attemptCols = attemptsTable ? await columnNames(attemptsTable) : [];

    const out = { orders: ordersTable, attempts: attemptsTable };
    const missing = [];
    const renamed = [];

    const resolveInto = (key, available) => {
      const hit = pick(candidatesFor(key), available);
      out[key] = hit;
      if (!hit) missing.push(key);
      else if (hit !== CONFIGURED[key]) renamed.push(`${key}: ${CONFIGURED[key]} -> ${hit}`);
      // Anything that reaches the SQL builder has to survive ident(); a column
      // name the database reports but that is not a plain identifier is treated
      // as missing rather than concatenated into a query.
      if (hit) { try { ident(hit); } catch { out[key] = null; missing.push(key); } }
    };

    for (const key of Object.keys(ALIASES)) {
      if (key === 'orders' || key === 'attempts') continue;
      resolveInto(key, key.startsWith('a_') ? attemptCols : orderCols);
    }

    const missingRequired = REQUIRED_ORDER_FIELDS.filter((k) => !out[k]);
    if (missingRequired.length) {
      throw new Error(
        `The orders table \`${ordersTable}\` is missing ${missingRequired.length === 1 ? 'a column' : 'columns'} the dashboard cannot work without: `
        + missingRequired.map((k) => `${k} (looked for ${candidatesFor(k).join(' / ')})`).join('; ')
        + `. \`${ordersTable}\` actually has: ${orderCols.join(', ')}.`,
      );
    }

    // The attempts half is optional as a WHOLE. If its table is gone, or it has
    // lost one of the three columns that make it usable, the delivery-attempt
    // figures are left empty and the orders half still loads. Half a dashboard
    // that is entirely correct beats none.
    if (attemptsTable && REQUIRED_ATTEMPT_FIELDS.some((k) => !out[k])) {
      console.warn(`[schema] \`${attemptsTable}\` is missing ${REQUIRED_ATTEMPT_FIELDS.filter((k) => !out[k]).join(', ')}`
        + ' — delivery attempt figures will be blank until that is corrected.');
      out.attempts = null;
    }

    report = {
      state: 'resolved',
      at: new Date().toISOString(),
      ordersTable: out.orders,
      attemptsTable: out.attempts || '(not available — attempt figures will be blank)',
      renamed: renamed.length ? renamed : undefined,
      unavailable: missing.length ? missing : undefined,
    };
    if (renamed.length) console.log('[schema] the extract has changed since this was written:', renamed.join(' | '));
    if (missing.length) console.warn('[schema] not available, those figures will show a dash:', missing.join(', '));
    console.log(`[schema] using \`${out.orders}\`${out.attempts ? ` and \`${out.attempts}\`` : ' (no attempts table)'}`);

    return out;
  })();

  resolvedPromise.catch((e) => {
    // Do not hold on to a failed answer: the next request should try again.
    resolvedPromise = null;
    failedAt = Date.now();
    report = { state: 'failed', at: new Date().toISOString(), error: e?.message || String(e) };
    console.error('[schema] could not resolve the extract schema:', e?.message || e);
  });

  return resolvedPromise;
}