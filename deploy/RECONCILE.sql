-- ===========================================================================
-- SGK ANALYTICS — PORTAL vs POWER BI RECONCILIATION
--
-- Paste this into MySQL Workbench against stream_data_extract_sgk and run it
-- beside the Power BI report. It answers one question: when the two disagree,
-- WHICH rows are different and WHY.
--
-- WHAT WENT WRONG, so the shape of the answer makes sense.
--
-- The portal's analytics service carried a setting that removed cancelled
-- orders from every figure. Power BI reads the same table with no such filter.
-- Two reports, one database, different row populations — so every number
-- disagreed slightly, in every month, permanently. On Roseland's 2026 that was
-- 1,597 orders and £2,118.60 of sales.
--
-- There was a second fault in the same line. The filter read
--   OrderStatus NOT IN ('Cancelled')
-- and in SQL `NULL NOT IN (...)` is not TRUE, it is NULL — which WHERE treats
-- as false. So orders with NO status at all were silently dropped too. Query 4
-- below is the one that shows those.
--
-- Both are fixed in the service. This script is how you CHECK it, now and any
-- time the two reports are ever questioned again.
--
-- BEFORE YOU RUN IT: set the two variables in section 0 to the client and year
-- you are checking. Everything else follows from them.
--
-- SAFETY: every statement here is a SELECT. Nothing is created, altered or
-- deleted, and the analytics login only has SELECT anyway.
-- ===========================================================================

USE `stream_data_extract_sgk`;

-- ---------------------------------------------------------------------------
-- 0. WHAT YOU ARE CHECKING
--
-- The partner list must match the client's CLIENT_MAP `sqlKey` on the analytics
-- service EXACTLY. A client with two partner names (Roseland has two, Hygge
-- Pergola has two) and only one of them listed here will look like a shortfall
-- that has nothing to do with any of this.
-- ---------------------------------------------------------------------------
SET @year        = 2026;
SET @from        = CONCAT(@year, '-01-01');
SET @to          = CONCAT(@year + 1, '-01-01');
SET @partner_1   = 'ROSELAND FURNITURE';
SET @partner_2   = 'Roseland Service Call';      -- repeat @partner_1 if there is only one


-- ===========================================================================
-- 1. THE HEADLINE — the three readings side by side
--
-- A is what Power BI shows. B is what the portal used to show. C is what the
-- portal shows now.
--
-- IF A AND C ARE EQUAL, THE FIX IS IN and the two reports agree.
-- If B is what you can still see on the portal, the old build is still running
-- (or SQL_ORDERS_EXCLUDE_STATUSES is set in /etc/sgk-analytics.env).
-- ===========================================================================
SELECT 'A. Power BI — every row'                   AS reading,
       COUNT(*)                                    AS orders,
       ROUND(SUM(`OrderCharges`), 2)               AS sales
FROM `orders`
WHERE `PartnerName` IN (@partner_1, @partner_2)
  AND `OrderDate` >= @from AND `OrderDate` < @to

UNION ALL
SELECT 'B. Portal, OLD build (the bug)',
       COUNT(*), ROUND(SUM(`OrderCharges`), 2)
FROM `orders`
WHERE `PartnerName` IN (@partner_1, @partner_2)
  AND `OrderDate` >= @from AND `OrderDate` < @to
  AND `OrderStatus` NOT IN ('Cancelled')

UNION ALL
SELECT 'C. Portal, FIXED build',
       COUNT(*), ROUND(SUM(`OrderCharges`), 2)
FROM `orders`
WHERE `PartnerName` IN (@partner_1, @partner_2)
  AND `OrderDate` >= @from AND `OrderDate` < @to;


-- ===========================================================================
-- 2. WHERE THE MISSING ORDERS WENT — every status, counted and totalled
--
-- The row marked DROPPED is the entire difference between A and B above. If it
-- does not account for all of it, something else is going on and it will be
-- visible here rather than having to be hunted.
-- ===========================================================================
SELECT COALESCE(`OrderStatus`, '(no status — the NULL bug)') AS order_status,
       CASE WHEN `OrderStatus` <=> NULL THEN 'DROPPED by the old build'
            WHEN `OrderStatus` = 'Cancelled' THEN 'DROPPED by the old build'
            ELSE 'counted by both' END                       AS old_build,
       COUNT(*)                                              AS orders,
       ROUND(SUM(`OrderCharges`), 2)                         AS sales
FROM `orders`
WHERE `PartnerName` IN (@partner_1, @partner_2)
  AND `OrderDate` >= @from AND `OrderDate` < @to
GROUP BY COALESCE(`OrderStatus`, '(no status — the NULL bug)'),
         CASE WHEN `OrderStatus` <=> NULL THEN 'DROPPED by the old build'
              WHEN `OrderStatus` = 'Cancelled' THEN 'DROPPED by the old build'
              ELSE 'counted by both' END
ORDER BY orders DESC;


-- ===========================================================================
-- 3. MONTH BY MONTH — put this next to the Power BI "Monthly Summary" panel
--
-- `power_bi_sales` and `power_bi_orders` are what that panel should read.
-- `old_build_*` is what the portal was showing. The last two columns are the
-- per-month gap, which is the thing that was visible on screen as "£356,683.18
-- vs £356,584.18".
-- ===========================================================================
SELECT DATE_FORMAT(`OrderDate`, '%b-%y')                                   AS month,
       COUNT(*)                                                            AS power_bi_orders,
       ROUND(SUM(`OrderCharges`), 2)                                       AS power_bi_sales,
       SUM(CASE WHEN `OrderStatus` NOT IN ('Cancelled') THEN 1 ELSE 0 END) AS old_build_orders,
       ROUND(SUM(CASE WHEN `OrderStatus` NOT IN ('Cancelled')
                      THEN `OrderCharges` ELSE 0 END), 2)                  AS old_build_sales,
       COUNT(*) - SUM(CASE WHEN `OrderStatus` NOT IN ('Cancelled') THEN 1 ELSE 0 END)
                                                                           AS orders_missing,
       ROUND(SUM(`OrderCharges`)
             - SUM(CASE WHEN `OrderStatus` NOT IN ('Cancelled')
                        THEN `OrderCharges` ELSE 0 END), 2)                AS sales_missing
FROM `orders`
WHERE `PartnerName` IN (@partner_1, @partner_2)
  AND `OrderDate` >= @from AND `OrderDate` < @to
GROUP BY YEAR(`OrderDate`), MONTH(`OrderDate`), DATE_FORMAT(`OrderDate`, '%b-%y')
ORDER BY YEAR(`OrderDate`), MONTH(`OrderDate`);


-- ===========================================================================
-- 4. THE NULL-STATUS ROWS — the second bug, on its own
--
-- These are real orders with real money against them that the old build threw
-- away for no reason anybody chose. If this returns 0 the fault never bit here,
-- but the clause was still wrong and would have bitten the first time Go2Stream
-- shipped a row with a blank status.
-- ===========================================================================
SELECT COUNT(*)                      AS orders_with_no_status,
       ROUND(SUM(`OrderCharges`), 2) AS their_sales
FROM `orders`
WHERE `PartnerName` IN (@partner_1, @partner_2)
  AND `OrderDate` >= @from AND `OrderDate` < @to
  AND `OrderStatus` IS NULL;


-- ===========================================================================
-- 5. THE PIE — "Orders by account" vs Power BI's "Count of Order Number"
--
-- ⚠️ READ THE LAST TWO COLUMNS BEFORE CONCLUDING ANYTHING.
--
-- Power BI's pie is "Count of Order Number" and its monthly panel is "Count of
-- OrderItemsCount". NEITHER of those is a count of rows — both skip rows where
-- that ONE field happens to be blank. The portal counts orders.
--
-- So if `power_bi_would_count` is lower than `orders`, Power BI is the one
-- under-counting, by exactly that many, and no change to the portal will ever
-- close that gap. That is a Power BI measure to change (COUNTROWS, not COUNT of
-- a column), not a portal fault.
-- ===========================================================================
SELECT `PartnerName`                    AS partner,
       COUNT(*)                         AS orders,
       COUNT(DISTINCT `OrderID`)        AS distinct_order_ids,
       COUNT(`OrderNumber`)             AS power_bi_would_count,
       COUNT(`OrderItemsCount`)         AS power_bi_monthly_would_count
FROM `orders`
WHERE `PartnerName` IN (@partner_1, @partner_2)
  AND `OrderDate` >= @from AND `OrderDate` < @to
GROUP BY `PartnerName`
ORDER BY orders DESC;


-- ===========================================================================
-- 6. IS THE PORTAL LOOKING AT THE SAME YEARS AS POWER BI?
--
-- Worth thirty seconds when two reports disagree. The portal filters to one
-- year from the dropdown; a Power BI file with its Date slicer on "All" covers
-- whatever is in the table. If this returns more than one year, that difference
-- is real and has nothing to do with statuses.
-- ===========================================================================
SELECT YEAR(`OrderDate`)               AS year,
       COUNT(*)                        AS orders,
       ROUND(SUM(`OrderCharges`), 2)   AS sales,
       MIN(`OrderDate`)                AS earliest,
       MAX(`OrderDate`)                AS latest
FROM `orders`
WHERE `PartnerName` IN (@partner_1, @partner_2)
GROUP BY YEAR(`OrderDate`)
ORDER BY year;


-- ===========================================================================
-- 7. EVERY PARTNER NAME IN THE EXTRACT
--
-- Run this when onboarding a client, to get their `sqlKey` right first time. A
-- client whose second partner name is missing from CLIENT_MAP sees a dashboard
-- that is quietly short by that whole account.
-- ===========================================================================
SELECT `PartnerName`                  AS partner_name,
       COUNT(*)                       AS orders,
       MIN(`OrderDate`)               AS first_order,
       MAX(`OrderDate`)               AS last_order
FROM `orders`
WHERE `PartnerName` IS NOT NULL AND `PartnerName` <> ''
GROUP BY `PartnerName`
ORDER BY orders DESC;