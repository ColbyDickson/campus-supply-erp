import { createClient } from '@supabase/supabase-js';
import JsBarcode from 'jsbarcode';
import { money, escapeHtml as e, utcDay, monthStart, validateConnection, cartTotals } from './domain.js';
import './style.css';

const root = document.querySelector('#app');
const modal = document.querySelector('#modal');
const S = {
  client: null, session: null, nav: 'dashboard', products: [], locations: [], stock: [], customers: [],
  sales: [], movements: [], suppliers: [], purchases: [], purchaseError: '', settings: {}, cart: [], discount: 0, location: '', query: '', posQuery: '',
  from: monthStart(), to: utcDay(), report: {}, summary: {}, pending: null, busy: false, refreshing: false,
};
let timer, channel, noticeTimer;
const icons = {
  dashboard: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  inventory: '<path d="m3 7 9-4 9 4-9 4-9-4Zm0 0v10l9 4 9-4V7M12 11v10M7 5l10 5"/>',
  checkout: '<path d="M3 3h2l3 12h11l2-8H6M9 20h.01M18 20h.01"/><circle cx="9" cy="20" r="1"/><circle cx="18" cy="20" r="1"/>',
  reports: '<path d="M4 3v18h17M9 16v-5M14 16V7M19 16v-8"/>',
  guide: '<path d="M4 4h6a3 3 0 0 1 3 3v14a4 4 0 0 0-4-2H4V4Zm9 3a3 3 0 0 1 3-3h5v15h-4a4 4 0 0 0-4 2"/>',
};
const icon = name => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true">${icons[name] || icons.inventory}</svg>`;
const button = (label, action, cls = '', attrs = '') => `<button class="${cls}" data-act="${action}" ${attrs}>${label}</button>`;
const options = (rows, selected) => rows.map(x => `<option value="${e(x.id)}" ${x.id === selected ? 'selected' : ''}>${e(x.name)}</option>`).join('');
const product = id => S.products.find(x => x.id === id);
const locationName = id => S.locations.find(x => x.id === id)?.name || 'Location';
const stockAt = (id, loc = S.location) => S.stock.find(x => x.product_id === id && x.location_id === loc) || { quantity: 0, average_cost: 0 };
const formatTime = value => new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const pendingKey = () => `campus-pending-sale:${S.session.user.id}`;
function notify(message, error = false) {
  const n = document.querySelector('#notice');
  clearTimeout(noticeTimer); n.textContent = message; n.className = error ? 'visible error' : 'visible';
  noticeTimer = setTimeout(() => { n.className = ''; }, error ? 14000 : 7000);
}
function showError(error) { notify(error.message || String(error), true); }
function authFrame(content) {
  root.innerHTML = `<main class="onboarding"><section class="brand-story"><a class="brand" href="#">${icon('inventory')}<span>campus<span class="brand-light">supply.</span></span></a>
    <div><p class="eyebrow light">CAMPUS SUPPLY CO.</p><h1>Small supplies.<br>Connected operations.</h1><p>From the stockroom to the checkout counter, keep the whole business on the same page.</p>
    <div class="brand-flow"><span>Receive</span><span>→</span><span>Build</span><span>→</span><span>Sell</span></div></div>
    <small>A fictional business. A real learning project.</small></section><section class="onboarding-form">${content}</section></main>`;
}
function connectionScreen() {
  authFrame(`<div class="form-card"><p class="eyebrow">LET’S GET CONNECTED</p><h2>Your shared workspace</h2><p>Connect this browser to your team’s Supabase project. Run the database setup first; the steps are in the repository’s README.</p>
    <form id="connection-form"><label>Supabase Project URL<input name="url" type="url" placeholder="https://your-project.supabase.co" required></label>
    <label>Publishable or legacy anon key<textarea name="key" rows="3" placeholder="sb_publishable_…" required></textarea></label>
    <p class="hint">Find these in Supabase → Project Settings → API Keys. Use a public key. Never enter a database password, secret key, or service_role key.</p>
    <button class="primary wide">Save connection</button></form><div class="setup-note"><strong>One shared database</strong><p>Each teammate connects to the same project and signs in with their own staff account. These public connection settings are saved in this browser.</p></div></div>`);
}
function loginScreen() {
  authFrame(`<div class="form-card"><p class="eyebrow">WELCOME TO CAMPUS SUPPLY</p><h2>Good to see you.</h2><p>Sign in with your enrolled teammate account.</p><form id="login-form">
    <label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label>
    <button class="primary wide">Sign in</button></form><p class="hint">First time? Your project owner must create your account and enroll your user ID using the SQL setup guide.</p>${button('Change database connection','disconnect','text-button')}</div>`);
}
async function connect(config) {
  S.client = createClient(config.url, config.key);
  S.client.auth.onAuthStateChange((event, session) => {
    if (event === 'SIGNED_OUT') { S.session = null; stopSync(); loginScreen(); }
    if (event === 'TOKEN_REFRESHED') S.session = session;
  });
  const { data, error } = await S.client.auth.getSession();
  if (error) throw error;
  if (data.session) await startSession(data.session); else loginScreen();
}
function stopSync() {
  clearInterval(timer);
  if (channel) { S.client.removeChannel(channel); channel = null; }
}
async function startSession(session) {
  S.session = session;
  root.innerHTML = '<main class="loading"><span class="spinner"></span><p>Opening your workspace…</p></main>';
  try {
    const { data, error } = await S.client.rpc('is_staff');
    if (error) throw new Error(`Database setup is incomplete or unavailable. ${error.message}`);
    if (!data) throw new Error('This account is not enrolled as a teammate. Ask the project owner to run the team enrollment SQL with your user ID.');
    const stored = localStorage.getItem(pendingKey());
    S.pending = stored ? JSON.parse(stored) : null;
    if (S.pending) { S.cart = S.pending.items; S.discount = S.pending.discount; S.location = S.pending.location; S.nav = 'checkout'; }
    await load(); render(); stopSync();
    channel = S.client.channel('shared-stock').on('postgres_changes', { event: '*', schema: 'public', table: 'stock' }, () => refresh()).subscribe();
    timer = setInterval(() => refresh(), 10000);
  } catch (error) {
    await S.client.auth.signOut(); loginScreen(); showError(error);
  }
}
async function load() {
  const tasks = [
    ['products',S.client.from('products').select('*').order('name')],
    ['locations',S.client.from('locations').select('*').order('name')],
    ['stock',S.client.from('stock').select('*')],
    ['customers',S.client.from('customers').select('*').order('name')],
    ['settings',S.client.from('settings').select('*').single()],
    ['sales',S.client.from('sales').select('*').order('created_at',{ ascending:false }).limit(12)],
    ['movements',S.client.from('movements').select('*').order('created_at',{ ascending:false }).limit(30)],
    ['report',S.client.rpc('financial_report',{ p_from:S.from,p_to:S.to })],
    ['summary',S.client.rpc('sales_summary',{ p_from:S.from,p_to:S.to })],
  ];
  const results = await Promise.all(tasks.map(async ([key,task]) => {
    const { data,error }=await task; if (error) throw error; return [key,data];
  }));
  for(const [key,data] of results) S[key] = data;
  if (!S.location) S.location = S.locations.find(x=>x.name==='Storefront')?.id || S.locations[0]?.id;
  S.updated = new Date();
}
async function refresh(force = false) {
  if (!S.session || S.refreshing || S.busy) return;
  if (!force && (modal.open || ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement?.tagName))) return;
  S.refreshing = true;
  try { await load(); if(S.nav==='purchasing')await loadPurchases(); render(); } catch(error) { showError(new Error(`Refresh failed. ${error.message}`)); }
  finally { S.refreshing=false; }
}
function render() {
  const titles = { dashboard:['Business overview','Your operations, in one place.'],inventory:['Inventory','Know what’s on hand. Keep it moving.'],checkout:['Point of sale','A smooth checkout. Connected to your stock.'],purchasing:['Purchasing','Order supplies. Receive stock. Track what arrived.'],reports:['Financial reports','Follow the numbers back to the business.'],guide:['Project guide','Build it. Verify it. Explain it.'] };
  root.innerHTML = `<div class="app-shell"><aside class="sidebar"><div class="brand">${icon('inventory')}<span>campus<span class="brand-light">supply.</span></span></div>
    <div class="workspace-tag">CAMPUS SUPPLY CO. <span>ERP</span></div><nav aria-label="Main navigation">${Object.keys(titles).map(key=>button(`${icon(key)}<span>${key==='dashboard'?'Overview':key==='checkout'?'Checkout':key==='guide'?'Project guide':titles[key][0]}</span>`,`nav:${key}`,S.nav===key?'active':'',S.nav===key?'aria-current="page"':'')).join('')}</nav>
    <div class="sidebar-bottom"><span class="avatar">${e(S.session.user.email?.[0]?.toUpperCase() || 'C')}</span><div><strong>Team workspace</strong><small>${e(S.session.user.email)}</small></div>${button('↪','logout','icon-button','aria-label="Sign out"')}</div></aside>
    <main class="main"><header class="topbar"><span>WORKSPACE <span class="slash">/</span> ${e(titles[S.nav][0])}</span><div class="sync"><span class="sync-dot"></span>Checked ${S.updated?.toLocaleTimeString('en-US',{hour:'numeric',minute:'2-digit'}) || '—'}${button('↻','refresh','icon-button','aria-label="Refresh data"')}${button('Sign out','logout','text-button mobile-signout')}</div></header>
    <div class="page"><div class="page-heading"><div><p class="eyebrow">CAMPUS SUPPLY CO.</p><h1>${titles[S.nav][0]}</h1><p>${titles[S.nav][1]}</p></div>${['inventory','checkout'].includes(S.nav)?`<label class="location-picker">WORKING LOCATION<select id="location" ${S.pending?'disabled':''}>${options(S.locations,S.location)}</select></label>`:S.nav==='dashboard'?button('＋ New sale','nav:checkout','primary'):''}</div>
    ${S.nav==='dashboard'?dashboard():S.nav==='inventory'?inventory():S.nav==='checkout'?checkoutView():S.nav==='purchasing'?purchasing():S.nav==='reports'?reports():guide()}</div>
    <footer>Campus Supply Co. · Class ERP foundation <span>All report dates use UTC · Sample company, fictional data</span></footer></main></div>`;
}
const metric = (label,value,description,accent='') => `<article class="metric ${accent}"><span>${label}</span><strong>${value}</strong><small>${description}</small></article>`;
function chart() {
  const days=S.summary.daily_sales || [], max=Math.max(1,...days.map(x=>Number(x.revenue)));
  return `<div class="chart" role="img" aria-label="Net sales by day for the selected date range">${days.length?days.map(x=>`<div class="bar-wrap" title="${e(x.day)}: ${money(x.revenue)}"><div class="bar" style="height:${Math.max(2,Number(x.revenue)/max*100)}%"></div></div>`).join(''):'<p class="empty">No sales in this range. Complete a checkout to get started.</p>'}</div><div class="chart-labels"><span>${e(S.from)}</span><span>Daily net sales · ${S.summary.receipt_count || 0} receipts</span><span>${e(S.to)}</span></div>`;
}
function dashboard() {
  const low = S.products.filter(p=>S.stock.filter(s=>s.product_id===p.id).reduce((n,s)=>n+s.quantity,0)<=p.reorder_point);
  return `<div class="range-note">Reporting period: ${e(S.from)} — ${e(S.to)} ${button('Change dates','nav:reports','text-button')}</div>
    <section class="metrics">${metric('NET SALES',money(S.report.net_sales),'Sales less discounts; excludes tax','highlight')}${metric('GROSS PROFIT',money(S.report.gross_profit),'Net sales minus recorded product costs')}${metric('INVENTORY VALUE',money(S.report.current_inventory),'Current stock at weighted average cost')}${metric('LOW STOCK ITEMS',low.length,'Across all three locations')}</section>
    <div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h2>Sales at a glance</h2><p>Actual receipts, grouped by day.</p></div><span class="badge">${e(S.from.slice(0,7))}</span></div>${chart()}</section>
    <section class="panel"><div class="panel-heading"><div><h2>Across your locations</h2><p>Current inventory value</p></div></div><div class="locations-list">${S.locations.map((l,i)=>{const rows=S.stock.filter(s=>s.location_id===l.id);return `<div class="location-card"><span class="location-number">0${i+1}</span><div><strong>${e(l.name)}</strong><small>${rows.reduce((n,s)=>n+s.quantity,0)} units on hand</small></div><strong>${money(rows.reduce((n,s)=>n+s.quantity*Number(s.average_cost),0))}</strong></div>`;}).join('')}</div>${button('Manage inventory →','nav:inventory','text-button')}</section></div>
    <section class="panel"><div class="panel-heading"><div><h2>Recent sales</h2><p>Every checkout connects inventory and financial reporting.</p></div>${button('Open checkout →','nav:checkout','text-button')}</div>${salesTable()}</section>
    <div class="foundation-note"><span>IN PROGRESS</span><p>This is the working foundation. Production, MRP, returns, customer ordering and advanced purchasing are still to be built.</p>${button('View project checklist →','nav:guide','text-button')}</div>`;
}
function salesTable() {
  return `<div class="table-wrap"><table><thead><tr><th>RECEIPT</th><th>DATE</th><th>LOCATION</th><th>NET SALES</th><th>TOTAL WITH TAX</th><th></th></tr></thead><tbody>${S.sales.map(s=>`<tr><td><span class="mono">${e(s.id.slice(0,8).toUpperCase())}</span></td><td>${formatTime(s.created_at)}</td><td>${e(locationName(s.location_id))}</td><td>${money(Number(s.subtotal)-Number(s.discount))}</td><td><strong>${money(s.total)}</strong></td><td>${button('Receipt',`receipt:${s.id}`,'small-button')}</td></tr>`).join('') || '<tr><td colspan="6" class="empty">No sales yet.</td></tr>'}</tbody></table></div>`;
}
function inventory() {
  const q=S.query.trim().toLowerCase(), items=S.products.filter(p=>`${p.name} ${p.sku} ${p.barcode}`.toLowerCase().includes(q));
  return `<section class="panel"><div class="toolbar"><div class="search"><span>⌕</span><input id="inventory-search" placeholder="Search items, SKU, or scan a barcode…" value="${e(S.query)}" aria-label="Search inventory"></div>${button('Print barcode labels','labels','secondary')}</div>
    <p class="table-caption">${items.length} items · ${e(locationName(S.location))} · Reorder points apply to company-wide stock. Scan then press Enter to adjust an exact match.</p>
    <div class="table-wrap"><table><thead><tr><th>ITEM / SKU</th><th>BARCODE</th><th>ON HAND</th><th>AVG. COST</th><th>PRICE</th><th>REORDER POINT</th><th>LEAD TIME</th><th>ACTIONS</th></tr></thead><tbody>${items.map(p=>{const s=stockAt(p.id),all=S.stock.filter(x=>x.product_id===p.id).reduce((n,x)=>n+x.quantity,0);return `<tr><td><div class="item-name"><span class="item-mark ${p.is_kit?'kit':''}">${p.is_kit?'K':'S'}</span><div><strong>${e(p.name)}</strong><small>${e(p.sku)} · ${e(p.category)}</small></div></div></td><td class="mono">${e(p.barcode)}</td><td><span class="stock-number">${s.quantity}</span>${all<=p.reorder_point?'<span class="badge warning">Low overall</span>':''}</td><td>${money(s.average_cost)}</td><td>${money(p.price)}</td><td>${p.reorder_point}</td><td>${p.lead_days} days</td><td><div class="row-actions">${button('Adjust',`adjust:${p.id}`,'small-button')}${button('Transfer',`transfer:${p.id}`,'small-button')}</div></td></tr>`;}).join('') || '<tr><td colspan="8" class="empty">No matching items.</td></tr>'}</tbody></table></div></section>
    <section class="panel"><div class="panel-heading"><div><h2>Inventory activity</h2><p>Latest 30 movements · quantities, reasons, and explanations.</p></div></div><div class="table-wrap"><table><thead><tr><th>WHEN</th><th>ITEM</th><th>LOCATION</th><th>CHANGE</th><th>REASON</th><th>NOTE</th></tr></thead><tbody>${S.movements.map(m=>`<tr><td>${formatTime(m.created_at)}</td><td>${e(product(m.product_id)?.name)}</td><td>${e(locationName(m.location_id))}</td><td class="${m.quantity>0?'positive':'negative'}">${m.quantity>0?'+':''}${m.quantity}</td><td><span class="badge">${e(m.reason.replaceAll('_',' '))}</span></td><td>${e(m.note)}</td></tr>`).join('')}</tbody></table></div></section>`;
}
function checkoutView() {
  const q=S.posQuery.toLowerCase(), items=S.products.filter(p=>`${p.name} ${p.sku} ${p.barcode}`.toLowerCase().includes(q));
  const totals=cartTotals(S.cart,S.products,S.discount,S.settings.tax_rate);
  return `${S.pending?'<div class="pending-note">This checkout is awaiting confirmation. Retry the same request to check its result safely; it will not charge inventory twice.</div>':''}<div class="checkout-grid"><section class="panel catalog"><div class="search"><span>⌕</span><input id="pos-search" placeholder="Scan barcode + Enter, or search products…" value="${e(S.posQuery)}" aria-label="Scan or search products" ${S.pending?'disabled':''}></div><p class="hint">A USB barcode scanner works like a keyboard. Print labels from Inventory.</p><div class="product-grid">${items.map(p=>{const s=stockAt(p.id);return `<button class="product-card" data-act="add:${p.id}" ${!s.quantity||S.pending?'disabled':''}><div class="product-card-top"><span class="item-mark ${p.is_kit?'kit':''}">${p.is_kit?'KIT':'SUP'}</span><span>${s.quantity} available</span></div><strong>${e(p.name)}</strong><small>${e(p.sku)}</small><div class="product-price">${money(p.price)}<span>＋</span></div></button>`;}).join('') || '<p class="empty">No matching products.</p>'}</div></section>
    <section class="panel sale-panel"><div class="panel-heading"><div><h2>Current sale</h2><p>${e(locationName(S.location))}</p></div><span class="badge">${S.cart.reduce((n,l)=>n+l.quantity,0)} units</span></div>
    <form id="sale-form"><fieldset ${S.pending?'disabled':''}><label>Customer<select id="customer"><option value="">Walk-in customer</option>${options(S.customers,S.customer)}</select></label><div class="cart-lines">${S.cart.map(l=>{const p=product(l.product_id);return `<div class="cart-line"><div><strong>${e(p.name)}</strong><small>${money(p.price)} each · ${stockAt(p.id).quantity} available</small></div><div class="quantity-control">${button('−',`qty:${p.id}:-1`,'','type="button" aria-label="Reduce quantity"')}<span>${l.quantity}</span>${button('＋',`qty:${p.id}:1`,'','type="button" aria-label="Increase quantity"')}</div><strong>${money(Number(p.price)*l.quantity)}</strong></div>`;}).join('') || '<div class="empty-cart">'+icon('checkout')+'<strong>Ready when you are.</strong><p>Scan a barcode or choose an item to start a sale.</p></div>'}</div><label>Discount amount ($)<input id="discount" type="number" min="0" max="${totals.subtotal}" step="0.01" value="${S.discount}"></label></fieldset>
    <div class="totals"><div><span>Subtotal</span><span>${money(totals.subtotal)}</span></div><div><span>Discount</span><span>−${money(S.discount)}</span></div><div><span>Tax (${(Number(S.settings.tax_rate)*100).toFixed(2)}%)</span><span>${money(totals.tax)}</span></div><div class="grand-total"><span>Total</span><span>${money(totals.total)}</span></div></div>
    <button class="primary wide" ${S.cart.length&&!S.busy?'':'disabled'}>${S.pending?'Retry / confirm checkout':'Complete sale'}</button><p class="hint center">Class simulation · no card payment processing.<br>The database calculates the final receipt.</p></form></section></div>`;
}
function reports() {
  return `<form id="report-form" class="date-filter"><label>From (UTC)<input name="from" type="date" value="${e(S.from)}" required></label><label>Through (UTC)<input name="to" type="date" value="${e(S.to)}" required></label><button class="primary">Apply dates</button></form>
    <section class="metrics">${metric('NET SALES',money(S.report.net_sales),'Excludes sales tax','highlight')}${metric('GROSS PROFIT',money(S.report.gross_profit),'Revenue less cost of goods sold')}${metric('INVENTORY TURNOVER',S.report.turnover===null?'—':`${Number(S.report.turnover).toFixed(3)}×`,'Selected period; not annualized')}${metric('CURRENT INVENTORY',money(S.report.current_inventory),'Current value, independent of report dates')}</section>
    <div class="dashboard-grid"><section class="panel"><div class="panel-heading"><div><h2>Profit & loss</h2><p>${e(S.from)} — ${e(S.to)} · USD</p></div></div><div class="pnl">${[['Net sales',S.report.net_sales],['Cost of goods sold',-Number(S.report.cogs)],['Gross profit',S.report.gross_profit],['Inventory adjustment expense',-Number(S.report.inventory_adjustment_expense)],['Modeled operating profit',S.report.operating_profit]].map(([label,value],i)=>`<div class="${i===2||i===4?'pnl-total':''}"><span>${label}</span><strong>${money(value)}</strong></div>`).join('')}</div><p class="hint">This foundation records sales, product costs, and inventory adjustments. Rent, payroll, supplier payments, returns, and other expenses are not implemented.</p></section>
    <section class="panel"><div class="panel-heading"><div><h2>What’s selling</h2><p>Units sold · product sales before discounts and tax</p></div></div><div class="top-items">${(S.summary.top_items||[]).map((p,i)=>`<div><span class="rank">${i+1}</span><div><strong>${e(p.name)}</strong><small>${p.units} units</small></div><strong>${money(p.sales)}</strong></div>`).join('') || '<p class="empty">No sales in this range.</p>'}</div></section></div>
    <section class="panel"><div class="panel-heading"><div><h2>How the calculations connect</h2><p>These results are computed in the database.</p></div></div><div class="formula-grid"><div><strong>Net sales</strong><p>Stored sale subtotals − discounts. Tax is excluded.</p></div><div><strong>Inventory valuation</strong><p>Quantity on hand × weighted average unit cost, summed across locations.</p></div><div><strong>Inventory turnover</strong><p>Period COGS ÷ average of opening and closing inventory values, reconstructed from movement history.</p><small>Opening ${money(S.report.opening_inventory)} · Closing ${money(S.report.closing_inventory)}</small></div></div></section>`;
}
function guide() {
  const rows=[['1','Point of sale','Foundation ready','Multi-line sales, tax, discounts, stored receipts, stock reduction and COGS.'],['2','Inventory','Partly ready','Three locations, quantities, transfers and reason-coded adjustments. Backorders and availability dates remain.'],['3','Barcodes','Hardware check needed','Code 128 labels and keyboard/USB scan-to-add and scan-to-adjust. Verify printed labels with your actual scanner.'],['4','Sales orders','To build','Order lifecycle and reservation/fulfillment rules.'],['5','Returns & exchanges','To build','Original-sale links, refund limits, quality dispositions, revenue and cost reversals.'],['6','Production','To build','BOMs are seeded; issue/build/scrap, cost rollup, timestamps and metrics remain.'],['7','Purchasing & suppliers','Partly ready','Create/print POs, expected lead-time dates, partial receiving, weighted costs and order closing. Sending is simulated. Supplier editing, EOQ/reorder rules, payments and scorecards remain.'],['8','MRP','To build','Confirmed demand → BOM requirements → net inventory/open PO supply → suggested quantities and dates.'],['9','Financial reporting','Partly ready','P&L for implemented events, weighted inventory valuation, and period inventory turnover. Extend for later modules.'],['10','Manager reporting','Partly ready','Daily sales, top products, low stock and location inventory; procurement recommendations remain.'],['11','Customer portal','To build','Customer login and pickup ordering with separate restricted access.'],['12','Multi-user access','Verify in Supabase','Staff accounts, server transactions, realtime subscription and 10-second refresh fallback. Test two real browsers.']];
  return `<section class="panel guide-intro"><p class="eyebrow">BUILD MILESTONE 1</p><h2>A working foundation, with a clear path forward.</h2><p>This starter is not the finished assignment. Before the live demo, complete and verify all twelve capabilities. Every teammate should be able to explain how a sale, a build, and a purchase affect the rest of the system.</p></section><section class="panel"><div class="panel-heading"><h2>Assignment checklist</h2></div><div class="table-wrap"><table><thead><tr><th>#</th><th>CAPABILITY</th><th>STATUS</th><th>DETAILS</th></tr></thead><tbody>${rows.map(r=>`<tr><td>${r[0]}</td><td><strong>${r[1]}</strong></td><td><span class="badge ${r[2]==='To build'?'warning':''}">${r[2]}</span></td><td>${r[3]}</td></tr>`).join('')}</tbody></table></div></section>
    <section class="panel"><div class="panel-heading"><h2>Tools & architecture</h2></div><div class="formula-grid"><div><strong>Code & hosting</strong><p>JavaScript, Vite, GitHub and GitHub Pages. AI coding assistance: OpenAI Codex in ChatGPT.</p></div><div><strong>Shared data & identity</strong><p>Supabase PostgreSQL, Supabase Auth, row-level security and transactional database functions.</p></div><div><strong>Checks</strong><p>Node’s test runner and PGlite (PostgreSQL) check seeded data, transactions, valuation and access rules. Real Supabase and physical barcode checks are still required.</p></div></div></section>`;
}
function rerenderInput(id, value) {
  const position=document.getElementById(id)?.selectionStart;
  render(); const el=document.getElementById(id); el.focus();
  if(position!==null) el.setSelectionRange(position,position);
}
function addToCart(id,delta=1) {
  if(S.pending) return;
  const line=S.cart.find(x=>x.product_id===id), next=(line?.quantity||0)+delta;
  if(next>stockAt(id).quantity) { notify('Not enough stock at this location.',true); return; }
  if(next<=0) S.cart=S.cart.filter(x=>x.product_id!==id);
  else if(line) line.quantity=next; else S.cart.push({product_id:id,quantity:next});
  S.discount=Math.min(S.discount,cartTotals(S.cart,S.products,0,0).subtotal); render();
}
function inventoryDialog(kind,id) {
  const p=product(id), s=stockAt(id);
  modal.innerHTML=`<div class="dialog-heading"><div><p class="eyebrow">${kind==='adjust'?'STOCK ADJUSTMENT':'LOCATION TRANSFER'}</p><h2>${e(p.name)}</h2></div>${button('×','close','icon-button','aria-label="Close dialog"')}</div><p>${e(locationName(S.location))} · ${s.quantity} on hand</p><form id="inventory-form" data-kind="${kind}" data-product="${e(id)}">
    ${kind==='adjust'?'<label>Quantity change (use a negative number to remove)<input name="quantity" type="number" min="-10000" max="10000" step="1" required></label><label>Reason<select name="reason"><option value="CYCLE_COUNT">Cycle count correction</option><option value="DAMAGE">Damage / quality failure</option></select></label>':`<label>Destination<select name="to">${options(S.locations.filter(l=>l.id!==S.location),'')}</select></label><label>Quantity to move<input name="quantity" type="number" min="1" max="${s.quantity}" step="1" required></label>`}
    <label>Explanation<textarea name="note" rows="3" minlength="3" maxlength="500" required placeholder="Explain what happened…"></textarea></label><button class="primary wide">${kind==='adjust'?'Save adjustment':'Transfer stock'}</button><p class="hint">The movement is recorded for your audit trail. If the network result is unclear, check activity before submitting again.</p></form>`;
  modal.showModal(); modal.querySelector('input')?.focus();
}
async function completeSale() {
  if(!S.pending) {
    if(!S.cart.length) return;
    if(!Number.isFinite(S.discount)||S.discount<0) throw new Error('Enter a valid discount.');
    S.pending={id:crypto.randomUUID(),items:S.cart.map(x=>({...x})),location:S.location,customer:S.customer||null,discount:S.discount};
    localStorage.setItem(pendingKey(),JSON.stringify(S.pending));
  }
  const p=S.pending;
  S.busy=true; render();
  try {
    const {data,error}=await S.client.rpc('checkout',{p_request_id:p.id,p_location:p.location,p_customer:p.customer,p_items:p.items,p_discount:p.discount});
    if(error) {
      // PostgreSQL validation failures mean the transaction was rolled back.
      if(error.code && /^(P0001|22...|23...)$/.test(error.code)) { S.pending=null; localStorage.removeItem(pendingKey()); }
      throw error;
    }
    S.pending=null; localStorage.removeItem(pendingKey()); S.cart=[];S.discount=0;S.customer='';
    notify('Sale completed. Inventory and financials updated.');
    await load(); await showReceipt(data);
  } finally { S.busy=false; render(); }
}
async function showReceipt(id) {
  const {data:s,error}=await S.client.from('sales').select('*,sale_lines(*,products(name,sku))').eq('id',id).single();
  if(error) throw error;
  const content=`<div class="receipt"><p class="eyebrow">CAMPUS SUPPLY CO.</p><h2>Thanks for stopping by.</h2><p>${e(locationName(s.location_id))}<br>${formatTime(s.created_at)}<br><span class="mono">Receipt ${e(s.id)}</span></p><hr>${s.sale_lines.map(l=>`<div class="receipt-line"><div><strong>${e(l.products.name)}</strong><small>${l.quantity} × ${money(l.unit_price)}</small></div><span>${money(l.quantity*Number(l.unit_price))}</span></div>`).join('')}<hr><div class="totals"><div><span>Subtotal</span><span>${money(s.subtotal)}</span></div><div><span>Discount</span><span>−${money(s.discount)}</span></div><div><span>Tax</span><span>${money(s.tax)}</span></div><div class="grand-total"><span>Total</span><span>${money(s.total)}</span></div></div><p class="hint center">Class project receipt · simulated transaction</p></div>`;
  modal.innerHTML=`${content}<div class="dialog-actions">${button('Close','close','secondary')}${button('Print receipt','print-receipt','primary')}</div>`;
  modal.dataset.receipt=content; if(!modal.open)modal.showModal();
}
function printContent(html) {
  const area=document.querySelector('#print-area'); area.innerHTML=html; window.print();
}
function showLabels() {
  modal.innerHTML=`<div class="dialog-heading"><div><p class="eyebrow">PHYSICAL BARCODE SUPPORT</p><h2>Print your item labels</h2></div>${button('×','close','icon-button','aria-label="Close dialog"')}</div><p>Code 128 labels for all ${S.products.length} items. Print at 100% scale and test your USB scanner before the demo.</p><div class="barcode-labels">${S.products.map(p=>`<div class="barcode-label"><strong>${e(p.name)}</strong><svg data-barcode="${e(p.barcode)}"></svg><small>${e(p.sku)} · ${money(p.price)}</small></div>`).join('')}</div><div class="dialog-actions">${button('Print all labels','print-labels','primary')}</div>`;
  for(const svg of modal.querySelectorAll('[data-barcode]')) JsBarcode(svg,svg.dataset.barcode,{format:'CODE128',width:2,height:45,fontSize:13,margin:12});
  modal.showModal();
}
async function loadPurchases() {
  try {
    const [a,b]=await Promise.all([
      S.client.from('suppliers').select('*').order('name'),
      S.client.from('purchase_orders').select('*,purchase_lines(*,purchase_receipts(*))').order('sent_at',{ascending:false}).limit(100),
    ]);
    if(a.error||b.error)throw a.error||b.error;
    S.suppliers=a.data;S.purchases=b.data;S.purchaseError='';
  }catch(error){S.purchaseError=error.message;}
}
function purchasing() {
  if(S.purchaseError)return `<section class="panel"><h2>Purchasing setup needed</h2><p>In Supabase SQL Editor, run the new file <strong>supabase/004_purchasing.sql</strong>. Keep your existing tables and data. Then press Refresh.</p><p class="hint">Database message: ${e(S.purchaseError)}</p></section>`;
  return `<section class="panel"><div class="panel-heading"><div><h2>Purchase orders</h2><p>Latest 100 orders · expected dates use the supplier’s quoted lead time.</p></div>${button('＋ New purchase order','new-po','primary')}</div>
    <p class="hint">Sending is a class simulation: creating a PO marks it Order Sent. Use View / print to save a document; this app does not email suppliers. Receive each delivery when it physically arrives.</p>
    <div class="table-wrap"><table><thead><tr><th>PO</th><th>SUPPLIER</th><th>STATUS</th><th>EXPECTED (UTC)</th><th>LAST RECEIVED (UTC)</th><th>ORDER VALUE</th><th></th></tr></thead><tbody>${S.purchases.map(p=>{
      const receipts=p.purchase_lines.flatMap(l=>l.purchase_receipts), dates=receipts.map(r=>r.received_at.slice(0,10)).sort(),last=dates.at(-1);
      return `<tr><td class="mono">${e(p.id.slice(0,8))}</td><td>${e(S.suppliers.find(s=>s.id===p.supplier_id)?.name)}</td><td><span class="badge">${e(p.status)}</span></td><td>${e(p.expected_date)}</td><td>${last?`${e(last)} <span class="badge ${last>p.expected_date?'warning':''}">${last>p.expected_date?'Late receipt':'On time'}</span>`:'Not received'}</td><td>${money(p.purchase_lines.reduce((n,l)=>n+l.quantity*Number(l.unit_cost),0))}</td><td>${button('View / print',`po:${p.id}`,'small-button')}</td></tr>`;
    }).join('')||'<tr><td colspan="7" class="empty">No purchase orders yet. Create one to replenish supplies.</td></tr>'}</tbody></table></div></section>
    <div class="foundation-note"><span>NEXT PURCHASING STEPS</span><p>Supplier editing, payments, historical PO data, scorecards, lead-time reorder rules and EOQ remain to be added.</p></div>`;
}
function newPurchaseDialog(supplierId=S.suppliers[0]?.id) {
  const supplier=S.suppliers.find(s=>s.id===supplierId);
  if(!supplier)throw new Error('No suppliers available.');
  const items=S.products.filter(p=>p.supplier_id===supplierId&&!p.is_kit);
  modal.innerHTML=`<div class="dialog-heading"><h2>New purchase order</h2>${button('×','close','icon-button','aria-label="Close dialog"')}</div><form id="po-form" data-request="${crypto.randomUUID()}"><label>Supplier<select name="supplier" id="po-supplier">${options(S.suppliers,supplierId)}</select></label>
    <p class="hint">Quoted lead time: ${supplier.quoted_lead_days} days. Terms: Net ${supplier.payment_term_days}. Expected arrival is calculated from today’s UTC date when saved. Set quantities above zero for the items you want.</p>
    <div class="table-wrap"><table><thead><tr><th>ITEM</th><th>QUANTITY</th><th>QUOTED UNIT COST ($)</th></tr></thead><tbody>${items.map(p=>`<tr><td>${e(p.name)}</td><td><input aria-label="Quantity for ${e(p.name)}" name="qty-${p.id}" type="number" min="0" max="10000" step="1" value="0"></td><td><input aria-label="Unit cost for ${e(p.name)}" name="cost-${p.id}" type="number" min="0" max="1000000" step="0.01" value="${Number(p.standard_cost).toFixed(2)}"></td></tr>`).join('')}</tbody></table></div>
    <button class="primary wide">Create & mark sent (simulation)</button></form>`;
  if(!modal.open)modal.showModal();
}
function viewPurchase(id) {
  const p=S.purchases.find(x=>x.id===id),supplier=S.suppliers.find(s=>s.id===p.supplier_id);
  const document=`<div class="receipt"><p class="eyebrow">CAMPUS SUPPLY CO. · PURCHASE ORDER</p><h2>${e(supplier.name)}</h2><p>${e(supplier.email)} · ${e(supplier.phone)}</p><p class="mono">PO ${e(p.id)}</p><p>Sent: ${e(p.sent_at.slice(0,10))} UTC · Status: ${e(p.status)}<br>Expected: ${e(p.expected_date)} · Quoted lead: ${p.quoted_lead_days} days<br>Terms: Net ${p.payment_term_days} (payment tracking not yet implemented)</p>
    ${p.purchase_lines.map(l=>`<div class="receipt-line"><div><strong>${e(product(l.product_id)?.name)}</strong><small>${l.quantity} ordered × ${money(l.unit_cost)} · ${l.received} received</small></div><strong>${money(l.quantity*Number(l.unit_cost))}</strong></div>`).join('')}
    <hr><strong>Total ${money(p.purchase_lines.reduce((n,l)=>n+l.quantity*Number(l.unit_cost),0))}</strong><p class="hint">Fictional company · supplier sending is simulated.</p></div>`;
  modal.innerHTML=`${document}<div class="dialog-actions">${button('Print PO','print-receipt','secondary')}${p.status==='Order Sent'?button('Receive delivery',`receive-po:${id}`,'primary'):p.status==='Received'?button('Close order',`close-po:${id}`,'primary'):''}${button('Done','close','secondary')}</div><h3>Delivery history</h3>${p.purchase_lines.flatMap(l=>l.purchase_receipts.map(r=>`<p class="hint">${e(product(l.product_id)?.name)}: ${r.quantity} units · ${e(locationName(r.location_id))} · ${e(r.received_at.slice(0,10))} UTC · ${r.received_at.slice(0,10)>p.expected_date?'Late':'On time'}</p>`)).join('')||'<p class="hint">No deliveries recorded.</p>'}`;
  modal.dataset.receipt=document;if(!modal.open)modal.showModal();
}
function receivePurchaseDialog(id) {
  const p=S.purchases.find(x=>x.id===id),lines=p.purchase_lines.filter(l=>l.received<l.quantity);
  modal.innerHTML=`<div class="dialog-heading"><h2>Receive PO delivery</h2>${button('×','close','icon-button','aria-label="Close dialog"')}</div><form id="receive-form" data-request="${crypto.randomUUID()}"><label>Scan an item (optional)<input id="receive-scan" placeholder="Barcode + Enter" autocomplete="off"></label><label>PO item<select name="line" id="receive-line">${lines.map(l=>`<option value="${e(l.id)}" data-remaining="${l.quantity-l.received}" data-product="${e(l.product_id)}">${e(product(l.product_id)?.name)} · ${l.quantity-l.received} outstanding</option>`).join('')}</select></label><label>Receive into<select name="location">${options(S.locations,S.location)}</select></label><label>Quantity received today<input name="quantity" type="number" min="1" max="${lines[0].quantity-lines[0].received}" value="1" step="1" required></label><p class="hint">Partial deliveries are supported. Receipt time is recorded now in UTC. If a network response is lost, retry this same form; do not open a new receipt until you check the delivery history.</p><button class="primary wide">Receive stock</button></form>`;
  if(!modal.open)modal.showModal();
}
async function handleAction(target) {
  const [action,id,arg]=target.dataset.act.split(':');
  if(S.busy&&action!=='close')return;
  if(action==='nav'){S.nav=id;if(id==='purchasing')await loadPurchases();render();}
  else if(action==='refresh')await refresh(true);
  else if(action==='logout'){ await S.client.auth.signOut(); S.cart=[];S.pending=null; }
  else if(action==='disconnect'){if(S.client)await S.client.auth.signOut();localStorage.removeItem('campus-connection');location.reload();}
  else if(action==='add')addToCart(id);
  else if(action==='qty')addToCart(id,Number(arg));
  else if(action==='adjust'||action==='transfer')inventoryDialog(action,id);
  else if(action==='close')modal.close();
  else if(action==='labels')showLabels();
  else if(action==='receipt')await showReceipt(id);
  else if(action==='new-po')newPurchaseDialog();
  else if(action==='po')viewPurchase(id);
  else if(action==='receive-po')receivePurchaseDialog(id);
  else if(action==='close-po'){
    S.busy=true;try{const {error}=await S.client.rpc('close_purchase',{p_order:id});if(error)throw error;await loadPurchases();render();viewPurchase(id);notify('Purchase order closed.');}finally{S.busy=false;}
  }
  else if(action==='print-receipt')printContent(modal.dataset.receipt);
  else if(action==='print-labels')printContent(`<div class="barcode-labels">${modal.querySelector('.barcode-labels').innerHTML}</div>`);
}
document.addEventListener('click',event=>{
  const target=event.target.closest('[data-act]');
  if(target){ event.preventDefault();handleAction(target).catch(showError); }
});
document.addEventListener('input',event=>{
  if(event.target.id==='inventory-search'){S.query=event.target.value;rerenderInput('inventory-search');}
  if(event.target.id==='pos-search'){S.posQuery=event.target.value;rerenderInput('pos-search');}
});
document.addEventListener('change',event=>{
  if(event.target.id==='po-supplier')newPurchaseDialog(event.target.value);
  if(event.target.id==='receive-line')modal.querySelector('[name="quantity"]').max=event.target.selectedOptions[0].dataset.remaining;
  if(event.target.id==='location'){S.location=event.target.value;render();}
  if(event.target.id==='customer')S.customer=event.target.value;
  if(event.target.id==='discount'){S.discount=Number(event.target.value);render();}
});
document.addEventListener('keydown',event=>{
  if(event.key==='Enter'&&event.target.id==='receive-scan'){
    event.preventDefault();const code=event.target.value.trim().toLowerCase();
    const p=S.products.find(p=>p.barcode.toLowerCase()===code||p.sku.toLowerCase()===code);
    const option=p&&modal.querySelector(`#receive-line option[data-product="${p.id}"]`);
    if(!option){notify('This item is not outstanding on this PO.',true);return;}
    const select=modal.querySelector('#receive-line');select.value=option.value;select.dispatchEvent(new Event('change',{bubbles:true}));event.target.value='';modal.querySelector('[name="quantity"]').focus();
  }
  if(event.key==='Enter'&&['pos-search','inventory-search'].includes(event.target.id)){
    event.preventDefault(); const code=event.target.value.trim().toLowerCase();
    const p=S.products.find(p=>p.barcode.toLowerCase()===code||p.sku.toLowerCase()===code);
    if(!p){notify('Barcode or SKU not found.',true);return;}
    if(event.target.id==='pos-search'){S.posQuery='';addToCart(p.id);document.querySelector('#pos-search')?.focus();}
    else inventoryDialog('adjust',p.id);
  }
});
document.addEventListener('submit',async event=>{
  event.preventDefault(); const form=event.target, data=new FormData(form),submit=form.querySelector('button:not([type="button"])');
  if(S.busy)return;
  if(submit)submit.disabled=true;
  try {
    if(form.id==='connection-form'){
      const config=validateConnection(String(data.get('url')).trim(),String(data.get('key')).trim());
      localStorage.setItem('campus-connection',JSON.stringify(config));await connect(config);
    } else if(form.id==='login-form'){
      const {data:result,error}=await S.client.auth.signInWithPassword({email:String(data.get('email')).trim(),password:String(data.get('password'))});
      if(error)throw error;await startSession(result.session);
    } else if(form.id==='sale-form')await completeSale();
    else if(form.id==='inventory-form'){
      S.busy=true;
      const qty=Number(data.get('quantity')), note=String(data.get('note')).trim();
      if(!Number.isInteger(qty)||qty===0)throw new Error('Enter a nonzero whole-number quantity.');
      const {error}=await S.client.rpc(form.dataset.kind==='adjust'?'adjust_stock':'transfer_stock',form.dataset.kind==='adjust'?
        {p_product:form.dataset.product,p_location:S.location,p_delta:qty,p_reason:data.get('reason'),p_note:note}:
        {p_product:form.dataset.product,p_from:S.location,p_to:data.get('to'),p_quantity:qty,p_note:note});
      if(error)throw error;modal.close();await load();render();notify('Inventory updated and movement recorded.');
    } else if(form.id==='po-form'){
      S.busy=true;const supplier=data.get('supplier');
      const items=S.products.filter(p=>p.supplier_id===supplier&&Number(data.get(`qty-${p.id}`))>0).map(p=>({product_id:p.id,quantity:Number(data.get(`qty-${p.id}`)),unit_cost:data.get(`cost-${p.id}`)}));
      if(!items.length)throw new Error('Enter a quantity for at least one item.');
      const {data:id,error}=await S.client.rpc('create_purchase_order',{p_id:form.dataset.request,p_supplier:supplier,p_items:items});
      if(error)throw error;await loadPurchases();render();viewPurchase(id);notify('PO created; sending is simulated. Print the document to share it.');
    } else if(form.id==='receive-form'){
      S.busy=true;const {error}=await S.client.rpc('receive_purchase',{p_id:form.dataset.request,p_line:data.get('line'),p_location:data.get('location'),p_quantity:Number(data.get('quantity'))});
      if(error)throw error;modal.close();await load();await loadPurchases();render();notify('Delivery received. Inventory and valuation updated.');
    } else if(form.id==='report-form'){
      if(data.get('to')<data.get('from'))throw new Error('End date must be on or after start date.');
      S.from=data.get('from');S.to=data.get('to');await load();render();
    }
  } catch(error){showError(error);} finally{S.busy=false;if(submit)submit.disabled=false;}
});

async function boot() {
  try {
    const env=import.meta.env;
    const config=env.VITE_SUPABASE_URL&&env.VITE_SUPABASE_PUBLISHABLE_KEY?
      validateConnection(env.VITE_SUPABASE_URL,env.VITE_SUPABASE_PUBLISHABLE_KEY):JSON.parse(localStorage.getItem('campus-connection')||'null');
    if(config)await connect(validateConnection(config.url,config.key));else connectionScreen();
  }catch(error){connectionScreen();showError(error);}
}
boot();
