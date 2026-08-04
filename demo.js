// ---------------------------------------------------------------------------
// DEMO MODE — a frozen snapshot, for showing the dashboard when the database
// cannot be reached.
//
// READ THIS BEFORE USING IT.
//
// These are NOT invented numbers. Every figure below is lifted from the existing
// Power BI report for Roseland Furniture, Jan–Jul 2026 — the same report they
// already receive. So what the dashboard draws in demo mode is their own data,
// just frozen rather than live.
//
// It is still not live, and the dashboard says so on screen: the response
// carries demo:true and the page shows a "Sample data" banner. That banner is
// deliberate and must not be removed. A client looking at a screen has no way of
// knowing whether numbers are real unless we tell them.
//
// Switched on ONLY by an explicit environment variable:
//
//     DEMO_MODE=true
//
// It never turns itself on because the database happens to be down. Silent
// fallback to fake figures is how people end up making decisions on fiction.
// Turn it off the moment the real connection works:
//
//     DEMO_MODE=false   (then restart the service)
// ---------------------------------------------------------------------------

const MONTHS = [
  // label,      sales,    orders, kg,    m3,   items, attempts, ok,  failed
  // successful/failed/attempts are the report's own monthly figures, and they
  // add up to its headline totals: 882 attempts, 757 successful, 59 failed.
  ['Jan 2026', 11757.60, 162, 18.40, 0.89, 4.4, 160, 143,  9],
  ['Feb 2026', 11531.01, 146, 21.30, 0.89, 4.6, 164, 142, 12],
  ['Mar 2026',  9473.20, 129, 19.28, 0.83, 4.4, 140, 119,  9],
  ['Apr 2026',  9994.35, 140, 19.55, 0.81, 4.6, 137, 122,  9],
  ['May 2026',  7220.05,  79, 21.72, 0.81, 5.0,  87,  73,  6],
  ['Jun 2026',  8438.95, 115, 20.10, 0.75, 4.5, 125, 104, 11],
  ['Jul 2026',  4174.40,  92, 19.10, 0.79, 4.4,  69,  54,  3],
];

const WEEKS = [
  ['2026-01-12', '12 Jan - 18 Jan 26', 3419.70, 47, 19.30, 0.81],
  ['2026-02-23', '23 Feb - 01 Mar 26', 3311.60, 44, 21.10, 0.87],
  ['2026-04-06', '06 Apr - 12 Apr 26', 3232.85, 45, 19.60, 0.80],
  ['2026-02-16', '16 Feb - 22 Feb 26', 3081.96, 41, 20.80, 0.88],
  ['2026-01-05', '05 Jan - 11 Jan 26', 2836.25, 39, 19.71, 1.10],
  ['2026-02-02', '02 Feb - 08 Feb 26', 2798.15, 38, 20.55, 0.82],
  ['2026-03-02', '02 Mar - 08 Mar 26', 2738.90, 37, 19.40, 0.84],
  ['2026-04-13', '13 Apr - 19 Apr 26', 2650.20, 36, 19.20, 0.79],
  ['2026-04-27', '27 Apr - 03 May 26', 2396.00, 33, 20.10, 0.80],
  ['2026-01-26', '26 Jan - 01 Feb 26', 2276.05, 31, 17.50, 0.84],
  ['2026-01-19', '19 Jan - 25 Jan 26', 2148.30, 30, 16.48, 0.76],
  ['2026-02-09', '09 Feb - 15 Feb 26', 2339.30, 32, 20.89, 0.99],
];

const round2 = (n) => Number(n.toFixed(2));

export function demoPayload(filters = {}) {
  // The filters still do something, so the page does not look broken when
  // someone clicks Month during a demo.
  let months = MONTHS.map((m, i) => ({ m, monthNo: i + 1 }));
  if (filters.month) months = months.filter((x) => x.monthNo === Number(filters.month));

  const byMonth = months.map(({ m, monthNo }) => {
    const [label, sales, orders, kg, m3, items, attempts, ok, failed] = m;
    return {
      key: `2026-${String(monthNo).padStart(2, '0')}`,
      label,
      sales: round2(sales),
      orders,
      avgWeightKg: kg,
      avgCubeM3: m3,
      avgItemsPerOrder: items,
      attempts,
      successful: ok,
      failed,
      successRatio: attempts ? round2((ok / attempts) * 100) : null,
    };
  });

  const byWeek = (filters.month
    ? WEEKS.filter((w) => Number(w[0].slice(5, 7)) === Number(filters.month))
    : WEEKS
  ).map(([key, label, sales, orders, kg, m3]) => ({
    key, label, sales: round2(sales), orders, avgWeightKg: kg, avgCubeM3: m3,
  }));

  const totalSales = round2(byMonth.reduce((n, m) => n + (m.sales || 0), 0));
  const totalOrders = byMonth.reduce((n, m) => n + m.orders, 0);
  const attempts = byMonth.reduce((n, m) => n + m.attempts, 0);
  const successful = byMonth.reduce((n, m) => n + m.successful, 0);
  const failed = byMonth.reduce((n, m) => n + m.failed, 0);

  const avg = (pick, weight = 'orders') => {
    const w = byMonth.reduce((n, m) => n + m[weight], 0);
    if (!w) return null;
    return round2(byMonth.reduce((n, m) => n + m[pick] * m[weight], 0) / w);
  };

  return {
    orders: {
      totalSales,
      totalOrders,
      completedOrders: Math.round(totalOrders * 0.9548),   // 824 of 863 in the report
      avgWeightKg: avg('avgWeightKg'),
      avgCubeM3: avg('avgCubeM3'),
      avgItemsPerOrder: avg('avgItemsPerOrder'),
      avgReceivedToProposedDays: 2.36,
      avgReceivedToDeliveredDays: 1.30,
      avgCreatedToDeliveredDays: 8.41,
      firstTimeSuccessOrders: Math.round(totalOrders * 0.6199),
      firstTimeSuccessRatio: 61.99,
    },
    attempts: {
      total: attempts,
      successful,
      failed,
      noAttempt: 11,
      successRatio: attempts ? round2((successful / attempts) * 100) : null,
      onTimePct: 98.55,
    },
    byMonth,
    byWeek,
    facets: {
      years: [2026],
      serviceLevels: ['Two Man Delivery', 'Room of Choice', 'Standard'],
    },
  };
}

export const demoEnabled = () => process.env.DEMO_MODE === 'true';
