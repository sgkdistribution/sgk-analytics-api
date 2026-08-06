// ---------------------------------------------------------------------------
// MySQL — one shared, read-only pool.
//
// (This service was first written against SQL Server. The database turned out
// to be MySQL on 3306, so the driver and the dialect are MySQL throughout. The
// environment variable NAMES were deliberately left alone — SQL_SERVER,
// SQL_DATABASE and the whole SQL_ORDERS_* / SQL_ATTEMPTS_* mapping — so nothing
// already set on Railway has to be typed again.)
//
// The extract database is something the business depends on. This service is a
// guest in it and behaves like one:
//   * ONE pool, reused. Never a connection per request.
//   * READ ONLY. There is no insert/update/delete anywhere in this repo, and
//     the MySQL user should be granted SELECT and nothing more.
//   * Every value is a bound PARAMETER. Nothing from a browser is ever
//     concatenated into a query.
//   * Statement timeout, so one heavy query cannot pin a connection.
// ---------------------------------------------------------------------------
import fs from 'node:fs';
import mysql from 'mysql2/promise';

let pool = null;

// Read a certificate file if one is configured. Missing or unreadable is loud
// rather than silent — a connection that quietly falls back to plain text is
// worse than one that refuses to start.
function readPem(envKey) {
  const path = process.env[envKey];
  if (!path) return null;
  try {
    return fs.readFileSync(path);
  } catch (e) {
    throw new Error(`${envKey} points at ${path} but it could not be read: ${e.message}`);
  }
}

// Mutual TLS with Cloud SQL, if the three files are configured.
//
// A note on hostname checking. Cloud SQL server certificates carry the INSTANCE
// name, not the IP address we dial, so Node's default hostname match can never
// succeed here. The chain check is the one that matters and it stays on: this CA
// is issued per instance, so a certificate that chains to it can only have come
// from this database. Skipping the name match while verifying the chain is the
// documented way to connect to Cloud SQL by IP.
function sslOptions() {
  const ca = readPem('SQL_SSL_CA');
  const cert = readPem('SQL_SSL_CERT');
  const key = readPem('SQL_SSL_KEY');

  if (ca && cert && key) {
    return {
      ca, cert, key,
      rejectUnauthorized: true,
      checkServerIdentity: () => undefined,
    };
  }
  if (ca || cert || key) {
    throw new Error('SSL is half configured — SQL_SSL_CA, SQL_SSL_CERT and SQL_SSL_KEY must all be set, or none of them.');
  }
  // No certificates supplied: encrypt anyway unless explicitly told not to.
  return process.env.SQL_ENCRYPT === 'false'
    ? undefined
    : { rejectUnauthorized: process.env.SQL_TRUST_CERT !== 'true' };
}

// People paste "host:port" — it is how connection details are always written
// down. Split it rather than failing with an unreadable DNS error.
function hostAndPort() {
  const raw = String(process.env.SQL_SERVER || '').trim().replace(/^\w+:\/\//, '');
  const m = /^(.+?):(\d+)$/.exec(raw);
  if (m) return { host: m[1], port: Number(m[2]) };
  return { host: raw, port: Number(process.env.SQL_PORT || 3306) };
}

export function sqlConfigured() {
  return Boolean(process.env.SQL_SERVER && process.env.SQL_DATABASE && process.env.SQL_USER);
}

export function getPool() {
  if (!sqlConfigured()) throw new Error('MySQL is not configured — set SQL_SERVER, SQL_DATABASE, SQL_USER, SQL_PASSWORD.');
  if (pool) return pool;

  const { host, port } = hostAndPort();
  pool = mysql.createPool({
    host,
    port,
    database: process.env.SQL_DATABASE,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    // The connection crosses the public internet, so it is encrypted, and with
    // the Cloud SQL client certificates it is mutually authenticated too.
    ssl: sslOptions(),
    connectionLimit: Number(process.env.SQL_POOL_MAX || 6),
    waitForConnections: true,
    connectTimeout: 15000,
    namedPlaceholders: true,        // lets queries use :name instead of ?
    dateStrings: false,
    decimalNumbers: true,
    timezone: 'Z',
  });

  const mtls = Boolean(process.env.SQL_SSL_CA && process.env.SQL_SSL_CERT && process.env.SQL_SSL_KEY);
  console.log('[db] pool ready for', `${host}:${port}`, '/', process.env.SQL_DATABASE,
    mtls ? '(TLS, client certificate)' : (process.env.SQL_ENCRYPT === 'false' ? '(NOT encrypted)' : '(TLS)'));
  return pool;
}

// Run a parameterised read. params is a plain object: { year: 2026, clientKey: 'RSL' }.
export async function query(text, params = {}) {
  const conn = await getPool().getConnection();
  try {
    await conn.query({ sql: `SET SESSION MAX_EXECUTION_TIME=${Number(process.env.SQL_TIMEOUT_MS || 20000)}` }).catch(() => {});
    const [rows] = await conn.query({ sql: text, timeout: Number(process.env.SQL_TIMEOUT_MS || 20000) }, params);
    return Array.isArray(rows) ? rows : [];
  } finally {
    conn.release();
  }
}

// Cheap liveness check for /health.
export async function ping() {
  const rows = await query('SELECT 1 AS ok');
  return rows.length > 0;
}