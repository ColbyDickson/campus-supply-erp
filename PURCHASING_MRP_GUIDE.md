# Purchasing, suppliers and MRP

This update implements assignment capabilities 7 and 8 on top of the existing inventory, POS and sales-order records. It also adds calculated procurement reports. The live Supabase and physical scanner checks below must be completed before marking the features demonstrated.

## Install in the existing shared project

The project coordinator has already applied 001–005. Preserve those files and the shared data.

1. Review and merge the purchasing/MRP pull request into `main`.
2. In Supabase SQL Editor, run [006_supplier_planning_mrp.sql](supabase/006_supplier_planning_mrp.sql) **once**, in a new query. It adds fields, policies, tables and database functions. It does not reset or reseed stock or sales.
3. Run [007_supplier_history.sql](supabase/007_supplier_history.sql), in another new query. It links the original generated historical replenishments to varied sample PO, receipt and payment records. It does **not** receive the inventory again. A marker prevents duplicate imports if 007 is repeated.
4. Wait for GitHub Pages to finish deploying `main /docs`, then hard-refresh the website. Purchasing has three sections; MRP has its own navigation item.

If the update is missing, Purchasing/MRP displays setup guidance. Existing POS and sales orders keep working. If a SQL query reports an error, retain the exact message; do not rerun older setup/seed scripts or reset the database. Applying 006 again is not supported. New installations should apply 001, 002, create/enroll staff as in README, then 004, 005, 006 and 007.

## Purchase and receive

1. **Purchasing → Purchase orders → New purchase order.** Choose a supplier and delivery location. Enter quantities and negotiated unit costs. Save the draft. Drafts are excluded from incoming supply and performance ratings.
2. Use **Prepare supplier email** to open a draft in your email app, or **Print PO** to print/save a supplier document. Send/share it yourself. The website does not send mail or confirm delivery. Fictional example supplier addresses will not deliver; use a controlled test address when testing sending.
3. Open **Record dispatch**, choose a method and enter a recipient/reference. Confirm sent. The stored sent date is today in UTC. Expected date = sent date + the supplier's current quoted calendar-day lead time. The lead time and payment terms are snapshotted on this PO.
4. Use **Delivery plan** when the supplier confirms a revised ETA or to assign a location to a legacy PO. The revised planning ETA drives MRP; the original promise stays intact for on-time scoring. A supplier-confirmed future ETA is needed before an overdue PO can count as timely incoming supply.
5. **Receive delivery.** Scan an item barcode or select a line, then enter the actual quantity. Partial receipts are allowed. The new workflow receives into the planned location; change its delivery plan first if the destination changes. The server rejects over-receipts.
6. Receiving increases stock, recalculates weighted average cost and records a movement and receipt bill. All lines received changes status to Received. Close the order when reviewed. Closing does not pay the bills.

Receiving/closing do not create sales revenue. Purchasing stock is capitalized in inventory; its cost reaches P&L when it is sold. Recording a supplier payment changes the purchasing payable balance, not COGS. This class app does not process money or implement a full bank/general ledger.

PO drafts, receipts, payments and review submissions retain their request IDs in browser storage if their network result is uncertain. Use **Retry saved request**; do not recreate the same operation in a new browser. Successful retries return the existing result. Draft request payloads and receipt/payment identities are checked. Dispatch/close are repeat-safe status transitions. Inspect history before clearing browser storage after a lost response.

## Supplier management and payments

**Purchasing → Suppliers & payments** shows each supplier's contact details, current quote/terms, performance, overall rating and balances. Add suppliers or open Details & payments to edit them. The item Policy form assigns purchased items to suppliers. Saving a supplier updates its component items' current lead times; existing sent PO quotes and terms remain fixed. Item Policy can override a particular item's lead time afterward.

Each receipt creates a bill equal to received quantity × PO unit cost. Its due date is receipt UTC date + that PO's snapshotted Net days. The receipt date is the documented invoice-date convention for this class system. Bills show amount, paid, outstanding and due date, including historical partial/unpaid examples. Use Record payment only for a payment made outside the ERP. Enter amount, actual date and reference. Overpayment, future payment dates, and dates before receipt are rejected. Payment history is visible on each bill. Bill pages contain 20 rows; supplier totals always aggregate all records.

Scorecard definitions:

| Measure | Stored-data calculation |
| --- | --- |
| Eligible orders | Sent orders whose original promised date has arrived, or whose full quantity has already been received. Drafts are excluded. |
| On-time delivery | Eligible orders received **in full** by the original expected date ÷ eligible orders. Overdue incomplete orders are failures. |
| Actual lead time | Sum of receipt units × (receipt UTC date − sent UTC date), divided by received units. Partial receipts contribute their actual received units. |
| Quoted historical lead | Weighted quoted lead from those same receipts' PO snapshots. The current editable quote is shown separately. |
| Fill rate | Received units on eligible orders ÷ originally ordered units on those orders. Historical short-shipment cancellations remain in the denominator. |
| Owed / overdue | Receipt bill amounts less recorded payments; overdue uses due dates before today in UTC. Closing an order does not remove debt. |

Rating rules are intentionally transparent: **Keep** requires on-time ≥90%, fill ≥95% and actual lead ≤125% of quoted (minimum 1 day). **Replace** applies if on-time <70%, fill <80% or actual lead >175% of quoted (minimum 2 days). Other eligible records yield **Watch**. No history and Observing signal unavailable/insufficient data. Company payment debt is displayed separately and does not blame the supplier for the company's unpaid bills.

007 creates different reliability and short-shipment patterns for the original six fictional suppliers. Each order is labelled Generated history. It links the same units/costs/timestamps as existing HISTORICAL_RECEIPT movements, so stock quantity, inventory value, sales and P&L do not change. Sample shortfalls are explicitly cancelled when those historical POs are closed. This import excludes finished-kit replenishments because those are preassembled stock, not purchases from a component supplier. The system does not invent real vendor activity or transfer money.

## Reorder, EOQ and periodic manual review

**Purchasing → Reorder & EOQ** uses the trailing six calendar months plus today's recorded sales. It includes calendar days with zero sales. Today's completed sales update the calculations immediately. For components, direct item sales plus single-level BOM quantities implied by kit sales count as usage. Do not also add production consumption: that would count kit usage twice. Returns are not yet integrated into this gross-sales usage measure; coordinate with the returns owner if net demand is required.

- Average daily usage = relevant sold units ÷ calendar days in the displayed window.
- Annual demand D = daily usage × 365.
- Annual unit holding cost H = current weighted average unit cost × stored annual holding rate. If no stock exists, use standard cost.
- Reorder point = ceil(daily usage × item lead days + safety stock).
- Company-wide inventory position = on-hand + outstanding sent PO units.
- EOQ = ceil(sqrt(2 × D × ordering cost / H)). Zero demand or zero unit holding cost displays unavailable, avoiding division by zero.
- When inventory position reaches the reorder point, suggested quantity is the greater of EOQ and the deficit to the lead-time + review-period target. A safety-stock deficit can produce a target quantity with no sales history.
- Order-by date estimates current stock cover above safety stock, less lead time. Dates may be past due.

Ordering settings edit order cost and annual holding percentage. Policy edits an item's supplier, lead/build days, safety stock and manual review interval. Initial safety stock is 25% of the original stored reorder setting rounded up; it is editable, not a hidden calculated rating. Inventory and Overview prefer the live calculated reorder points when migration 006 is available. Review stores the decision, note, actor, time and a snapshot of calculation inputs, then schedules the next review date. Saving a review does not place an order. Draft PO prepares the suggested quantity for human review.

This forecast policy treats all outstanding orders as on-order inventory at company level. The **MRP** plan is the source for dated, location-specific confirmed demand and flags late/unassigned supply. Do not add forecast and MRP quantities together as if they were independent demand. Forecast kit quantities are Make suggestions; kits are assembled, not ordered from component suppliers.

## Four-week MRP

Open **MRP**. The planning start is today UTC and the horizon covers 28 calendar days. Week/location filters only change the displayed rows; calculations always allocate all earlier demand/supply first.

1. Read confirmed `Order Placed` sales-order lines due within the horizon, including overdue orders. Exclude Fulfilled, Closed and Cancelled. Orders do not reserve physical stock.
2. At each pickup location, allocate finished kit stock and timely firm issued-build output chronologically. Only the deficit becomes a suggested new build.
3. Multiply each suggested build by its single-level BOM quantities. Components are required before assembly starts: kit required date minus kit lead/build time.
4. Combine those component needs with direct sales-order demand for purchased items at that location.
5. Allocate current stock and outstanding PO quantities with assigned locations and a current ETA no later than the requirement date. Every unit is used once and unused supply carries forward. Later receipts do not cover earlier shortages.
6. Suggested Buy quantity = max(0, gross requirement − allocated opening balance − supply arriving on that date). A suggested order is assumed to fill that shortage for subsequent netting; it is not a real receipt or committed PO.
7. Order/start-by date = original requirement date − item lead days. Overdue requirements are displayed in today's bucket while retaining the original date and late warning.

Example: a confirmed order needs 10 kits, 3 finished kits are available, and each kit needs 2 pencils. Plan 7 builds and 14 pencils, not 20. If 8 pencils are available and a timely PO supplies 3 more, suggest buying 3 pencils. Stock at another location is shown as a potential transfer, not silently allocated. Explain shows the stored-demand sources, projected balance, supply, lead time and date. Draft PO creates an editable draft for a Buy shortage; large quantities above the PO limit require explicit splitting. A newly sent PO whose lead time misses the need date remains late; placing an order does not guarantee an impossible date.

Overdue unreceived POs and unassigned incoming units are excluded from timely MRP supply and shown as warnings. Update their delivery plans or arrange transfers/expediting. Original promised dates remain available for supplier scoring. Nested BOMs are optional in the assignment and this implementation explicitly rejects them; use the five single-level kit BOMs. Missing BOMs are flagged for correction.

### Production-owner integration contract

The current main branch does not yet contain a production module. MRP already plans Make quantities and components, but it cannot execute builds. That is the production owner's feature.

Migration 006 creates an initially empty `public.mrp_firm_build_supply` view, with columns:

| Column | Type | Meaning |
| --- | --- | --- |
| product_id | uuid | Finished kit |
| location_id | uuid | Receiving location |
| available_date | date | Expected completion date, UTC |
| quantity | integer | Remaining good output expected |

In a follow-up migration, the production owner should replace the view with active **issued** work orders whose components are already deducted from stock. Exclude completed/cancelled orders, scrapped output, unissued plans and MRP suggestions. Return only remaining expected good output, not total originally started units. Preserve `security_invoker=true` and staff-only underlying access. If unissued firm builds are to be counted, also extend MRP to reserve/explode their unissued component requirements; do not expose them as free finished supply.

The automated test replaces this view with a firm fixture and verifies that early supply offsets builds while late supply does not. Until connected, firm-build output is truthfully zero. After production integration, verify component stock plus firm output is neither duplicated nor omitted.

## Verify live before the demo

- Apply 006, then 007. Confirm the same inventory quantities/value and sales/P&L as before the import. Check all six suppliers have computed historical measures.
- Edit a supplier's quote and terms; current component lead times and new PO expectations should change while previous PO snapshots stay unchanged.
- Draft, prepare/send a document and record dispatch for a PO. Receive partially, check stock/cost, then receive the rest and close. Reject excess or wrong-location receipt quantities. Test printed scan-to-receive with the actual scanner.
- Record a partial bill payment, inspect remaining debt and due date, then settle it. Retry the same payment request after a simulated lost response and confirm no duplicate payment. This is recordkeeping, not a banking integration.
- Change ordering/holding settings, safety stock and lead time. Re-show EOQ and reorder results. Record a manual review and inspect the next due date.
- Place an unfulfilled kit order large enough to exceed finished stock and component supply. Recalculate MRP. Add a timely PO at its location; the shortage should fall. Move its planning ETA after the requirement: the early shortage must reappear.
- Fulfill/cancel a sales order and recheck MRP. Sales fulfillment should move demand out of the plan and update financial reporting once.
- Confirm another enrolled user sees changes through the idle refresh/manual Refresh. Try concurrent receipts/payments for the last remaining quantity/balance on a disposable test project: reject over-receipt/overpayment.
- Verify production's firm-build adapter when that teammate merges it. Check small/mobile screens, keyboard navigation, email client handoff and printed PO readability.

Automated evidence uses actual PostgreSQL via PGlite plus the compiled UI in Happy DOM with a fake Supabase transport and canvas text measurement. It checks algorithms, access rules, regression flows, import invariants, and form behavior. Actual Supabase/PostgREST, SMTP/email delivery, scanner hardware, real browser rendering/printing and true simultaneous sessions are not established by these tests. This environment does not offer the Sites browser-control tool, so no real-browser QA is claimed.
