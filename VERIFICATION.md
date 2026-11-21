# Verification and demo readiness

## Automated checks

Run `npm ci` then `npm test`. The test command rebuilds the committed GitHub Pages output before running tests. Database tests execute the actual schema and seed scripts in PGlite (PostgreSQL), with an Auth stub. DOM tests execute the compiled interface with a fake network transport. They do not connect to Supabase and do not test the physical scanner or actual browser layout.

Covered checks include starting counts/history, seed rerun behavior, movement/stock reconciliation, initial BOM costs, repeated scan aggregation, server prices, taxes and discounts, COGS, atomic failed checkout, checkout retry deduplication, transfers and valuation, adjustment reasons/signs, financial reports, permissions, rejection of privileged connection keys, and UI interaction flows.

The managed session used to prepare this starter does not expose the Sites `cua_repl.js` browser-control tool. No real browser preview, screenshot, or layout QA is claimed. The app needs the manual deployed checks below.

## Required live foundation checks

Use a fresh test Supabase project first. These operations change that project's records.

- Run `001_schema.sql` once, then `002_seed.sql`. Confirm 25 products, 5 BOM parents, 3 locations, 6 suppliers, 10 customers, and sales starting at least six months ago. Run the seed again and confirm it adds nothing.
- Create and enroll two staff users. Verify successful login for both; an unenrolled account must fail. Direct table update through the public client should fail even for staff. Never test with a service-role key because it bypasses the controls.
- On two computers, sign into different staff accounts against the same project. Complete a sale on one; wait for Realtime or the 10-second idle refresh, or press Refresh on the other. Confirm identical inventory. Repeat with an adjustment and a transfer. An input field being actively edited defers automatic rerendering.
- Sell several products with a discount. Verify receipt subtotal, tax on discounted subtotal, total and costs. Check the database receipt, stock movements, selected-period net sales and gross profit. Zero/negative/fractional quantities and discounts exceeding subtotal must fail.
- Try two simultaneous sales competing for the last unit. Only one should succeed; confirm no negative inventory, partial receipt, or partial deduction. PGlite tests cover atomic logic, but actual multi-session contention must be checked here.
- Try a checkout retry after a simulated lost response. Retry the same pending request; it should show the original receipt and deduct stock once. The UI preserves the pending checkout ID in browser storage. Stock adjustments/transfers do not yet have persisted idempotency keys: if a response is lost, check activity before resubmitting rather than blindly repeating.
- Transfer stock between two locations with different average costs. Check total units and value before/after and the destination weighted average. Sub-cent average-cost rounding may occur; displayed totals should reconcile to the cent.
- Record damage and a cycle-count correction with clear explanations. Damage must remove stock. Confirm the movement, financial adjustment expense and period boundaries. Changing inventory is not a substitute for purchasing/receiving.
- Print all labels at 100% scale on paper. Attach labels to physical supplies. Test the real USB scanner (configured to append Enter) in Checkout and Inventory search. A valid unknown code must show an error; repeated scans add units up to available stock. Barcode images existing on screen is not sufficient evidence.
- Print a receipt and inspect item names, quantities, prices, discount and tax. Test mobile and desktop navigation, sign-out, dialogs, keyboard focus and printing in the browsers you will actually use.
- Reports use UTC dates; individual timestamps use local display time. Near midnight, select the correct UTC report date. Check that the chart, P&L and product totals derive from all matching stored rows, including histories longer than Supabase's default 1000-row REST limit (aggregation runs in SQL).

## Before the final class demo

Complete the pending modules in PROJECT_PLAN.md, then extend these checks to all twelve capabilities and the wow feature. Test partial PO receipts, late suppliers, unpaid/partially paid bills, cancelled/fulfilled orders, partial returns, failed-quality returns, exchanges, production scrap/rework, MRP timing, insufficient components and customer isolation. Every number must change correctly when its stored inputs change.

The instructor chooses the live scenarios. Practice with varied requests rather than one memorized path. Every teammate must present a feature, dress professionally, and explain how the ERP connects operations and finance. Keep tool documentation in the app current. Bring the physical barcode labels and working scanner.

## Purchasing acceptance checks (migration 004)

- Apply 004 to the existing project; confirm existing stock, staff logins and sales are unchanged.
- Create a multi-line PO with quantities and costs. Confirm expected date = sent UTC date + quoted lead days; verify the printable document and stored payment terms. Sending is simulated, not external email.
- Receive some units into Stockroom; confirm stock quantity, weighted cost and valuation change and that net sales do not. Check actual-versus-expected date in history.
- Receive the remainder, including using a real printed barcode to select an outstanding item. Confirm Received status; close the order. Attempt early closing and over-receiving: both must fail.
- Retry the same receipt form after a lost response and confirm no duplicate stock. Check a second user's inventory. Simultaneously receive the last outstanding units from two sessions; only one should succeed.
- Unenrolled/anonymous users cannot access or write purchasing data. Supplier analytics, payment tracking, EOQ and reorder rules remain pending.


## POS and sales order acceptance checks (migration 005)

Automated tests run entirely in local PGlite and Happy DOM with fake Auth/network, not the shared project. They cover quote totals and snapshots, no financial/stock effect at placement, multi-line atomic fulfillment, correct location/current cost, report inclusion, failed stock fulfillment and retry, single receipt across retries, cancellation/closing rules, invalid inputs and aggregate quantity limits, and staff/customer/anonymous permissions. DOM checks cover navigation, estimate, a saved request after a simulated lost response, retry with identical inputs, shortage display, fulfillment, receipt and closing. Existing checkout/barcode/purchasing tests still run.

After review, use a separate test Supabase project for these manual checks before changing the shared project:

- Apply migrations in order through 005. Without 005, Sales orders must show setup guidance and existing checkout must still work.
- In POS, add at least two products and a discount; complete/print the receipt and verify location stock, tax, revenue and COGS. Repeat a request after a lost response to prove only one sale. Scan physical printed labels with the actual device.
- Place a two-item customer order with discount, location and required date. Note stock and current-date report totals before/after: placement must change neither. Print the quote. In the test database change catalog price/tax, then verify the original order quote stays fixed.
- Fulfill the order. Verify exactly one linked receipt and SALE movements, stock reduction at the chosen location, net revenue excluding tax, and COGS at fulfillment costs. Closing must not deduct again. Refresh/retry fulfillment and confirm no duplicate sale.
- Make an order with one item short. Fulfill: no item may be deducted and no receipt or partial financial event may remain. Replenish stock and retry. Cancel a different unfulfilled order and confirm no stock/finance effect. Reject cancellation of fulfilled/closed orders and fulfillment of cancelled orders.
- Open two real staff sessions and compete for the last stock with fulfillment versus POS and with two fulfillments; only sufficient transactions may succeed. PGlite tests prove sequential/atomic logic, not actual multi-session contention. Order creation is demand, not guaranteed availability; POS may consume the stock first.
- Simulate a lost order-creation response, reload that browser, navigate to Sales orders and retry the saved request: only one order should exist. A different login must not see the first user's pending request. Test two users' idle refresh/manual Refresh.
- An unenrolled customer must not read order headers/lines or execute the staff functions. Anonymous access and direct table writes must fail. Customer portal remains a separate future capability.
- Check the layout on real desktop/mobile browsers, keyboard navigation, quantity/discount validation, print output and pagination. No real-browser, live Supabase, multi-user contention or hardware verification is claimed by the automated suite.
