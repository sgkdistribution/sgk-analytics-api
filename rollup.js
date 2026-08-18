// ---------------------------------------------------------------------------
// YEAR ROLLUP — read the year ONCE, answer every month from memory.
//
// THE PROBLEM THIS SOLVES. Picking a month was a different cache key, so it was
// a cold build every time: nine queries, each reading the orders and stops
// tables end to end. Twelve months meant twelve full rebuilds of the same year's
// data, and every one of them made you wait.
//
// THE IDEA. Nothing about a month needs its own query. A month is a SUBSET of
// the year, so if the year is read at a fine enough grain, every month — and the
// whole year, and any single week — can be added up from that one result in
// memory, with no database round trip at all.
//
// So this reads the year at (month, week, partner) grain. That is about 120 rows
// for a year, held in the cache. Switching months then costs nothing.
//
// THE ONE THING THAT MAKES IT CORRECT: **averages are never averaged.** You
// cannot take a monthly average weight and average the twelve to get the year —
// months with 9,000 orders and months with 900 would count equally and the answer
// would be quietly wrong. Every averaged metric is therefore fetched as a SUM and
// a COUNT, and recombined as SUM(sums) / SUM(counts), which is exactly what AVG
// over the whole set would have returned. rollup.test verifies that against
// directly-computed averages rather than trusting the reasoning.
//
// COUNT(DISTINCT OrderID) is summable here for a related reason: an order falls
// in exactly one (month, week, partner) group — its own — so no order is counted
// in two groups and the totals cannot double up.
// ---------------------------------------------------------------------------

/** SUM/COUNT pair -> the true mean, or null when nothing was counted. */
export const meanOf = (sum, count) => {
  const c = Number(count || 0);
  if (!c) return null;
  return Number(sum || 0) / c;
};

/** Add b's sum/count pair into a, in place. */
const addPair = (a, b, key) => {
  a[`${key}Sum`] = Number(a[`${key}Sum`] || 0) + Number(b[`${key}Sum`] || 0);
  a[`${key}Cnt`] = Number(a[`${key}Cnt`] || 0) + Number(b[`${key}Cnt`] || 0);
};

const AVERAGED = ['weight', 'cube', 'items', 'confToBook', 'bookToDone', 'confToDone'];

/** An empty accumulator with every sum/count pair zeroed. */
export function emptyBucket() {
  const b = { sales: 0, orders: 0, completed: 0, bookReq: 0, bookConf: 0 };
  for (const k of AVERAGED) { b[`${k}Sum`] = 0; b[`${k}Cnt`] = 0; }
  return b;
}

/** Fold one grouped row into an accumulator. */
export function addRow(bucket, row) {
  bucket.sales += Number(row.sales || 0);
  bucket.orders += Number(row.orders || 0);
  bucket.completed += Number(row.completed || 0);
  bucket.bookReq += Number(row.bookReq || 0);
  bucket.bookConf += Number(row.bookConf || 0);
  for (const k of AVERAGED) addPair(bucket, row, k);
  return bucket;
}

/** Fold a list of grouped rows into one bucket. */
export const foldRows = (rows) => rows.reduce(addRow, emptyBucket());

/** The same, for the attempts (stops) side. */
export function emptyAttempts() {
  return { total: 0, successful: 0, failed: 0, onTime: 0, late: 0, early: 0, outstanding: 0 };
}
export function addAttempts(acc, row) {
  for (const k of Object.keys(acc)) acc[k] += Number(row[k] || 0);
  return acc;
}
export const foldAttempts = (rows) => rows.reduce(addAttempts, emptyAttempts());

/**
 * Keep only the rows for one month. `null` month means the whole year, which is
 * why the same code path serves both and they cannot disagree.
 */
export const forMonth = (rows, month) =>
  (month ? rows.filter((r) => Number(r.m) === Number(month)) : rows);

/**
 * Roll the per-partner rows up into one entry per partner name.
 * Order is by size, biggest first, so the doughnut legend reads sensibly.
 */
export function partnerTotals(rows) {
  const by = new Map();
  for (const r of rows) {
    const name = String(r.partner ?? '');
    by.set(name, (by.get(name) || 0) + Number(r.orders || 0));
  }
  return [...by.entries()]
    .map(([name, orders]) => ({ name, orders }))
    .sort((a, b) => b.orders - a.orders);
}

/**
 * Roll the week rows up. A week is identified by its Monday, and a week can
 * straddle two months — which is why weeks are grouped on their own key in SQL
 * rather than being derived from the month buckets afterwards.
 */
export function weekTotals(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = String(r.weekStart ?? '');
    if (!key) continue;
    if (!by.has(key)) by.set(key, emptyBucket());
    addRow(by.get(key), r);
  }
  return [...by.entries()]
    .map(([weekStart, b]) => ({ weekStart, ...b }))
    .sort((a, b) => String(a.weekStart).localeCompare(String(b.weekStart)));
}

/** Roll the rows up into one bucket per calendar month, in order. */
export function monthTotals(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = `${r.y}-${String(r.m).padStart(2, '0')}`;
    if (!by.has(key)) by.set(key, { y: Number(r.y), m: Number(r.m), ...emptyBucket() });
    addRow(by.get(key), r);
  }
  return [...by.values()].sort((a, b) => a.y - b.y || a.m - b.m);
}