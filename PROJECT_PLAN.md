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

1. **Purchasing (implemented in 004/006/007; verify live):** supplier editing, draft/print/email preparation, explicit recorded dispatch, original lead/terms snapshots, revised delivery ETAs, partial receipt costs, bill due dates, partial payment recording and computed supplier scorecards. Generated history links existing replenishment movements without duplicate stock. Actual sending occurs in the user's email app; payment recording does not transfer money. See PURCHASING_MRP_GUIDE.md.
2. **Sales orders (implemented in migration 005; live verification pending):** Lifecycle: Order Placed → Fulfilled → Closed, or Order Placed → Cancelled. Store customer, pickup location, required UTC date, confirmed lines and quoted prices/discount/tax. Orders record demand without hard reservations: POS, transfers and adjustments may use the same physical stock. All-or-nothing fulfillment rechecks and locks stock, creates one linked sale at quoted prices and current weighted costs, and updates the existing movement ledger and reports. Closing and cancellation never create another financial event. Partial fulfillment and post-fulfillment cancellation are not supported; use the future returns module for completed sales. See README for the MRP/customer interface.
3. **Returns/exchanges:** link to original receipt lines; cumulative returned quantity cannot exceed sold quantity. Reverse the allocated original net revenue, applicable tax, and original unit cost. Good stock returns to saleable inventory; failed quality goes to a quarantine/damaged location or explicit write-off with a reason. An exchange combines a linked return and a new sale, recording the net payment/refund. Extend P&L and turnover accordingly.
4. **Production:** issue a build to consume BOM components at their current average costs. Record started, good completed, scrap/rework quantities, reason codes, start and finish time. Receive only good finished units, with an explicit policy for allocating normal scrap cost and expensing abnormal loss. Record work in progress to preserve value between issue and completion. Selling a prebuilt kit consumes finished stock; it must not consume the BOM a second time. Suggested metrics: first-pass yield, scrap rate, and elapsed build time per good unit. Show order history over a date range.
5. **MRP (implemented in 006; verify live):** chronological four-week planning from confirmed orders, finished-stock allocation before BOM explosion, component/build lead times, location-specific stock and timely PO netting, buy/make quantities, late warnings and PO draft preparation. Production owner: replace mrp_firm_build_supply with active issued builds whose components are already deducted, excluding completed output and unissued suggestions. See the integration contract in PURCHASING_MRP_GUIDE.md.
6. **Reorder/EOQ (implemented in 006; verify live):** trailing six-month plus today's sales, kit-implied component usage counted once, current unit holding costs, editable ordering/holding settings, safety stock, review intervals, lead-time reorder points, target/EOQ suggestions and auditable manual decisions. Live Inventory thresholds prefer the calculated values.
7. **Supplier scorecard (implemented in 006/007; verify live):** on-time delivery including overdue incomplete orders, weighted actual/quoted lead, eligible fill rate, owed/overdue amounts and per-receipt due dates. Keep/Watch/Replace thresholds and generated-history labels are visible.
8. **Customer portal:** add customer-owned Auth identity mapping and separate RLS policies. Customers may see safe availability/location information and their own pickup orders; they must never see other customers, supplier costs, staff membership, or internal finance. Staff-only access is currently intentional.
9. **Wow feature:** a purchasing action planner that explains shortages, suggested quantities, order-by dates, supplier risk and estimated cash needs using the real MRP/reorder/scorecard calculations. The explanation must trace to stored inputs, not invented recommendations.

## Always check the connected effect

A feature is complete when its database transaction, UI, permissions, report effect and failure handling all work. Do not mark a capability complete merely because its page exists. Do not use static dashboard metrics or fixed supplier ratings. Keep atomic writes on the server, snapshot financial facts, and test failed/duplicate/retried operations.

Use the assignment's full text as the authoritative checklist. This plan summarizes it; it does not replace any requirement.
