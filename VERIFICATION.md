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
