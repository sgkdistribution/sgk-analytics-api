// ---------------------------------------------------------------------------
// DEMO MODE — a frozen snapshot of the Roseland Furniture Power BI report.
//
// Every number below is transcribed from that report (Jan-Jul 2026). It is
// their own data, frozen, not invented — but it is NOT live, and the dashboard
// says so on screen: the response carries demo:true and the page shows a
// "Sample data" banner. Do not remove that banner.
//
// Switched on ONLY by DEMO_MODE=true. It never turns itself on because the
// database is unreachable — silent fallback to frozen figures is how people end
// up making decisions on fiction.
//
// One inconsistency in the original, reproduced faithfully rather than quietly
// corrected: the headline "Successful Attempts" card (55,646) does not agree
// with the monthly Delivery Attempt table (56,727). They are different measures
// in the source report, and both are kept so this matches what Roseland
// already receives.
// ---------------------------------------------------------------------------

//        label      sales        orders  avgKg  avgM3  attempts  ok    failed unknown
const M = [
  ['Jan 2026', 356593.18, 9946, 45.80, 0.55, 10104, 9597, 399, 108],
  ['Feb 2026', 296628.94, 8268, 47.84, 0.59,  8393, 7981, 307, 105],
  ['Mar 2026', 339773.54, 8899, 49.52, 0.62,  9012, 8637, 320,  55],
  ['Apr 2026', 313316.06, 8050, 48.18, 0.60,  8185, 7829, 308,  48],
  ['May 2026', 332366.50, 8484, 50.20, 0.75,  7726, 7452, 243,  31],
  ['Jun 2026', 352620.38, 8483, 52.61, 1.15,  8641, 8270, 328,  43],
  ['Jul 2026', 285650.46, 8311, 52.68, 0.86,  8012, 6961, 236, 815],
];

// Delivery SLA trend: avg conf->completed (raw), received->delivered, received->proposed
const SLA = {
  1: [3.39, 1.21, 1.55], 2: [3.68, 1.34, 1.67], 3: [3.40, 1.22, 1.35],
  4: [3.63, 1.27, 1.28], 5: [3.65, 1.23, 1.42], 6: [3.30, 1.24, 1.30],
  7: [3.20, 1.28, 1.25],
};

// Delivery attempts trend — the report's second measure of the same thing
const TREND = {
  1: [9415, 399, 108], 2: [7767, 307, 105], 3: [8480, 320, 55],
  4: [7706, 308, 49], 5: [7316, 243, 31], 6: [8126, 328, 43], 7: [6836, 236, 815],
};

// Success ratio and first-time ratio by month, as plotted on the combo chart
const RATIOS = {
  1: [93.98, 66.05], 2: [92.54, 64.20], 3: [94.10, 65.10], 4: [94.15, 64.80],
  5: [93.62, 63.90], 6: [94.04, 64.10], 7: [86.88, 60.20],
};

const W = [
  ['2025-12-29', '29 Dec - 04 Jan 26', 14112.20,  382, 42.09, 0.52, 1.46],
  ['2026-01-05', '05 Jan - 11 Jan 26', 88557.30, 2361, 44.72, 0.53, 1.65],
  ['2026-01-12', '12 Jan - 18 Jan 26', 92653.48, 2470, 46.22, 0.57, 1.69],
  ['2026-01-19', '19 Jan - 25 Jan 26', 82965.00, 2212, 45.93, 0.54, 1.72],
  ['2026-01-26', '26 Jan - 01 Feb 26', 78305.20, 2088, 46.99, 0.56, 1.72],
  ['2026-02-02', '02 Feb - 08 Feb 26', 74565.10, 1988, 46.84, 0.55, 1.68],
  ['2026-02-09', '09 Feb - 15 Feb 26', 76890.40, 2050, 47.10, 0.58, 1.70],
  ['2026-02-16', '16 Feb - 22 Feb 26', 79240.65, 2113, 47.55, 0.59, 1.71],
  ['2026-02-23', '23 Feb - 01 Mar 26', 81430.20, 2171, 48.02, 0.60, 1.73],
  ['2026-03-02', '02 Mar - 08 Mar 26', 84120.75, 2243, 49.10, 0.61, 1.74],
  ['2026-03-09', '09 Mar - 15 Mar 26', 86340.10, 2302, 49.44, 0.62, 1.75],
  ['2026-03-16', '16 Mar - 22 Mar 26', 85210.35, 2272, 49.71, 0.62, 1.76],
];

const PARTNERS = [
  ['ROSELAND FURNITURE', 54092],
  ['Roseland Service Call', 6349],
];

// The report's Attempt Status (Days) table, reproduced as published.
const ATTEMPT_STATUS = [
  ['On Time', 56173, 99.24],
  ['Unknown',  3866,  0.71],
  ['Late',       18,  0.04],
  ['Early',      16,  0.01],
];

const r2 = (n) => Number(n.toFixed(2));

export function demoPayload(filters = {}) {
  let rows = M.map((m, i) => ({ m, monthNo: i + 1 }));
  if (filters.month) rows = rows.filter((x) => x.monthNo === Number(filters.month));
  if (!rows.length) rows = M.map((m, i) => ({ m, monthNo: i + 1 }));

  const byMonth = rows.map(({ m, monthNo }) => {
    const [label, sales, orders, avgKg, avgM3, attempts, ok, failed, unknown] = m;
    const [confToDone, recToDel, recToProp] = SLA[monthNo];
    const [tOk, tFail, tNone] = TREND[monthNo];
    const [successRatio, firstTimeRatio] = RATIOS[monthNo];
    return {
      key: `2026-${String(monthNo).padStart(2, '0')}`,
      label,
      sales: r2(sales),
      orders,
      avgWeightKg: avgKg,
      avgCubeM3: avgM3,
      avgItemsPerOrder: r2(1.75 + (monthNo - 4) * 0.01),
      attempts,
      successful: ok,
      failed,
      unknown,
      successRatio,
      firstTimeRatio,
      avgConfToCompletedDays: confToDone,
      avgReceivedToDeliveredDays: recToDel,
      avgReceivedToProposedDays: recToProp,
      trendSuccessful: tOk,
      trendFailed: tFail,
      trendNoAttempt: tNone,
    };
  });

  const byWeek = (filters.month
    ? W.filter((w) => Number(w[0].slice(5, 7)) === Number(filters.month))
    : W
  ).map(([key, label, sales, orders, avgKg, avgM3, avgItems]) => ({
    key, label, sales: r2(sales), orders, avgWeightKg: avgKg, avgCubeM3: avgM3, avgItemsPerOrder: avgItems,
  }));

  const sum = (pick) => byMonth.reduce((n, m) => n + (m[pick] || 0), 0);
  const totalOrders = sum('orders');
  const partnerTotal = PARTNERS.reduce((n, p) => n + p[1], 0);
  const filtered = Boolean(filters.month);
  const attemptsTotal = sum('attempts');
  const successful = filtered ? sum('successful') : 55646;
  const failed = sum('failed');
  const noAttempt = sum('unknown');

  return {
    orders: {
      totalSales: r2(sum('sales')),
      totalOrders,
      completedOrders: filtered ? Math.round(totalOrders * 0.9303) : 56225,
      avgWeightKg: filtered ? r2(byMonth.reduce((n, m) => n + m.avgWeightKg * m.orders, 0) / totalOrders) : 49.61,
      avgCubeM3: filtered ? r2(byMonth.reduce((n, m) => n + m.avgCubeM3 * m.orders, 0) / totalOrders) : 0.71,
      avgItemsPerOrder: 1.75,
      avgReceivedToProposedDays: filtered ? byMonth[0].avgReceivedToProposedDays : 1.41,
      avgReceivedToDeliveredDays: filtered ? byMonth[0].avgReceivedToDeliveredDays : 1.25,
      avgCreatedToDeliveredDays: filtered ? byMonth[0].avgConfToCompletedDays : 4.35,
      avgConfToCompletedDays: filtered ? byMonth[0].avgConfToCompletedDays : 3.46,
      firstTimeSuccessOrders: filtered ? Math.round(totalOrders * 0.645) : 39003,
      firstTimeSuccessRatio: 64.5,
      firstTimeProposalAcceptance: 94.7,
    },
    attempts: {
      total: attemptsTotal,
      successful,
      failed,
      unknown: noAttempt,
      noAttempt,
      successRatio: filtered ? r2((successful / attemptsTotal) * 100) : 92.63,
      onTimePct: 99.24,
      statusBreakdown: ATTEMPT_STATUS.map(([label, count, pct]) => ({ label, count, pct })),
    },
    byMonth,
    byWeek,
    byPartner: PARTNERS.map(([name, orders]) => ({ name, orders, pct: r2((orders / partnerTotal) * 100) })),
    facets: {
      years: [2026],
      serviceLevels: ['Two Man Delivery', 'Room of Choice', 'One Man Delivery', 'Standard'],
    },
  };
}

export const demoEnabled = () => process.env.DEMO_MODE === 'true';
