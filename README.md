# SGK Analytics API

Live figures from the Go2Stream WMS extract (MySQL), served to the portal dashboards.
Read-only. One endpoint. Per-company isolation enforced on the server.

## What it is for

The dashboards used to be Power BI reports pointed at the WMS database. This
service replaces the middle of that: the portal asks it for a company's numbers,
it queries MySQL, and it returns JSON the portal draws itself.

## Endpoints

    GET /health
    GET /analytics/companies                    (SGK staff — the list they may switch between)
    GET /analytics/overview?year=&month=&from=&to=&service=[&company=]

Every request must carry the caller's Cognito ID token:

    Authorization: Bearer <token>

## How one client is kept out of another's data

Three things, in order, on every single request:

1. **The token is verified**, not trusted. Its signature is checked against the
   Cognito user pool's public keys, so it cannot be forged or edited.
2. **The company is chosen by the server**, from the verified email, using
   `CLIENT_MAP`. The request does not get a vote. A Roseland account asking for
   `?company=bedroomking` still receives Roseland's figures.
3. **The company key is bound into every query.** There is no code path that
   reads the orders or attempts tables without the client filter attached.

`?company=` is honoured only for SGK staff (matched on `SGK_DOMAINS`,
`SGK_EMAILS`, or a Cognito group named in `SGK_GROUP`).

## Setting it up

1. `npm install`
2. Copy `.env.example` to `.env` and fill it in — **or set the same variables in
   Railway, which is where the real ones belong.** Never commit them.
3. Create a dedicated MySQL user for this service and grant it `SELECT` on this
   one database and nothing else. It has no reason to be able to write, so it
   should not be able to.
4. `npm run discover` — prints the tables, columns and status values it can see.
   No order data, no customers, no prices, no password. Send that output on and
   the SQL mapping in `queries.js` gets finished against your real schema.
5. `npm start`

## Files

    server.js     HTTP, caching, the response the portal consumes
    auth.js       Cognito token verification
    clients.js    email -> company -> WMS key (the isolation map)
    db.js         the read-only MySQL pool
    queries.js    THE ONLY FILE THAT KNOWS YOUR SCHEMA — edit this one
    discover.js   prints your schema so queries.js can be finished

## Load

Identical queries are reused for `CACHE_TTL_MS` (45s by default), so a room full
of people watching the same dashboard is one query, not twenty. The pool is
capped at `SQL_POOL_MAX` (6) and every statement times out, so this service
cannot pin connections the warehouse needs.
