// ---------------------------------------------------------------------------
// SGK ANALYTICS API — live figures from the Go2Stream WMS extract (MySQL),
// served to the portal dashboards.
//
// One endpoint does the whole dashboard:
//   GET /analytics/overview?year=&month=&from=&to=&service=[&company=]
//
// Every request: verify the Cognito token -> resolve the company SERVER SIDE ->
// read only that company's rows. `company` is honoured for SGK staff only, and
// ignored outright for everyone else.
//
// Nothing here writes. The SQL login should be db_datareader and no more.
// ---------------------------------------------------------------------------
import express from 'express';
import { verifyToken, authConfigured } from './auth.js';
import { resolveCompany, listCompanies, isSgk, describeAccess } from './clients.js';
import { sqlConfigured, ping } from './db.js';
import { resolveSchema, schemaReport, forgetSchema } from './schema.js';
import * as Q from './queries.js';
import { demoFor, demoEnabled } from './demo.js';
import { secondsToDays, secondsToHours, humanDuration, interpretations, configuredUnit } from './durations.js';
import { meanOf, foldRows, foldAttempts, forMonth, partnerTotals, weekTotals, monthTotals } from './rollup.js';

const app = express();
const PORT = process.env.PORT || 8080;

// CORS — locked to the portal. A wildcard would let any site on the internet
// replay a signed-in user's token against this service from their browser.
const ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://portal.sgkhomedelivery.co.uk,https://sgkhomedelivery.co.uk,http://localhost:5173')
  .split(',').map((s) => s.trim()).filter(Boolean);

app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (origin && ORIGINS.includes(origin)) res.set('Access-Control-Allow-Origin', origin);
  res.set('Vary', 'Origin');
  res.set('Access-Control-Allow-Methods', 'GET,OPTIONS');
  res.set('Access-Control-Allow-Headers', 'Authorization,Content-Type');
  res.set('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ---------------------------------------------------------------------------
// CACHE — fresh, then stale-while-revalidate, with in-flight de-duplication.
//
// A dashboard built from nine reads over a warehouse extract is never going to
// be instant on a cold cache. What it CAN be is instant every time after that,
// and it can stop several people arriving at once from each triggering their own
// full rebuild.
//
// THREE BEHAVIOURS, in order:
//
//   FRESH   (< TTL)        -> return it, do nothing else.
//   STALE   (< STALE_MAX)  -> RETURN IT IMMEDIATELY and refresh in the
//                             background. The person gets figures now, slightly
//                             behind, and the next visitor gets the new ones. A
//                             45-second TTL on a 20-second query meant almost
//                             every visitor waited for a rebuild.
//   MISSING / too old      -> build it, and make everyone else asking for the
//                             same key wait on that ONE build rather than
//                             starting their own.
//
// The last part matters most on a slow database: without it, five people opening
// the dashboard together used to run five identical 20-second queries, each
// making the others slower.
//
// Keys already include the company's sqlKey (see `f` below), so nothing here can
// serve one company's figures to another.
// ---------------------------------------------------------------------------
const TTL = Number(process.env.CACHE_TTL_MS || 120000);
const STALE_MAX = Number(process.env.CACHE_STALE_MS || 900000);   // 15 minutes
const cache = new Map();
const inFlight = new Map();

function evictIfLarge() {
  if (cache.size <= 300) return;
  // Oldest first, not insertion order — the oldest entries are the ones least
  // likely to be wanted again.
  const oldest = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, 100);
  for (const [k] of oldest) cache.delete(k);
}

function build(key, fn) {
  const running = inFlight.get(key);
  if (running) return running;
  const p = (async () => {
    try {
      const value = await fn();
      cache.set(key, { at: Date.now(), value });
      evictIfLarge();
      return value;
    } finally {
      inFlight.delete(key);
    }
  })();
  inFlight.set(key, p);
  return p;
}

/**
 * For things that barely change — the Year and Service Level dropdowns.
 *
 * Its own long TTL so a filter change never rebuilds them, and it still serves
 * the old list while refreshing rather than making anyone wait for a DISTINCT
 * scan over a client's whole history.
 */
const LONG_TTL = Number(process.env.CACHE_FACETS_MS || 3600000);   // 1 hour
async function cachedLong(key, fn) {
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;
  if (hit && age < LONG_TTL) return hit.value;
  if (hit) {
    build(key, fn).catch((e) => console.warn('[analytics] facet refresh failed:', e?.message || e));
    return hit.value;
  }
  return build(key, fn);
}

const cached = async (key, fn) => {
  const hit = cache.get(key);
  const age = hit ? Date.now() - hit.at : Infinity;

  if (hit && age < TTL) return hit.value;

  if (hit && age < STALE_MAX) {
    // Serve now, refresh behind. The catch matters: an unhandled rejection here
    // would take the process down for a refresh nobody was waiting on.
    build(key, fn).catch((e) => console.warn('[analytics] background refresh failed:', e?.message || e));
    return hit.value;
  }

  return build(key, fn);
};

/**
 * Does this error mean "the table is not the shape I was told it was"?
 *
 * MySQL is specific about it, so this matches on the CODES rather than on the
 * wording of a message that changes between versions and locales.
 */
const isSchemaDrift = (e) => ['ER_BAD_FIELD_ERROR', 'ER_NO_SUCH_TABLE', 'ER_UNKNOWN_TABLE', 'ER_WRONG_TABLE_NAME']
  .includes(e?.code || e?.cause?.code || '');

const num = (v) => (v === null || v === undefined ? null : Number(Number(v).toFixed(2)));
const pct = (part, whole) => (whole ? Number(((part / whole) * 100).toFixed(2)) : null);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ddMon = (d) => `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`;

app.get('/health', async (_req, res) => {
  let db = 'not configured';
  // WHICH TABLE AND WHICH COLUMNS IS IT ACTUALLY USING. The names are resolved
  // against the live database rather than assumed, so "the extract changed and
  // the dashboard broke" is answered by reading this instead of by guesswork:
  // it names the table it found, every column whose name has moved, and every
  // column it could not find at all (those show a dash on the dashboard).
  let schema = 'not checked — the database is not configured';
  if (sqlConfigured()) {
    try { await ping(); db = 'connected'; } catch (e) { db = `error: ${e?.message || e}`; }
    try { await resolveSchema(); } catch { /* the report below carries the reason */ }
    schema = schemaReport();
  }
  res.json({
    ok: true,
    db,
    schema,
    auth: authConfigured() ? 'configured' : 'not configured',
    clients: listCompanies().length,
    ...(demoEnabled() ? { demo: 'ON — serving frozen sample data, not live figures' } : {}),
  });
});

// DIAGNOSTIC. Answers "who does the server think I am, and why did my lookup
// fail" — so a misconfigured CLIENT_MAP takes one look instead of guesswork.
// Requires a valid token, and a client only ever sees their own entry.
app.get('/analytics/whoami', async (req, res) => {
  try {
    const identity = await verifyToken(req.headers.authorization);
    res.json(describeAccess(identity));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Every PartnerName in the extract — SGK staff only. This is where the sqlKey
// values for CLIENT_MAP come from, so nobody has to run a query by hand.
app.get('/analytics/partners', async (req, res) => {
  try {
    const identity = await verifyToken(req.headers.authorization);
    if (!isSgk(identity)) return res.status(403).json({ error: 'SGK staff only.' });
    if (!sqlConfigured()) return res.status(503).json({ error: 'The analytics database is not connected yet.' });
    res.json({ partners: await Q.partnerNames() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// DURATION DIAGNOSTIC — SGK staff only.
//
// Shows the three duration columns' real types alongside their raw MIN/AVG/MAX
// and what each average would mean if the column were seconds, minutes, hours,
// days, or HHMMSS digits from a TIME column. Exactly one of those readings is a
// believable delivery time, and that settles the unit by looking rather than by
// anybody guessing a second time.
app.get('/analytics/diag/durations', async (req, res) => {
  try {
    const identity = await verifyToken(req.headers.authorization);
    if (!isSgk(identity)) return res.status(403).json({ error: 'SGK staff only.' });
    if (!sqlConfigured()) return res.status(503).json({ error: 'The analytics database is not connected yet.' });
    const { company } = resolveCompany(identity, { companyId: req.query.company, companyName: req.query.companyName });
    if (!company) return res.json({ needsCompany: true, companies: listCompanies() });

    const d = await Q.durationDiagnostics({
      clientKey: company.sqlKey,
      year: req.query.year ? Number(req.query.year) : null,
    });
    res.json({
      company: { id: company.companyId, name: company.name },
      columnTypes: d.columnTypes,
      unitInUse: d.unitInUse,
      rowsConsidered: Number(d.raw.rows_considered || 0),
      confToBook:  { min: d.raw.minConfToBook, max: d.raw.maxConfToBook, ...interpretations(d.raw.avgConfToBook) },
      bookToDone:  { min: d.raw.minBookToDone, max: d.raw.maxBookToDone, ...interpretations(d.raw.avgBookToDone) },
      confToDone:  { min: d.raw.minConfToDone, max: d.raw.maxConfToDone, ...interpretations(d.raw.avgConfToDone) },
      howToRead: 'Pick the line that gives a believable delivery time. If that is not "ifSeconds", set SQL_DURATION_UNIT in /etc/sgk-analytics.env and restart.',
    });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

// Which companies SGK staff may switch between (the ones with a key configured).
app.get('/analytics/companies', async (req, res) => {
  try {
    const identity = await verifyToken(req.headers.authorization);
    if (!isSgk(identity)) return res.status(403).json({ error: 'SGK staff only.' });
    res.json({ companies: listCompanies() });
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.get('/analytics/overview', async (req, res) => {
  try {
    if (!sqlConfigured() && !demoEnabled()) {
      return res.status(503).json({ error: 'The analytics database is not connected yet.' });
    }

    const identity = await verifyToken(req.headers.authorization);
    const { staff, company } = resolveCompany(identity, { companyId: req.query.company, companyName: req.query.companyName });
    if (!company) {
      // SGK staff with no company chosen — tell them what they can pick.
      return res.json({ needsCompany: true, companies: listCompanies() });
    }

    const f = {
      clientKey: company.sqlKey,
      year: req.query.year ? Number(req.query.year) : null,
      month: req.query.month ? Number(req.query.month) : null,
      from: req.query.from || null,
      to: req.query.to || null,
      service: req.query.service || null,
    };
    // DEMO MODE. Note where this sits: AFTER the token has been verified and the
    // company resolved, so the same access rules apply. It is switched on only
    // by DEMO_MODE=true, never by the database being unreachable, and the
    // response is flagged demo:true so the page can say so on screen.
    if (demoEnabled()) {
      // Scoped to the company that owns the snapshot. Anyone else falls through
      // to the live path and sees an honest error rather than another client's
      // figures.
      const snapshot = demoFor(company.companyId, company.name, f);
      if (snapshot) {
        console.warn('[analytics] DEMO MODE — serving the frozen snapshot for', company.name);
        return res.json({
          company: { id: company.companyId, name: company.name },
          staff,
          demo: true,
          filters: { year: f.year, month: f.month, from: f.from, to: f.to, service: f.service },
          generatedAt: new Date().toISOString(),
          ...snapshot,
        });
      }
      if (!sqlConfigured()) {
        return res.status(503).json({ error: `No sample data is configured for ${company.name}, and the live database is not connected.` });
      }
    }

    // -----------------------------------------------------------------------
    // THE YEAR IS THE CACHE KEY — NOT THE MONTH.
    //
    // This is what makes changing the month instant. The year is read once, at
    // (month, week, partner) grain, and every month is added up from that in
    // memory. Picking February used to be a cold build of nine queries; it is
    // now zero queries.
    //
    // The month is deliberately left OUT of the key. Twelve months sharing one
    // cached year is the entire point — putting the month back in would restore
    // the old behaviour without anything looking wrong.
    // -----------------------------------------------------------------------
    const yearKey = JSON.stringify({ clientKey: f.clientKey, year: f.year, from: f.from, to: f.to, service: f.service });

    const facetsKey = `facets:${JSON.stringify(company.sqlKey)}`;
    // -----------------------------------------------------------------------
    // THE .catch() BELOW IS NOT TIDINESS. It is the reason the dashboard used to
    // say "Failed to fetch" instead of saying what was actually wrong.
    //
    // This promise is STARTED here and AWAITED six lines further down. If the
    // rollup in between throws first — which is exactly what a renamed column in
    // the extract does — the await is never reached, this rejection never gets a
    // handler, and Node treats an unhandled rejection as fatal: THE PROCESS
    // EXITS. systemd restarts it (Restart=always, RestartSec=5), the browser's
    // request dies with the severed connection, and fetch() reports the only
    // thing a browser can see at that point: "Failed to fetch". The real
    // database error never reaches the screen, and the service crash-loops for
    // as long as the schema is wrong.
    //
    // Catching it here does two separate jobs:
    //   * the process can no longer be killed by a failed dropdown query, so the
    //     genuine error gets returned and shown, and
    //   * failing to read the Year / Service Level lists degrades to EMPTY
    //     dropdowns rather than taking a perfectly good set of figures with it.
    //     The page already falls back to the current year when the list is empty.
    // -----------------------------------------------------------------------
    const facetsPromise = cachedLong(facetsKey, () => Q.facets(company.sqlKey))
      .catch((e) => {
        console.warn('[analytics] facets failed — the dropdowns will be empty:', e?.message || e);
        return { years: [], serviceLevels: [] };
      });

    const startedAt = Date.now();
    const roll = await cached(yearKey, () => Q.yearRollup(f));
    const facets = await facetsPromise;
    // Cold builds are the only ones that touch the database now. Logged so a
    // slow year is visible without anyone having to reproduce it.
    const tookMs = Date.now() - startedAt;
    if (tookMs > 1000) console.log(`[analytics] built ${f.year || 'all'} for ${company.name} in ${tookMs}ms`);

    // ---- everything below is arithmetic on what is already in memory ----
    const rows = forMonth(roll.orderRows, f.month);
    const totals = foldRows(rows);
    const attempts = foldAttempts(forMonth(roll.attemptRows, f.month));
    const perOrder = forMonth(roll.perOrderRows, f.month)
      .reduce((a, r) => ({
        noAttempt: a.noAttempt + Number(r.noAttempt || 0),
        firstTime: a.firstTime + Number(r.firstTime || 0),
        scopedOrders: a.scopedOrders + Number(r.scopedOrders || 0),
      }), { noAttempt: 0, firstTime: 0, scopedOrders: 0 });

    const attemptByKey = new Map(roll.attemptRows.map((r) => [`${r.y}-${r.m}`, r]));
    // Per-month first-time-success. This used to be hard-coded to null, so the
    // "first time %" line on the orders chart was pinned flat to 0% — which does
    // not read as "no data", it reads as "we never get it right first time".
    // The rollup already carries the numbers per month, so it can be real.
    const perOrderByKey = new Map(roll.perOrderRows.map((r) => [`${r.y}-${r.m}`, r]));
    const byMonth = monthTotals(rows).map((b) => {
      const a = attemptByKey.get(`${b.y}-${b.m}`) || {};
      const total = Number(a.total || 0);
      return {
        key: `${b.y}-${String(b.m).padStart(2, '0')}`,
        label: `${MONTHS[b.m - 1]} ${b.y}`,
        sales: num(b.sales), orders: b.orders,
        avgWeightKg: num(meanOf(b.weightSum, b.weightCnt)),
        avgCubeM3: num(meanOf(b.cubeSum, b.cubeCnt)),
        avgItemsPerOrder: num(meanOf(b.itemsSum, b.itemsCnt)),
        attempts: total,
        successful: Number(a.successful || 0),
        failed: Number(a.failed || 0),
        unknown: Number(a.outstanding || 0),
        successRatio: pct(Number(a.successful || 0), total),
        firstTimeRatio: (() => {
          const po = perOrderByKey.get(`${b.y}-${b.m}`);
          return po ? pct(Number(po.firstTime || 0), Number(po.scopedOrders || 0)) : null;
        })(),
        avgConfToCompletedDays: secondsToDays(meanOf(b.confToDoneSum, b.confToDoneCnt)),
        avgReceivedToDeliveredDays: secondsToDays(meanOf(b.bookToDoneSum, b.bookToDoneCnt)),
        avgReceivedToProposedDays: secondsToDays(meanOf(b.confToBookSum, b.confToBookCnt)),
        trendSuccessful: Number(a.successful || 0),
        trendFailed: Number(a.failed || 0),
        trendNoAttempt: Number(a.outstanding || 0),
      };
    });

    const byWeek = weekTotals(rows).map((w) => {
      const start = new Date(w.weekStart);
      const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
      return {
        key: start.toISOString().slice(0, 10),
        label: `${ddMon(start)} - ${ddMon(end)} ${String(end.getUTCFullYear()).slice(2)}`,
        sales: num(w.sales), orders: w.orders,
        avgWeightKg: num(meanOf(w.weightSum, w.weightCnt)),
        avgCubeM3: num(meanOf(w.cubeSum, w.cubeCnt)),
        avgItemsPerOrder: num(meanOf(w.itemsSum, w.itemsCnt)),
      };
    });

    const partners = partnerTotals(rows);
    const partnerSum = partners.reduce((n, x) => n + x.orders, 0);
    const totalAttempts = attempts.total;
    const secProposed = meanOf(totals.confToBookSum, totals.confToBookCnt);
    const secDelivered = meanOf(totals.bookToDoneSum, totals.bookToDoneCnt);
    const secCompleted = meanOf(totals.confToDoneSum, totals.confToDoneCnt);

    const data = {
      orders: {
        totalSales: num(totals.sales),
        totalOrders: totals.orders,
        completedOrders: totals.completed,
        avgWeightKg: num(meanOf(totals.weightSum, totals.weightCnt)),
        avgCubeM3: num(meanOf(totals.cubeSum, totals.cubeCnt)),
        avgItemsPerOrder: num(meanOf(totals.itemsSum, totals.itemsCnt)),
        avgReceivedToProposedDays: secondsToDays(secProposed),
        avgReceivedToDeliveredDays: secondsToDays(secDelivered),
        avgCreatedToDeliveredDays: secondsToDays(secCompleted),
        avgConfToCompletedDays: secondsToDays(secCompleted),
        avgReceivedToProposedHours: secondsToHours(secProposed),
        avgReceivedToDeliveredHours: secondsToHours(secDelivered),
        avgConfToCompletedHours: secondsToHours(secCompleted),
        avgReceivedToProposedText: humanDuration(secProposed),
        avgReceivedToDeliveredText: humanDuration(secDelivered),
        avgConfToCompletedText: humanDuration(secCompleted),
        firstTimeSuccessOrders: perOrder.firstTime,
        firstTimeSuccessRatio: pct(perOrder.firstTime, perOrder.scopedOrders || totals.orders),
        firstTimeProposalAcceptance: pct(totals.bookConf, totals.bookReq),
      },
      attempts: {
        total: totalAttempts,
        successful: attempts.successful,
        failed: attempts.failed,
        unknown: attempts.outstanding,
        noAttempt: perOrder.noAttempt,
        successRatio: pct(attempts.successful, totalAttempts),
        onTimePct: pct(attempts.onTime, totalAttempts),
        statusBreakdown: [
          { label: 'On Time', count: attempts.onTime, pct: pct(attempts.onTime, totalAttempts) },
          { label: 'Unknown', count: attempts.outstanding, pct: pct(attempts.outstanding, totalAttempts) },
          { label: 'Late', count: attempts.late, pct: pct(attempts.late, totalAttempts) },
          { label: 'Early', count: attempts.early, pct: pct(attempts.early, totalAttempts) },
        ],
      },
      byMonth,
      byWeek,
      byPartner: partners.map((p) => ({ name: p.name, orders: p.orders, pct: pct(p.orders, partnerSum) })),
      facets,
    };

    res.json({
      company: { id: company.companyId, name: company.name },
      staff,
      filters: { year: f.year, month: f.month, from: f.from, to: f.to, service: f.service },
      // Says out loud how the duration columns were read. An assumption on screen
      // gets questioned; an assumption in a comment does not.
      durationUnit: configuredUnit(),
      generatedAt: new Date().toISOString(),
      ...data,
    });
  } catch (e) {
    const status = e.status || 500;
    if (status >= 500) console.error('[analytics] overview failed:', e?.message || e);
    // If the extract has been changed UNDER a running service, the names were
    // resolved before the change and every read now fails on a column or table
    // that has moved. Throw the remembered answer away so the next request
    // re-reads the real schema and picks the change up on its own — otherwise
    // the dashboard stays broken until somebody notices and restarts it.
    if (isSchemaDrift(e)) {
      console.warn('[analytics] the extract looks like it has changed — re-reading the schema on the next request');
      forgetSchema();
    }
    res.status(status).json({ error: e.message || 'Analytics failed.' });
  }
});

// ---------------------------------------------------------------------------
// LAST LINE OF DEFENCE — a read-only service must never die of a failed read.
//
// The facets promise above was one specific way an unhandled rejection could
// take this process down. These two handlers make sure there is no second way.
// Without them, ANY promise that rejects with nobody awaiting it kills the
// service, and every dashboard open at that moment gets "Failed to fetch" —
// a message that says nothing about the cause and sends people to look at the
// network when the problem is a column name.
//
// Deliberately LOG AND CARRY ON rather than exit. Nothing here writes to the
// database, holds a transaction, or mutates shared state that could be left
// half-finished, so there is no corrupted state to protect by dying. The
// request that caused it has already had its own error handled and answered;
// staying up means the next request gets a real answer instead of a dead socket.
// ---------------------------------------------------------------------------
process.on('unhandledRejection', (reason) => {
  console.error('[analytics] unhandled promise rejection (service kept running):', reason?.message || reason);
});
process.on('uncaughtException', (err) => {
  console.error('[analytics] uncaught exception (service kept running):', err?.stack || err?.message || err);
});

app.listen(PORT, () => {
  console.log(`[analytics] listening on ${PORT}`);
  console.log(`[analytics] origins: ${ORIGINS.join(', ')}`);
  if (!authConfigured()) console.warn('[analytics] COGNITO_USER_POOL_ID is not set — every request will be rejected.');
  if (!sqlConfigured()) console.warn('[analytics] MySQL is not configured — /analytics/overview will return 503.');
});