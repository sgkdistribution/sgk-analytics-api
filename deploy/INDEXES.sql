-- ===========================================================================
-- SGK ANALYTICS — INDEXES FOR stream_data_extract_sgk
--
-- SEND THIS TO GO2STREAM (support@go2stream.com). The analytics service logs in
-- with a SELECT-only user, so it cannot create these itself — and that is the
-- right way round: this service is a guest in a database the business depends on.
--
-- WHY IT MATTERS MORE THAN THE CODE CHANGES
--
-- The service used to filter with YEAR(OrderDate) = 2026, which no index can
-- ever satisfy — MySQL had to read every row and compute YEAR() on each one.
-- That is now a plain range (>= '2026-01-01' AND < '2027-01-01'), which CAN use
-- an index. But a range that can use an index and a table with no index on that
-- column still ends in a full scan. These two things only pay off together.
--
-- Expected effect: the dashboard's nine reads go from scanning the whole orders
-- and stops tables to reading only the rows for one client in one date range.
--
-- SAFETY
--   * Every statement below is ADD INDEX. Nothing alters a column, a row, or a
--     constraint. No data is touched.
--   * On MySQL 5.6+/InnoDB these are ONLINE operations: reads and writes carry
--     on while they build. They still cost disk and IO, so run them off-peak.
--   * If an index already exists under another name MySQL will say so and the
--     statement is a no-op worth nothing but the error message. Run the audit at
--     the bottom FIRST to see what is already there.
-- ===========================================================================


-- ---------------------------------------------------------------------------
-- 1. orders — the main filter is (client, date)
--
-- COLUMN ORDER IS THE WHOLE POINT: PartnerName first because it is matched with
-- equality (IN), OrderDate second because it is matched as a RANGE. An index can
-- use every equality column it meets and then ONE range column, and nothing
-- after that range. (OrderDate, PartnerName) would be near useless for this
-- query — same two columns, wrong way round.
-- ---------------------------------------------------------------------------
ALTER TABLE `orders`
  ADD INDEX `ix_orders_partner_date` (`PartnerName`, `OrderDate`);


-- ---------------------------------------------------------------------------
-- 2. orders — the service-level filter, when a client picks one
--
-- Only worth adding if the Service Level dropdown is actually used. Skip it if
-- you would rather keep the write cost down; the index above carries most of it.
-- ---------------------------------------------------------------------------
ALTER TABLE `orders`
  ADD INDEX `ix_orders_partner_service_date` (`PartnerName`, `ServiceLevelName`, `OrderDate`);


-- ---------------------------------------------------------------------------
-- 3. stops — attempts are filtered the same way (client, run date)
-- ---------------------------------------------------------------------------
ALTER TABLE `stops`
  ADD INDEX `ix_stops_partner_rundate` (`PartnerName`, `RunDate`);


-- ---------------------------------------------------------------------------
-- 4. stops — the join and the NOT EXISTS
--
-- Two queries need to find a stop BY ORDER: the first-time-success calculation
-- (stops joined to orders) and "orders nobody has been out to yet"
-- (NOT EXISTS (SELECT 1 FROM stops WHERE stops.OrderID = orders.OrderID)).
--
-- Without this, both do a full scan of stops for EVERY order considered, which is
-- the worst shape in the whole dashboard.
-- ---------------------------------------------------------------------------
ALTER TABLE `stops`
  ADD INDEX `ix_stops_orderid` (`OrderID`);


-- ===========================================================================
-- AUDIT — run these FIRST, and again afterwards to confirm
-- ===========================================================================

-- What indexes exist today?
SELECT TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX, COLUMN_NAME, NON_UNIQUE
FROM INFORMATION_SCHEMA.STATISTICS
WHERE TABLE_SCHEMA = 'stream_data_extract_sgk'
  AND TABLE_NAME IN ('orders', 'stops')
ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX;

-- How big are the tables? (tells you how long the ALTERs will take)
SELECT TABLE_NAME, TABLE_ROWS, ROUND(DATA_LENGTH/1024/1024) AS data_mb, ROUND(INDEX_LENGTH/1024/1024) AS index_mb
FROM INFORMATION_SCHEMA.TABLES
WHERE TABLE_SCHEMA = 'stream_data_extract_sgk'
  AND TABLE_NAME IN ('orders', 'stops');


-- ===========================================================================
-- PROVING IT WORKED
--
-- Run this BEFORE and AFTER. Substitute a real PartnerName.
--
-- BEFORE you expect:  type = ALL, key = NULL, rows = the whole table
-- AFTER you expect:   type = range, key = ix_orders_partner_date, rows = a
--                     small fraction
--
-- If `key` is still NULL afterwards, the index is not being chosen — send the
-- EXPLAIN output back rather than guessing.
-- ===========================================================================
EXPLAIN
SELECT SUM(`OrderCharges`) AS totalSales, COUNT(DISTINCT `OrderID`) AS totalOrders
FROM `orders`
WHERE `PartnerName` IN ('ROSELAND FURNITURE')
  AND `OrderDate` >= '2026-01-01'
  AND `OrderDate` <  '2027-01-01'
  AND `OrderStatusName` NOT IN ('Cancelled');

EXPLAIN
SELECT COUNT(*) AS total
FROM `stops` a
WHERE a.`PartnerName` IN ('ROSELAND FURNITURE')
  AND a.`RunDate` >= '2026-01-01'
  AND a.`RunDate` <  '2027-01-01';