// ---------------------------------------------------------------------------
// SQL SERVER — one shared, read-only pool.
//
// The WMS database is a production system that the warehouse depends on. This
// service is a guest in it and behaves like one:
//   * ONE pool, reused. Never a connection per request.
//   * READ ONLY. There is no insert/update/delete path anywhere in this repo,
//     and the SQL login it uses should be granted db_datareader and nothing
//     more. If someone ever finds a way to inject, the worst they can do is
//     read — and even that is fenced by the company filter.
//   * Every value is a bound PARAMETER. Nothing from a browser is ever
//     concatenated into a query string.
//   * Statement timeout, so a heavy query can never pin a WMS connection.
// ---------------------------------------------------------------------------
import sql from 'mssql';

let poolPromise = null;

export function sqlConfigured() {
  return Boolean(process.env.SQL_SERVER && process.env.SQL_DATABASE && process.env.SQL_USER);
}

export async function getPool() {
  if (!sqlConfigured()) throw new Error('SQL Server is not configured — set SQL_SERVER, SQL_DATABASE, SQL_USER, SQL_PASSWORD.');
  if (poolPromise) return poolPromise;

  const config = {
    server: process.env.SQL_SERVER,
    database: process.env.SQL_DATABASE,
    user: process.env.SQL_USER,
    password: process.env.SQL_PASSWORD,
    port: Number(process.env.SQL_PORT || 1433),
    options: {
      encrypt: process.env.SQL_ENCRYPT !== 'false',            // Azure SQL needs this on
      trustServerCertificate: process.env.SQL_TRUST_CERT === 'true',
      enableArithAbort: true,
    },
    pool: { max: Number(process.env.SQL_POOL_MAX || 6), min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: Number(process.env.SQL_TIMEOUT_MS || 20000),
    connectionTimeout: 15000,
  };

  poolPromise = new sql.ConnectionPool(config).connect()
    .then((pool) => {
      console.log('[db] connected to', config.server, '/', config.database);
      pool.on('error', (e) => { console.error('[db] pool error:', e?.message || e); poolPromise = null; });
      return pool;
    })
    .catch((e) => {
      poolPromise = null;                                       // let the next request retry
      throw e;
    });

  return poolPromise;
}

// Run a parameterised read. params is a plain object: { year: 2026, key: 'RSL' }.
export async function query(text, params = {}) {
  const pool = await getPool();
  const req = pool.request();
  for (const [name, value] of Object.entries(params)) req.input(name, value);
  const result = await req.query(text);
  return result.recordset || [];
}

export { sql };
