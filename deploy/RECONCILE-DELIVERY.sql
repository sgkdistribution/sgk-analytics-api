-- ===========================================================================
-- SGK ANALYTICS — DELIVERY PERFORMANCE RECONCILIATION
--
-- The Orders & sales page now matches Power BI to the penny. The DELIVERY
-- PERFORMANCE page does not, and this is how we find out why — from the data,
-- not from reading the two screens side by side and guessing.
--
-- START HERE, BECAUSE IT CHANGES WHAT "MATCHING" EVEN MEANS.
--
-- Power BI's own two pages disagree with each other:
--
--     page 1 (Orders & sales)         71,751 orders
--     page 2 (Delivery performance)   67,392 orders
--
-- Same file, same database, same Date = All. A gap of 4,359 orders INSIDE the
-- Power BI report. Page 2 carries two slicers page 1 does not have —
-- "Delivery Attempt" (All) and "OrderTypeName", which reads **Multiple
-- selections**, not All. Somebody has ticked a subset of order types on that
-- page, and everything on it is computed over the smaller set.
--
-- So the portal is not failing to match Power BI. It is matching page 1 and not
-- page 2, and page 2 is a filtered view nobody wrote down. Until we know WHICH
-- order types are ticked, "make them the same" has no single answer — section 2
-- is what tells us.
--
-- The rest of the differences are definitions rather than filters, and they are
-- laid out one per section with every plausible reading computed side by side.
-- Whichever line equals the Power BI figure IS the Power BI definition, and
-- that is what the portal gets changed to.
--
-- SAFETY: every statement is a SELECT. Nothing is created, altered or deleted.
-- ===========================================================================

USE `stream_data_extract_sgk`;

SET @year      = 2026;
SET @from      = CONCAT(@year, '-01-01');
SET @to        = CONCAT(@year + 1, '-01-01');
SET @partner_1 = 'ROSELAND FURNITURE';
SET @partner_2 = 'Roseland Service Call';


-- ===========================================================================
-- 1. WHAT COLUMNS ARE ACTUALLY THERE
--
-- Run this FIRST. Everything below assumes OrderTypeName lives on `orders` and
-- that `stops` carries an attempt-sequence column. If either is somewhere else,
-- this is where you find out, instead of the query failing three sections later.
-- ===========================================================================
SELECT TABLE_NAME AS tbl, COLUMN_NAME AS col, DATA_TYPE AS type
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE()
  AND TABLE_NAME IN ('orders', 'stops')
  AND (COLUMN_NAME LIKE '%Type%' OR COLUMN_NAME LIKE '%Seq%'
       OR COLUMN_NAME LIKE '%Attempt%' OR COLUMN_NAME LIKE '%Time%'
       OR COLUMN_NAME LIKE '%Date%' OR COLUMN_NAME LIKE '%Flag%')
ORDER BY tbl, col;


-- ===========================================================================
-- 2. ★ THE ONE THAT MATTERS ★ — every OrderTypeName, counted
--
-- Page 2 of Power BI shows 67,392 orders. Find the combination of rows below
-- that adds up to 67,392 and you have found exactly what its slicer is set to.
--
-- With that answered, either the slicer goes back to All (page 2 then agrees
-- with page 1 and with the portal), or the portal gets the same restriction
-- applied deliberately and stated on screen. Both are fine. Silently different
-- is not.
-- ===========================================================================
SELECT COALESCE(`OrderTypeName`, '(no type)')                          AS order_type,
       COUNT(*)                                                        AS orders,
       SUM(COALESCE(`OrderStatusCompleteFlag`, 0))                     AS completed,
       ROUND(SUM(`OrderCharges`), 2)                                   AS sales,
       ROUND(100 * COUNT(*) / SUM(COUNT(*)) OVER (), 2)                 AS pct_of_all
FROM `orders`
WHERE `PartnerName` IN (@partner_1, @partner_2)
  AND `OrderDate` >= @from AND `OrderDate` < @to
GROUP BY COALESCE(`OrderTypeName`, '(no type)')
ORDER BY orders DESC;

-- The same, as running totals, so "which combination makes 67,392" is one look
-- rather than mental arithmetic.
SELECT t.order_type, t.orders,
       SUM(t.orders) OVER (ORDER BY t.orders DESC)                     AS running_total,
       (SELECT COUNT(*) FROM `orders`
         WHERE `PartnerName` IN (@partner_1, @partner_2)
           AND `OrderDate` >= @from AND `OrderDate` < @to)
       - SUM(t.orders) OVER (ORDER BY t.orders DESC)                    AS everything_else
FROM (
  SELECT COALESCE(`OrderTypeName`, '(no type)') AS order_type, COUNT(*) AS orders
  FROM `orders`
  WHERE `PartnerName` IN (@partner_1, @partner_2)
    AND `OrderDate` >= @from AND `OrderDate` < @to
  GROUP BY COALESCE(`OrderTypeName`, '(no type)')
) t
ORDER BY t.orders DESC;


-- ===========================================================================
-- 3. TOTAL ATTEMPTS — portal 73,681, Power BI 72,001, a gap of 1,680
--
-- The portal counts a stop if the STOP's own RunDate falls in the year. Power
-- BI may instead be counting a stop if its PARENT ORDER falls in the year —
-- which is a different set at both ends of the year, and different again for
-- orders delivered in January against a December order.
--
-- Whichever line below equals 72,001 is the definition in use.
-- ===========================================================================
SELECT 'A. by the stop RunDate (what the portal does)' AS counting_method,
       COUNT(*)                                        AS attempts,
       SUM(COALESCE(a.`StopStatusCompleteFlag`, 0))    AS successful,
       SUM(COALESCE(a.`StopStatusFailedFlag`, 0))      AS failed
FROM `stops` a
WHERE a.`PartnerName` IN (@partner_1, @partner_2)
  AND a.`RunDate` >= @from AND a.`RunDate` < @to

UNION ALL
SELECT 'B. by the parent ORDER date',
       COUNT(*), SUM(COALESCE(a.`StopStatusCompleteFlag`, 0)), SUM(COALESCE(a.`StopStatusFailedFlag`, 0))
FROM `stops` a
JOIN `orders` o ON o.`OrderID` = a.`OrderID`
WHERE o.`PartnerName` IN (@partner_1, @partner_2)
  AND o.`OrderDate` >= @from AND o.`OrderDate` < @to

UNION ALL
SELECT 'C. parent order date, order types as page 2 has them',
       COUNT(*), SUM(COALESCE(a.`StopStatusCompleteFlag`, 0)), SUM(COALESCE(a.`StopStatusFailedFlag`, 0))
FROM `stops` a
JOIN `orders` o ON o.`OrderID` = a.`OrderID`
WHERE o.`PartnerName` IN (@partner_1, @partner_2)
  AND o.`OrderDate` >= @from AND o.`OrderDate` < @to
  -- ⚠️ EDIT THIS LIST once section 2 has told you what page 2 is set to.
  AND o.`OrderTypeName` IN ('Delivery')

UNION ALL
SELECT 'D. stop RunDate, order types as page 2 has them',
       COUNT(*), SUM(COALESCE(a.`StopStatusCompleteFlag`, 0)), SUM(COALESCE(a.`StopStatusFailedFlag`, 0))
FROM `stops` a
JOIN `orders` o ON o.`OrderID` = a.`OrderID`
WHERE a.`PartnerName` IN (@partner_1, @partner_2)
  AND a.`RunDate` >= @from AND a.`RunDate` < @to
  AND o.`OrderTypeName` IN ('Delivery');


-- ===========================================================================
-- 4. FIRST TIME SUCCESSFUL ORDERS — portal 65,203, Power BI 47,188
--
-- A gap of 18,015 on 71,755. No row filter explains a third of the orders
-- disappearing, so this is a DEFINITION difference, and it is the biggest
-- single disagreement between the two reports.
--
-- The portal's rule: the order had exactly ONE attempt, and that attempt
-- completed. Four other readings are computed below. The one that equals
-- 47,188 is what Power BI means by it.
-- ===========================================================================
SELECT 'A. exactly 1 attempt AND it completed (portal)' AS definition, COUNT(*) AS orders
FROM (
  SELECT o.`OrderID`, COUNT(a.`OrderID`) AS attempts,
         SUM(COALESCE(a.`StopStatusCompleteFlag`, 0)) AS good
  FROM `orders` o
  LEFT JOIN `stops` a ON a.`OrderID` = o.`OrderID`
  WHERE o.`PartnerName` IN (@partner_1, @partner_2)
    AND o.`OrderDate` >= @from AND o.`OrderDate` < @to
  GROUP BY o.`OrderID`
) t WHERE t.attempts = 1 AND t.good = 1

UNION ALL
SELECT 'B. exactly 1 attempt, whatever the outcome', COUNT(*)
FROM (
  SELECT o.`OrderID`, COUNT(a.`OrderID`) AS attempts
  FROM `orders` o
  LEFT JOIN `stops` a ON a.`OrderID` = o.`OrderID`
  WHERE o.`PartnerName` IN (@partner_1, @partner_2)
    AND o.`OrderDate` >= @from AND o.`OrderDate` < @to
  GROUP BY o.`OrderID`
) t WHERE t.attempts = 1

UNION ALL
SELECT 'C. first attempt completed (later attempts ignored)', COUNT(*)
FROM (
  SELECT o.`OrderID`,
         SUBSTRING_INDEX(GROUP_CONCAT(COALESCE(a.`StopStatusCompleteFlag`, 0)
                         ORDER BY a.`RunDate`, a.`StopID`), ',', 1) AS first_outcome
  FROM `orders` o
  JOIN `stops` a ON a.`OrderID` = o.`OrderID`
  WHERE o.`PartnerName` IN (@partner_1, @partner_2)
    AND o.`OrderDate` >= @from AND o.`OrderDate` < @to
  GROUP BY o.`OrderID`
) t WHERE t.first_outcome = '1'

UNION ALL
SELECT 'D. 1 attempt AND completed AND on time', COUNT(*)
FROM (
  SELECT o.`OrderID`, COUNT(a.`OrderID`) AS attempts,
         SUM(COALESCE(a.`StopStatusCompleteFlag`, 0)) AS good,
         SUM(COALESCE(a.`StopTimeOnTimeFlag`, 0))     AS ontime
  FROM `orders` o
  LEFT JOIN `stops` a ON a.`OrderID` = o.`OrderID`
  WHERE o.`PartnerName` IN (@partner_1, @partner_2)
    AND o.`OrderDate` >= @from AND o.`OrderDate` < @to
  GROUP BY o.`OrderID`
) t WHERE t.attempts = 1 AND t.good = 1 AND t.ontime = 1

UNION ALL
SELECT 'E. 1 attempt AND completed, page-2 order types only', COUNT(*)
FROM (
  SELECT o.`OrderID`, COUNT(a.`OrderID`) AS attempts,
         SUM(COALESCE(a.`StopStatusCompleteFlag`, 0)) AS good
  FROM `orders` o
  LEFT JOIN `stops` a ON a.`OrderID` = o.`OrderID`
  WHERE o.`PartnerName` IN (@partner_1, @partner_2)
    AND o.`OrderDate` >= @from AND o.`OrderDate` < @to
    AND o.`OrderTypeName` IN ('Delivery')          -- ⚠️ edit after section 2
  GROUP BY o.`OrderID`
) t WHERE t.attempts = 1 AND t.good = 1;


-- ===========================================================================
-- 5. NO ATTEMPT COUNT — portal 1,771, Power BI 1,252
-- ===========================================================================
SELECT 'A. no stop row at all (portal)' AS definition, COUNT(*) AS orders
FROM `orders` o
WHERE o.`PartnerName` IN (@partner_1, @partner_2)
  AND o.`OrderDate` >= @from AND o.`OrderDate` < @to
  AND NOT EXISTS (SELECT 1 FROM `stops` a WHERE a.`OrderID` = o.`OrderID`)

UNION ALL
SELECT 'B. no stop row, page-2 order types only', COUNT(*)
FROM `orders` o
WHERE o.`PartnerName` IN (@partner_1, @partner_2)
  AND o.`OrderDate` >= @from AND o.`OrderDate` < @to
  AND o.`OrderTypeName` IN ('Delivery')            -- ⚠️ edit after section 2
  AND NOT EXISTS (SELECT 1 FROM `stops` a WHERE a.`OrderID` = o.`OrderID`)

UNION ALL
SELECT 'C. no stop row AND the order is still outstanding', COUNT(*)
FROM `orders` o
WHERE o.`PartnerName` IN (@partner_1, @partner_2)
  AND o.`OrderDate` >= @from AND o.`OrderDate` < @to
  AND COALESCE(o.`OrderStatusCompleteFlag`, 0) = 0
  AND NOT EXISTS (SELECT 1 FROM `stops` a WHERE a.`OrderID` = o.`OrderID`);


-- ===========================================================================
-- 6. THE THREE DURATION CARDS — and why they were never going to agree
--
-- Power BI's SLA table names its columns "(Raw)" and "(EW)". EW is almost
-- certainly EXCLUDING WEEKENDS, which is a different measure from the same
-- column, not a different number for the same one. Its cards also carry
-- different NAMES from the portal's:
--
--     Power BI                       portal
--     Avg Confirmed To Booked 1.38   Avg received to proposed  1.54
--     Avg Booked To Delivered 1.24   Avg received to delivered 1.46
--     Avg Created To Delivered 4.36  Avg conf to completed     3.23
--
-- Note the third pair moves the OPPOSITE WAY from the first two. If both
-- reports were reading the same columns and Power BI were simply excluding
-- weekends, all three of its figures would be lower. One being higher says the
-- third card is reading a DIFFERENT column pair altogether.
--
-- This prints the raw averages of every duration column in the table, in days,
-- so each Power BI card can be matched to the column it is actually built on
-- before anything is renamed or recalculated.
-- ===========================================================================
SELECT `COLUMN_NAME` AS duration_column, `DATA_TYPE` AS stored_as
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'orders'
  AND (`COLUMN_NAME` LIKE '%Time%' OR `COLUMN_NAME` LIKE '%Days%')
ORDER BY `COLUMN_NAME`;

SELECT ROUND(AVG(`OrderTimeConfToBook`)      / 86400, 2) AS conf_to_book_days,
       ROUND(AVG(`OrderTimeBookToCompleted`) / 86400, 2) AS book_to_completed_days,
       ROUND(AVG(`OrderTimeConfToCompleted`) / 86400, 2) AS conf_to_completed_days,
       COUNT(*)                                          AS rows_considered
FROM `orders`
WHERE `PartnerName` IN (@partner_1, @partner_2)
  AND `OrderDate` >= @from AND `OrderDate` < @to;