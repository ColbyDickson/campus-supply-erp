# Team implementation plan

Deadline: December 2, 11:30 p.m., as stated in the uploaded assignment. The demo is live, lasts ten minutes including questions, has no slides or prepared scenarios, and uses scenarios selected by the instructor. All twelve capabilities are required even though only some will be demonstrated. Each teammate presents at least one feature and should understand the whole workflow.

## Six feature owners

| Person | Owns | Cross-checks |
| --- | --- | --- |
| 1 | Repository coordination, staff roles, customer portal, pickup orders | Person 3's sales flow |
| 2 | Products, locations, barcode scanning, transfers, adjustments, backorders | Person 5's inventory consumption |
| 3 | POS, sales orders, returns and exchanges | Person 6's financial changes |
| 4 | Supplier maintenance, POs, receipts, reorder rules, EOQ, payments, scorecards | Person 2's receiving quantities |
| 5 | BOMs, production, scrap/rework, production reports, MRP | Person 4's purchasing suggestions |
| 6 | Finance, manager reports, purchasing planner wow feature, testing coordination | Person 1's permissions |

Replace person numbers with actual names. Owners review and explain their features; they do not work in six disconnected apps or databases. Each change should be reviewed on a feature branch and pull request before merging. Keep a single shared schema and append numbered SQL migrations.

## Schedule and acceptance criteria

| Target | Deliverable | Evidence |
| --- | --- | --- |
| Nov 9–15 | Merge and connect this foundation; six logins; finish purchasing/receiving | Sale changes stock and reports; second browser sees it; a PO receipt increases stock at its actual cost |
| Nov 16–22 | Sales orders, returns/exchanges, production and MRP | Complete, cancel and return orders; issue and complete a build; show BOM net requirements and order-by dates changing with demand |
| Nov 23–29 | Supplier scorecards, EOQ/reorder settings, customer portal, wow feature | Metrics respond to PO/sales history edits; restricted customer can order pickup without accessing staff tables |
| Nov 30–Dec 1 | Verify every capability and practice explaining connections | All acceptance checks pass; actual printed labels scan; six teammates can handle unexpected instructor requests |
| Dec 2 | Final verification and submission | Working deployed app and required course upload before 11:30 p.m. |

## Remaining modules and design decisions

1. **Purchasing:** PO headers, lines, partial receipts, lead-time snapshots, receipt costs, printed documents and order closing are now implemented in migration 004. Sending is simulated. Remaining work includes supplier maintenance, supplier bills/payments and analytics. PO statuses include Order Sent, Received and Closed. Store quoted lead time and price snapshots. Expected receipt date is sent date + quoted lead days. A receipt increases stock at the received cost, records actual date/quantity, and updates weighted average cost. Opening historical replenishments in this starter are explicitly marked as generated receipts; they are not PO history and cannot support supplier scorecards. Generate varied, internally consistent PO/receipt/payment history in the next migration.
2. **Sales orders:** separate reservations from physical stock. Lifecycle: Order Placed → Fulfilled → Closed, or Cancelled. Customer, pickup location, requirement date, lines and confirmed quantities must be stored. Creating an order does not record a second sale or deduct physical stock twice. Fulfillment records the stock/cost/revenue event according to the documented policy.
3. **Returns/exchanges:** link to original receipt lines; cumulative returned quantity cannot exceed sold quantity. Reverse the allocated original net revenue, applicable tax, and original unit cost. Good stock returns to saleable inventory; failed quality goes to a quarantine/damaged location or explicit write-off with a reason. An exchange combines a linked return and a new sale, recording the net payment/refund. Extend P&L and turnover accordingly.
4. **Production:** issue a build to consume BOM components at their current average costs. Record started, good completed, scrap/rework quantities, reason codes, start and finish time. Receive only good finished units, with an explicit policy for allocating normal scrap cost and expensing abnormal loss. Record work in progress to preserve value between issue and completion. Selling a prebuilt kit consumes finished stock; it must not consume the BOM a second time. Suggested metrics: first-pass yield, scrap rate, and elapsed build time per good unit. Show order history over a date range.
5. **MRP:** weekly next-four-weeks demand comes from confirmed, unfulfilled sales orders. Net finished stock/reservations and scheduled builds before exploding only the required builds through the BOM. Gross component requirement = planned parent builds × component quantities. Net by location and week against available on-hand and open PO quantities arriving by the requirement date, carry supply forward only once, and expose lateness. Suggested quantity is max(0, remaining deficit). Order-by date = requirement date − component lead time; distinguish buy components from make kits.
6. **Reorder/EOQ:** compute average daily usage from at least six months of history, including BOM consumption from kit sales/builds without double counting. Reorder point = lead-time demand + documented safety stock. Support periodic manual review. Annual demand D = average daily usage × 365; EOQ = sqrt(2 × D × ordering cost / annual unit holding cost). Annual unit holding cost = unit cost × editable annual holding rate. Store editable ordering cost and holding settings; handle zero demand/cost with an explicit unavailable result rather than dividing by zero. Starter reorder points are initial stored settings, not yet lead-time-demand calculations.
7. **Supplier scorecard:** compute on-time delivery, actual versus quoted lead time, fill rate and unpaid amounts/due dates from PO, receipt and payment history. Count eligible orders/quantities explicitly; incomplete overdue orders must not quietly disappear. Label unavailable measures when there is no history. Document thresholds behind Keep / Watch / Replace so the overall rating is reproducible, and display all measures together for each supplier.
8. **Customer portal:** add customer-owned Auth identity mapping and separate RLS policies. Customers may see safe availability/location information and their own pickup orders; they must never see other customers, supplier costs, staff membership, or internal finance. Staff-only access is currently intentional.
9. **Wow feature:** a purchasing action planner that explains shortages, suggested quantities, order-by dates, supplier risk and estimated cash needs using the real MRP/reorder/scorecard calculations. The explanation must trace to stored inputs, not invented recommendations.

## Always check the connected effect

A feature is complete when its database transaction, UI, permissions, report effect and failure handling all work. Do not mark a capability complete merely because its page exists. Do not use static dashboard metrics or fixed supplier ratings. Keep atomic writes on the server, snapshot financial facts, and test failed/duplicate/retried operations.

Use the assignment's full text as the authoritative checklist. This plan summarizes it; it does not replace any requirement.
