// ---------------------------------------------------------------------------
// DURATIONS — working out what OrderTimeConfToBook and friends actually are.
//
// THE BUG THIS EXISTS TO FIX: the dashboard showed
//
//     Avg created to delivered   384,329.26 days
//
// which is one thousand and fifty-two years. queries.js carried a comment
// claiming these three columns were "durations the WMS has already worked out
// for us, in days" — that was an assumption written when the schema was first
// read, it was never checked, and it was wrong. The service then labelled the
// raw number "days" and printed it.
//
// WHAT THEY ARE INSTEAD. Two candidates fit the magnitudes:
//
//   SECONDS.  384,329s = 4.4 days, 130,720s = 1.5 days. Both sensible for
//             furniture delivery, and 1.5 days lines up with the 1.3 days
//             Roseland's own Power BI reported for received-to-delivered.
//
//   A MySQL TIME COLUMN. AVG() on a TIME does something genuinely nasty: it
//             converts each value to its HHMMSS *digits* (38:43:29 becomes the
//             integer 384329) and averages those as ordinary base-10 numbers.
//             The result is not a time at all — which is why one of the figures
//             read 249,770.33, i.e. "24:97:70", with 97 minutes and 70 seconds
//             in it. A number that cannot be a time is the giveaway.
//
// SO THIS DOES NOT GUESS. It reads the column's real type out of
// INFORMATION_SCHEMA once, and:
//
//   * a TIME column      -> TIME_TO_SEC(col), which is exact and sidesteps the
//                           HHMMSS trap entirely
//   * a numeric column   -> taken in DURATION_UNIT (default seconds), because
//                           that is what the magnitudes support
//   * anything else      -> reported as unknown rather than rendered as a number
//
// Whatever it concludes travels back in the API response as `durationUnit`, so
// the assumption is visible on screen instead of buried in a comment that nobody
// checks for a year. /analytics/diag/durations shows the raw values under every
// candidate unit so it can be settled in one look.
// ---------------------------------------------------------------------------
import { query } from './db.js';

const SECONDS_PER = { seconds: 1, minutes: 60, hours: 3600, days: 86400 };

/** How to read a numeric duration column. Override with SQL_DURATION_UNIT. */
export function configuredUnit() {
  const u = String(process.env.SQL_DURATION_UNIT || 'seconds').trim().toLowerCase();
  return SECONDS_PER[u] ? u : 'seconds';
}

let typesPromise = null;

/**
 * The real DATA_TYPE of each duration column, read once and remembered.
 *
 * Failure is not fatal: if INFORMATION_SCHEMA cannot be read we fall back to
 * treating them as numeric, which is the common case anyway. A dashboard that
 * loads with one uncertain unit beats a dashboard that does not load.
 */
export function columnTypes(table, columns) {
  if (typesPromise) return typesPromise;
  typesPromise = (async () => {
    try {
      const rows = await query(`
        SELECT COLUMN_NAME AS c, DATA_TYPE AS d
        FROM INFORMATION_SCHEMA.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = :t
      `, { t: table });
      const map = {};
      for (const r of rows) map[String(r.c)] = String(r.d).toLowerCase();
      const picked = {};
      for (const col of columns) picked[col] = map[col] || null;
      console.log('[durations] column types:', JSON.stringify(picked));
      return picked;
    } catch (e) {
      console.warn('[durations] could not read column types, assuming numeric:', e?.message || e);
      return {};
    }
  })();
  return typesPromise;
}

const TIME_TYPES = new Set(['time']);

/**
 * The SQL that turns one duration column into an average number of SECONDS.
 *
 * `ident` is passed in rather than imported so this file never has to know how
 * queries.js quotes identifiers — one place owns that.
 */
export function avgSecondsExpr(colType, quotedCol, unit = configuredUnit()) {
  if (TIME_TYPES.has(colType)) return `AVG(TIME_TO_SEC(${quotedCol}))`;
  const per = SECONDS_PER[unit] || 1;
  return per === 1 ? `AVG(${quotedCol})` : `AVG(${quotedCol}) * ${per}`;
}

/**
 * The SQL that turns one duration column into a SUM of SECONDS.
 *
 * The rollup needs SUM and COUNT rather than AVG, because an average of averages
 * is not an average — see the note at the top of rollup.js.
 */
export function sumSecondsExpr(colType, quotedCol, unit = configuredUnit()) {
  if (TIME_TYPES.has(colType)) return `SUM(TIME_TO_SEC(${quotedCol}))`;
  const per = SECONDS_PER[unit] || 1;
  return per === 1 ? `SUM(${quotedCol})` : `SUM(${quotedCol}) * ${per}`;
}

/** Seconds -> days, to two decimals. null stays null so the tile shows a dash. */
export function secondsToDays(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return null;
  return Number((Number(sec) / 86400).toFixed(2));
}

/** Seconds -> hours, for durations under a day where "0.06 days" says nothing. */
export function secondsToHours(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return null;
  return Number((Number(sec) / 3600).toFixed(2));
}

/**
 * A short human duration: "4.4 days", "18.5 hours", "42 min".
 *
 * The unit follows the SIZE, because "0.03 days" and "312.00 hours" are both
 * technically right and neither tells you anything.
 */
export function humanDuration(sec) {
  if (sec === null || sec === undefined || Number.isNaN(Number(sec))) return null;
  const s = Math.abs(Number(sec));
  if (s < 90) return `${Math.round(s)} sec`;
  if (s < 5400) return `${(s / 60).toFixed(0)} min`;
  if (s < 172800) return `${(s / 3600).toFixed(1)} hours`;
  return `${(s / 86400).toFixed(1)} days`;
}

/**
 * What the raw averages would mean under each candidate unit.
 *
 * This is the whole diagnostic: put the four readings side by side and the right
 * one is obvious, because only one of them is a believable delivery time.
 */
export function interpretations(rawAvg) {
  if (rawAvg === null || rawAvg === undefined) return null;
  const n = Number(rawAvg);
  return {
    raw: n,
    ifSeconds: `${(n / 86400).toFixed(2)} days`,
    ifMinutes: `${(n / 1440).toFixed(2)} days`,
    ifHours: `${(n / 24).toFixed(2)} days`,
    ifDays: `${n.toFixed(2)} days`,
    ifTimeHHMMSS: hhmmssNote(n),
  };
}

/**
 * If the value were HHMMSS digits from a TIME column, what would it say — and is
 * that even a valid clock reading? An invalid one is strong evidence the number
 * is an average of TIME digits rather than a real duration.
 */
function hhmmssNote(n) {
  const whole = Math.floor(Math.abs(n));
  const ss = whole % 100;
  const mm = Math.floor(whole / 100) % 100;
  const hh = Math.floor(whole / 10000);
  const valid = ss < 60 && mm < 60;
  return `${hh}h ${mm}m ${ss}s${valid ? '' : '  <-- NOT a valid time (minutes/seconds over 59), so this column is being averaged as HHMMSS digits'}`;
}