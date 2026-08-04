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

// A short shared cache. Twelve people watching the same dashboard should not be
// twelve times the load on the warehouse database.
const TTL = Number(process.env.CACHE_TTL_MS || 45000);
const cache = new Map();
const cached = async (key, fn) => {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.value;
  const value = await fn();
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 300) for (const k of [...cache.keys()].slice(0, 100)) cache.delete(k);
  return value;
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

    const data = await cached(key, async () => {
      const [totals, firstTime, attempts, noAttempt, months, attemptMonths, weeks, facets, partners] = await Promise.all([
        Q.orderTotals(f), Q.firstTimeSuccess(f), Q.attemptTotals(f), Q.noAttemptCount(f),
        Q.byMonth(f), Q.attemptsByMonth(f), Q.byWeek(f), Q.facets(company.sqlKey), Q.byPartner(f),
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
          avgConfToCompletedDays: num(r.avgConfToCompletedDays),
          avgReceivedToDeliveredDays: num(r.avgReceivedToDeliveredDays),
          avgReceivedToProposedDays: num(r.avgReceivedToProposedDays),
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
      const scopedOrders = Number(firstTime.scopedOrders || totals.totalOrders || 0);
      const ftsOrders = Number(firstTime.firstTimeSuccessOrders || 0);

      return {
        orders: {
          totalSales: num(totals.totalSales),
          totalOrders: Number(totals.totalOrders || 0),
          completedOrders: Number(totals.completedOrders || 0),
          avgWeightKg: num(totals.avgWeightKg),
          avgCubeM3: num(totals.avgCubeM3),
          avgItemsPerOrder: num(totals.avgItemsPerOrder),
          avgReceivedToProposedDays: num(totals.avgReceivedToProposedDays),
          avgReceivedToDeliveredDays: num(totals.avgReceivedToDeliveredDays),
          avgCreatedToDeliveredDays: num(totals.avgCreatedToDeliveredDays),
          avgConfToCompletedDays: num(totals.avgCreatedToDeliveredDays),
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