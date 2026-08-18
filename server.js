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
import * as Q from './queries.js';
import { demoFor, demoEnabled } from './demo.js';
import { secondsToDays, secondsToHours, humanDuration, interpretations, configuredUnit } from './durations.js';

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

const num = (v) => (v === null || v === undefined ? null : Number(Number(v).toFixed(2)));
const pct = (part, whole) => (whole ? Number(((part / whole) * 100).toFixed(2)) : null);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ddMon = (d) => `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]}`;

app.get('/health', async (_req, res) => {
  let db = 'not configured';
  if (sqlConfigured()) {
    try { await ping(); db = 'connected'; } catch (e) { db = `error: ${e?.message || e}`; }
  }
  res.json({
    ok: true,
    db,
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

    const key = JSON.stringify(f);

    // FACETS ARE CACHED SEPARATELY AND FOR MUCH LONGER. They are the Year and
    // Service Level dropdowns — they do not depend on the filters at all, yet
    // they were inside the per-filter cache, so changing the year re-ran two
    // DISTINCT scans over the whole client's history to rebuild a list that had
    // not changed. Keyed by the company's sqlKey, so it is still per company.
    const facetsKey = `facets:${JSON.stringify(company.sqlKey)}`;
    const facetsPromise = cachedLong(facetsKey, () => Q.facets(company.sqlKey));

    const data = await cached(key, async () => {
      const [totals, firstTime, attempts, noAttempt, months, attemptMonths, weeks, facets, partners] = await Promise.all([
        Q.orderTotals(f), Q.firstTimeSuccess(f), Q.attemptTotals(f), Q.noAttemptCount(f),
        Q.byMonth(f), Q.attemptsByMonth(f), Q.byWeek(f), facetsPromise, Q.byPartner(f),
      ]);

      const attemptByKey = new Map(attemptMonths.map((r) => [`${r.y}-${r.m}`, r]));
      const byMonth = months.map((r) => {
        const a = attemptByKey.get(`${r.y}-${r.m}`) || {};
        const total = Number(a.total || 0);
        return {
          key: `${r.y}-${String(r.m).padStart(2, '0')}`,
          label: `${MONTHS[r.m - 1]} ${r.y}`,
          sales: num(r.sales), orders: Number(r.orders || 0),
          avgWeightKg: num(r.avgWeightKg), avgCubeM3: num(r.avgCubeM3), avgItemsPerOrder: num(r.avgItemsPerOrder),
          attempts: total,
          successful: Number(a.successful || 0),
          failed: Number(a.failed || 0),
          unknown: Number(a.unknown || 0),
          successRatio: pct(Number(a.successful || 0), total),
          firstTimeRatio: null,
          avgConfToCompletedDays: secondsToDays(r.avgConfToCompletedSec),
          avgReceivedToDeliveredDays: secondsToDays(r.avgReceivedToDeliveredSec),
          avgReceivedToProposedDays: secondsToDays(r.avgReceivedToProposedSec),
          trendSuccessful: Number(a.successful || 0),
          trendFailed: Number(a.failed || 0),
          trendNoAttempt: Number(a.unknown || 0),
        };
      });

      const byWeek = weeks.map((r) => {
        const start = new Date(r.weekStart);
        const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
        return {
          key: start.toISOString().slice(0, 10),
          label: `${ddMon(start)} - ${ddMon(end)} ${String(end.getUTCFullYear()).slice(2)}`,
          sales: num(r.sales), orders: Number(r.orders || 0),
          avgWeightKg: num(r.avgWeightKg), avgCubeM3: num(r.avgCubeM3),
          avgItemsPerOrder: num(r.avgItemsPerOrder),
        };
      });

      const totalAttempts = Number(attempts.total || 0);
      // Was a second COUNT(*) inside firstTimeSuccess; OrderID is the primary key
      // so this is the same number for one less pass over the table.
      const scopedOrders = Number(totals.totalOrders || 0);
      const ftsOrders = Number(firstTime.firstTimeSuccessOrders || 0);

      return {
        orders: {
          totalSales: num(totals.totalSales),
          totalOrders: Number(totals.totalOrders || 0),
          completedOrders: Number(totals.completedOrders || 0),
          avgWeightKg: num(totals.avgWeightKg),
          avgCubeM3: num(totals.avgCubeM3),
          avgItemsPerOrder: num(totals.avgItemsPerOrder),
          // DURATIONS. Two things were wrong here.
          //
          // 1. The unit. These came straight out of SQL and were labelled "days"
          //    on an assumption nobody checked — hence "384,329.26 days", which
          //    is a thousand years. They are now seconds by the time they reach
          //    this line, converted from whatever the column actually stores.
          //
          // 2. THE LAST LINE READ THE WRONG FIELD. avgConfToCompleted was fed
          //    avgCreatedToDelivered, so two tiles showed one number twice and
          //    it looked like a coincidence rather than a bug.
          //
          // Days and hours are both sent: "0.06 days" tells a reader nothing,
          // and the page picks whichever suits the size.
          avgReceivedToProposedDays: secondsToDays(totals.avgReceivedToProposedSec),
          avgReceivedToDeliveredDays: secondsToDays(totals.avgReceivedToDeliveredSec),
          avgCreatedToDeliveredDays: secondsToDays(totals.avgConfToCompletedSec),
          avgConfToCompletedDays: secondsToDays(totals.avgConfToCompletedSec),
          avgReceivedToProposedHours: secondsToHours(totals.avgReceivedToProposedSec),
          avgReceivedToDeliveredHours: secondsToHours(totals.avgReceivedToDeliveredSec),
          avgConfToCompletedHours: secondsToHours(totals.avgConfToCompletedSec),
          avgReceivedToProposedText: humanDuration(totals.avgReceivedToProposedSec),
          avgReceivedToDeliveredText: humanDuration(totals.avgReceivedToDeliveredSec),
          avgConfToCompletedText: humanDuration(totals.avgConfToCompletedSec),
          firstTimeSuccessOrders: ftsOrders,
          firstTimeSuccessRatio: pct(ftsOrders, scopedOrders),
          firstTimeProposalAcceptance: pct(Number(totals.bookingsConfirmed || 0), Number(totals.bookingsRequested || 0)),
        },
        attempts: {
          total: totalAttempts,
          successful: Number(attempts.successful || 0),
          failed: Number(attempts.failed || 0),
          unknown: Number(attempts.outstanding || 0),
          noAttempt,
          successRatio: pct(Number(attempts.successful || 0), totalAttempts),
          onTimePct: pct(Number(attempts.onTime || 0), totalAttempts),
          statusBreakdown: [
            { label: 'On Time', count: Number(attempts.onTime || 0), pct: pct(Number(attempts.onTime || 0), totalAttempts) },
            { label: 'Unknown', count: Number(attempts.outstanding || 0), pct: pct(Number(attempts.outstanding || 0), totalAttempts) },
            { label: 'Late', count: Number(attempts.late || 0), pct: pct(Number(attempts.late || 0), totalAttempts) },
            { label: 'Early', count: Number(attempts.early || 0), pct: pct(Number(attempts.early || 0), totalAttempts) },
          ],
        },
        byMonth,
        byWeek,
        byPartner: partners.map((p) => ({
          name: String(p.name),
          orders: Number(p.orders || 0),
          pct: pct(Number(p.orders || 0), partners.reduce((n, x) => n + Number(x.orders || 0), 0)),
        })),
        facets,
      };
    });

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
    res.status(status).json({ error: e.message || 'Analytics failed.' });
  }
});

app.listen(PORT, () => {
  console.log(`[analytics] listening on ${PORT}`);
  console.log(`[analytics] origins: ${ORIGINS.join(', ')}`);
  if (!authConfigured()) console.warn('[analytics] COGNITO_USER_POOL_ID is not set — every request will be rejected.');
  if (!sqlConfigured()) console.warn('[analytics] MySQL is not configured — /analytics/overview will return 503.');
});