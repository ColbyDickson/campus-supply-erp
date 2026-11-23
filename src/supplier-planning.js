import { money, escapeHtml as e, utcDay } from './domain.js';

// Purchasing, supplier analytics and MRP share server-calculated facts. This
// module renders results; PostgreSQL owns mutations, costing and netting.
export function supplierPlanningModule({ S, modal, button, options, locationName, load, render, notify }) {
  let tab='orders', error='', orders=[], suppliers=[], cards=[], plan=[], mrp={rows:[]};
  let page=0, more=false, selectedSupplier='', bills=[], billPage=0, week='all', location='all', pending=null;
  const key=()=>`campus-pending-procurement:${S.session.user.id}`;
  const p=id=>S.products.find(p=>p.id===id);
  const supplier=id=>suppliers.find(s=>s.id===id);
  const qty=x=>Number(x||0).toLocaleString('en-US',{maximumFractionDigits:2});
  const percent=x=>x===null||x===undefined?'—':`${(Number(x)*100).toFixed(1)}%`;
  const date=x=>x?String(x).slice(0,10):'—';
  const btn=(label,action,cls='secondary',attrs='')=>button(label,action,cls,attrs);
  const heading=(title,description='')=>`<div class="dialog-heading"><div><h2>${title}</h2>${description?`<p>${description}</p>`:''}</div>${btn('×','close','icon-button','aria-label="Close dialog"')}</div>`;
  const open=html=>{modal.classList.add('planning-dialog');modal.innerHTML=html;if(!modal.open)modal.showModal();};
  const input=(label,name,value,type='text',attrs='')=>`<label>${label}<input name="${name}" type="${type}" value="${e(value)}" ${attrs}></label>`;
  const rpc=async(name,args={})=>{const r=await S.client.rpc(name,args);if(r.error)throw r.error;return r.data;};
  function remember(value){pending=value;if(value)localStorage.setItem(key(),JSON.stringify(value));else localStorage.removeItem(key());}
  async function refresh() {
    try {
      pending=JSON.parse(localStorage.getItem(key())||'null');
      const results=await Promise.all([
        S.client.from('suppliers').select('*').order('name'),
        S.client.from('purchase_orders').select('*,purchase_lines(*,purchase_receipts(*))').order('sent_at',{ascending:false,nullsFirst:true}).order('id').range(page*50,page*50+50),
        rpc('supplier_scorecards'),rpc('replenishment_plan'),rpc('mrp_plan'),
      ]);
      if(results[0].error||results[1].error)throw results[0].error||results[1].error;
      suppliers=results[0].data;orders=results[1].data.slice(0,50);more=results[1].data.length>50;
      cards=results[2];plan=results[3];mrp=results[4];error='';
      if(selectedSupplier)bills=await rpc('supplier_bills',{p_supplier:selectedSupplier,p_page:billPage});
      S.replenishment=plan;
    }catch(err){error=err.message;}
  }
  function setup() {
    return `<section class="panel planning-panel"><h2>Planning unavailable</h2><p>If this update has not been installed, apply <strong>006_supplier_planning_mrp.sql</strong> after 005, then <strong>007_supplier_history.sql</strong>. If already installed, do not rerun the schema: check the error below and your connection. Keep existing data and earlier migrations.</p><p class="hint">${e(error)}</p>${btn('Check again','sp-refresh')}</section>`;
  }
  function pendingNotice(){return pending?`<div class="pending-note">A ${e(pending.label)} request is awaiting confirmation. Retry the saved request before starting another. ${btn('Retry saved request','sp-retry')}</div>`:'';}
  function view() {
    if(error)return setup();
    return `${pendingNotice()}<div class="planning-tabs" role="group" aria-label="Purchasing sections">${[['orders','Purchase orders'],['suppliers','Suppliers & payments'],['reorder','Reorder & EOQ']].map(([id,label])=>btn(label,`sp-tab:${id}`,tab===id?'primary':'secondary')).join('')}</div>
      ${tab==='orders'?ordersView():tab==='suppliers'?suppliersView():reorderView()}`;
  }
  function ordersView() {
    return `<section class="panel planning-panel"><div class="panel-heading"><div><h2>Purchase orders</h2><p>Page ${page+1} · 50 orders per page · dates use UTC</p></div>${btn('New purchase order','new-po','primary',pending?'disabled':'')}</div>
      <p>Create a draft, prepare its supplier email or printable document, send it yourself, then record dispatch. Receiving records stock and a bill; payment recording does not transfer money.</p>
      <div class="table-wrap"><table><thead><tr><th>PO / SOURCE</th><th>SUPPLIER</th><th>STATUS</th><th>DELIVERY LOCATION</th><th>ORIGINAL PROMISE</th><th>CURRENT ETA</th><th>VALUE</th><th></th></tr></thead><tbody>${orders.map(o=>`<tr><td class="mono">${e(o.id.slice(0,8))}<small>${o.source==='historical_import'?'Generated history':'Team order'}</small></td><td>${e(supplier(o.supplier_id)?.name)}</td><td><span class="badge">${e(o.status)}</span></td><td>${o.delivery_location_id?e(locationName(o.delivery_location_id)):'Unassigned: excluded from MRP'}</td><td>${date(o.expected_date)}</td><td>${date(o.planning_date||o.expected_date)}</td><td>${money(o.purchase_lines.reduce((n,l)=>n+l.quantity*Number(l.unit_cost),0))}</td><td>${btn('View / print',`po:${o.id}`,'small-button')}</td></tr>`).join('')||'<tr><td colspan="8" class="empty">No orders yet.</td></tr>'}</tbody></table></div>
      <div class="dialog-actions">${btn('Previous','sp-prev','secondary',page?'':'disabled')}${btn('Next','sp-next','secondary',more?'':'disabled')}</div></section>`;
  }
  function newPurchase(supplierId=suppliers[0]?.id,prefill=null) {
    if(pending)throw new Error('Confirm the saved procurement request first.');
    const s=supplier(supplierId);if(!s)throw new Error('Add a supplier first.');
    const items=S.products.filter(x=>x.supplier_id===s.id&&!x.is_kit);
    open(`${heading('New purchase order')}<form id="po-form" data-request="${crypto.randomUUID()}"><label>Supplier<select name="supplier" id="po-supplier">${options(suppliers,s.id)}</select></label>
      <label>Planned delivery location<select name="location">${options(S.locations,prefill?.location_id||S.location)}</select></label>
      <p>Quoted lead: ${s.quoted_lead_days} days · Net ${s.payment_term_days}. The expected date is set when you record dispatch. ${prefill?`Suggested from ${e(prefill.origin)}. Review quantities and timing before ordering.`:''}</p>
      <div class="table-wrap"><table><thead><tr><th>ITEM</th><th>QUANTITY</th><th>UNIT COST ($)</th></tr></thead><tbody>${items.map(x=>`<tr><td>${e(x.name)}</td><td><input aria-label="Quantity for ${e(x.name)}" name="qty-${x.id}" type="number" min="0" max="10000" step="1" value="${prefill?.product_id===x.id?prefill.quantity:0}"></td><td><input aria-label="Cost for ${e(x.name)}" name="cost-${x.id}" type="number" min="0" max="1000000" step="0.01" value="${Number(x.standard_cost).toFixed(2)}"></td></tr>`).join('')}</tbody></table></div>
      <button class="primary wide">Save PO draft</button></form>`);
  }
  function orderDocument(o) {
    const s=supplier(o.supplier_id);
    return `<div class="receipt"><p class="eyebrow">CAMPUS SUPPLY CO. · PURCHASE ORDER</p><h2>${e(s?.name)}</h2><p>${e(s?.email)} · ${e(s?.phone)}</p><p class="mono">PO ${e(o.id)}</p><p>Status: ${e(o.status)} · Sent ${date(o.sent_at)} UTC<br>Deliver to ${o.delivery_location_id?e(locationName(o.delivery_location_id)):'location to be assigned'}<br>Original expected ${date(o.expected_date)} · Current ETA ${date(o.planning_date||o.expected_date)}<br>Quoted lead ${o.quoted_lead_days} days · Terms Net ${o.payment_term_days}</p>
      ${o.purchase_lines.map(l=>`<div class="receipt-line"><div><strong>${e(p(l.product_id)?.name)}</strong><small>${l.quantity} ordered × ${money(l.unit_cost)} · ${l.received} received${l.cancelled_quantity?` · ${l.cancelled_quantity} cancelled`:''}</small></div><strong>${money(l.quantity*Number(l.unit_cost))}</strong></div>`).join('')}<hr><strong>Total ${money(o.purchase_lines.reduce((n,l)=>n+l.quantity*Number(l.unit_cost),0))}</strong>${o.source==='historical_import'?'<p>Generated historical example linked to existing stock movements.</p>':''}</div>`;
  }
  function details(id) {
    const o=orders.find(x=>x.id===id);if(!o)throw new Error('Refresh the purchase list to find this order.');
    const html=orderDocument(o);
    open(`${html}<div class="dialog-actions">${btn('Print PO','print-receipt')}${btn('Prepare supplier email',`sp-email:${id}`)}
      ${o.status==='Draft'?btn('Record dispatch',`sp-dispatch:${id}`,'primary'):o.status==='Order Sent'?`${btn('Delivery plan',`sp-delivery:${id}`)}${btn('Receive delivery',`receive-po:${id}`,'primary')}`:o.status==='Received'?btn('Close order',`close-po:${id}`,'primary'):''}${btn('Done','close')}</div>
      ${o.dispatch_reference?`<p>Dispatch: ${e(o.dispatch_method||'Legacy')} · ${e(o.dispatch_reference)}</p>`:''}${o.planning_note?`<p>ETA update: ${e(o.planning_note)}</p>`:''}${o.closure_reason?`<p>${e(o.closure_reason)}</p>`:''}
      <h3>Delivery history</h3>${o.purchase_lines.flatMap(l=>l.purchase_receipts.map(r=>`<p>${e(p(l.product_id)?.name)}: ${r.quantity} units into ${e(locationName(r.location_id))} on ${date(r.received_at)} · ${date(r.received_at)>o.expected_date?'Late':'On time'} · bill ${money(r.quantity*Number(r.unit_cost))}, due ${date(r.due_date)}</p>`)).join('')||'<p>No receipts recorded.</p>'}`);
    modal.dataset.receipt=html;
  }
  function emailOrder(id) {
    const o=orders.find(x=>x.id===id),s=supplier(o.supplier_id);
    const body=`Campus Supply Co. purchase order ${o.id}\n\n${o.purchase_lines.map(l=>`${p(l.product_id)?.name}: ${l.quantity} @ ${money(l.unit_cost)}`).join('\n')}\n\nDelivery location: ${locationName(o.delivery_location_id)}\nRequested terms: Net ${o.payment_term_days}\nPlease confirm your delivery date.\n`;
    const a=document.createElement('a');a.href=`mailto:${encodeURIComponent(s.email).replace(/%40/g,'@')}?subject=${encodeURIComponent(`Campus Supply Co. PO ${o.id.slice(0,8)}`)}&body=${encodeURIComponent(body)}`;a.click();
    notify('Email draft requested in your email app. Send it there, then record dispatch here. Delivery is not verified by this website.');
  }
  function dispatchDialog(id) {
    open(`${heading('Record PO dispatch','Send the email or share the printed PO first, then record the details here.')}<form id="sp-dispatch-form" data-order="${id}"><label>Method<select name="method"><option>Email</option><option>Printed / shared document</option><option>Manual</option></select></label>${input('Recipient / dispatch reference','reference','', 'text','minlength="3" maxlength="500" required')}<p>This records your confirmation of sending. It does not send an email or verify delivery.</p><button class="primary wide">Confirm sent</button></form>`);
  }
  function deliveryDialog(id) {
    const o=orders.find(x=>x.id===id);
    open(`${heading('Update delivery plan','The original promise stays unchanged for supplier scoring.')}<form id="sp-delivery-form" data-order="${id}"><label>Delivery location<select name="location">${options(S.locations,o.delivery_location_id||S.location)}</select></label>${input('Current expected delivery (UTC)','expected',o.planning_date||o.expected_date,'date','required')}
      <label>Supplier confirmation / explanation<textarea name="note" minlength="3" maxlength="500" required>${e(o.planning_note||'')}</textarea></label><button class="primary wide">Save delivery plan</button></form>`);
  }
  function receiveDialog(id) {
    if(pending)throw new Error('Confirm the saved request first.');
    const o=orders.find(x=>x.id===id),lines=o.purchase_lines.filter(l=>l.received+(l.cancelled_quantity||0)<l.quantity);
    if(!lines.length)throw new Error('No outstanding quantities.');
    open(`${heading('Receive PO delivery')}<form id="receive-form" data-request="${crypto.randomUUID()}"><label>Scan an item (optional)<input id="receive-scan" placeholder="Barcode + Enter" autocomplete="off"></label><label>PO item<select name="line" id="receive-line">${lines.map(l=>`<option value="${l.id}" data-product="${l.product_id}" data-remaining="${l.quantity-l.received-(l.cancelled_quantity||0)}">${e(p(l.product_id)?.name)} · ${l.quantity-l.received-(l.cancelled_quantity||0)} outstanding</option>`).join('')}</select></label><label>Receive into<select name="location" ${o.delivery_location_id?'disabled':''}>${options(S.locations,o.delivery_location_id||S.location)}</select></label>${o.delivery_location_id?`<input type="hidden" name="location" value="${o.delivery_location_id}">`:''}${input('Quantity received today','quantity',1,'number',`min="1" max="${lines[0].quantity-lines[0].received-(lines[0].cancelled_quantity||0)}" step="1" required`)}<p>Received now at the PO unit cost. A bill is due Net ${o.payment_term_days} from this receipt. Partial deliveries are supported.</p><button class="primary wide">Receive stock</button></form>`);
  }
  function suppliersView() {
    if(selectedSupplier)return supplierDetail();
    return `<section class="panel planning-panel"><div class="panel-heading"><div><h2>Supplier scorecards</h2><p>Calculated from all sent PO, receipt and payment records.</p></div>${btn('Add supplier','sp-supplier-new','primary')}</div>
      <p>On-time and fill-rate denominators include due or fully received orders. Overdue incomplete orders count against on-time delivery. Lead times are weighted by units received. Original promises are preserved when a planning ETA changes.</p>
      <div class="supplier-grid">${cards.map(c=>`<article class="supplier-card"><div class="panel-heading"><h3>${e(c.name)}</h3><span class="badge ${['Watch','Replace'].includes(c.rating)?'warning':''}">${e(c.rating)}</span></div><div class="supplier-measures"><div><span>On-time delivery</span><strong>${percent(c.on_time_rate)}</strong></div><div><span>Actual / quoted lead</span><strong>${c.actual_days===null?'—':qty(c.actual_days)+' / '+qty(c.quoted_days)+' days'}</strong></div><div><span>Fill rate</span><strong>${percent(c.fill_rate)}</strong></div><div><span>Owed / overdue</span><strong>${money(c.owed)} / ${money(c.overdue)}</strong></div></div><p>${c.eligible_orders} eligible of ${c.orders} sent orders · ${c.sample_orders} generated historical examples</p>${btn('Details & payments',`sp-supplier:${c.id}`)}</article>`).join('')}</div>
      <details><summary>How ratings work</summary><p>Keep: on-time ≥90%, fill ≥95%, actual lead ≤125% of quoted (minimum 1 day). Replace: on-time &lt;70%, fill &lt;80%, or actual lead &gt;175% of quoted (minimum 2 days). Otherwise Watch. No history / Observing indicates insufficient eligible records. These are class management rules.</p></details></section>`;
  }
  function supplierDetail() {
    const c=cards.find(c=>c.id===selectedSupplier);if(!c){selectedSupplier='';return suppliersView();}
    return `<section class="panel planning-panel"><div class="panel-heading"><div><h2>${e(c.name)} <span class="badge">${e(c.rating)}</span></h2><p>${e(c.email)} · ${e(c.phone)} · current quote ${c.quoted_lead_days} days · Net ${c.payment_term_days}</p></div><div>${btn('Edit supplier',`sp-supplier-edit:${c.id}`)} ${btn('All suppliers','sp-supplier-back')}</div></div>
      <div class="supplier-measures"><div><span>On-time delivery</span><strong>${percent(c.on_time_rate)}</strong></div><div><span>Actual / quoted history</span><strong>${c.actual_days===null?'—':qty(c.actual_days)+' / '+qty(c.quoted_days)+' days'}</strong></div><div><span>Fill rate</span><strong>${percent(c.fill_rate)}</strong></div><div><span>Amounts owed</span><strong>${money(c.owed)}</strong></div><div><span>Overdue</span><strong>${money(c.overdue)}</strong></div></div><p>${c.eligible_orders} eligible of ${c.orders} sent orders. ${c.sample_orders} are generated historical examples. Bills are created per receipt; closing a PO does not pay them.</p>
      <div class="table-wrap"><table><thead><tr><th>RECEIPT / ITEM</th><th>RECEIVED</th><th>DUE (UTC)</th><th>BILLED</th><th>PAID</th><th>OWED</th><th></th></tr></thead><tbody>${bills.slice(0,20).map(b=>`<tr><td>${e(b.product)}<small>${e(b.id.slice(0,8))} · ${b.source==='historical_import'?'Generated history':'Team receipt'}</small></td><td>${date(b.received_at)}</td><td>${e(b.due_date)}</td><td>${money(b.amount)}</td><td>${money(b.paid)}</td><td>${money(b.outstanding)}</td><td>${btn('Payments',`sp-bill:${b.id}`,'small-button')}${Number(b.outstanding)>0?' '+btn('Record payment',`sp-pay:${b.id}`,'small-button'):''}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">No receipt bills yet.</td></tr>'}</tbody></table></div><div class="dialog-actions">${btn('Previous bills','sp-bills-prev','secondary',billPage?'':'disabled')}${btn('Next bills','sp-bills-next','secondary',bills.length>20?'':'disabled')}</div></section>`;
  }
  function supplierDialog(id=crypto.randomUUID()) {
    const s=supplier(id)||{id,name:'',email:'',phone:'',quoted_lead_days:5,payment_term_days:30};
    open(`${heading(s.name?'Edit supplier':'Add supplier')}<form id="sp-supplier-form" data-supplier="${id}">${input('Company name','name',s.name,'text','minlength="2" maxlength="150" required')}${input('Order email','email',s.email,'email','required')}${input('Phone / contact','phone',s.phone,'text','minlength="3" maxlength="50" required')}${input('Quoted lead time (days)','lead',s.quoted_lead_days,'number','min="0" max="365" step="1" required')}${input('Payment terms: Net days','terms',s.payment_term_days,'number','min="0" max="365" step="1" required')}<p>Saving updates the current lead time of this supplier’s component items. Existing sent PO quotes and terms stay unchanged.</p><button class="primary wide">Save supplier</button></form>`);
  }
  function billDialog(id,pay=false) {
    if(pending&&pay)throw new Error('Confirm the saved request first.');
    const b=bills.find(b=>b.id===id);if(!b)throw new Error('Refresh supplier bills first.');
    open(`${heading(pay?'Record supplier payment':'Recorded payments')}<p>${e(b.product)} · Bill ${money(b.amount)} · Outstanding ${money(b.outstanding)} · Due ${e(b.due_date)}</p>
      ${pay?`<form id="sp-payment-form" data-request="${crypto.randomUUID()}" data-receipt="${id}">${input('Amount ($)','amount',Number(b.outstanding).toFixed(2),'number',`min="0.01" max="${b.outstanding}" step="0.01" required`)}${input('Paid on (UTC)','paid',utcDay(),'date',`min="${date(b.received_at)}" max="${utcDay()}" required`)}${input('Bank / payment reference','reference','','text','minlength="3" maxlength="500" required')}<p>Records a payment already made outside the ERP. No money is transferred by this website.</p><button class="primary wide">Record payment</button></form>`:(b.payments||[]).map(x=>`<p>${money(x.amount)} · ${e(x.paid_on)} · ${e(x.reference)}</p>`).join('')||'<p>No payments recorded.</p>'}`);
  }
  function reorderView() {
    return `<section class="panel planning-panel"><div class="panel-heading"><div><h2>Reorder & EOQ review</h2><p>Company-wide forecast from ${e(plan[0]?.history_from||'—')} through ${e(plan[0]?.history_through||'—')}; ${plan[0]?.history_days||0} calendar days.</p></div>${btn('Ordering settings','sp-settings')}</div>
      <p>Historical kit sales are exploded into component usage once. Reorder point = daily usage × item lead time + safety stock. EOQ = √(2 × annual demand × ordering cost ÷ annual unit holding cost). Kits show make quantities, not supplier POs.</p>
      <p>Forecast recommendations include all open PO units in company-wide inventory position. Use MRP for dated, location-specific confirmed demand; do not add the two recommendations together.</p>
      <div class="table-wrap"><table><thead><tr><th>ITEM</th><th>USE / DAY</th><th>ON HAND / OPEN PO</th><th>REORDER POINT</th><th>EOQ</th><th>SUGGESTED</th><th>ORDER / START BY</th><th>REVIEW DUE</th><th></th></tr></thead><tbody>${plan.map(r=>`<tr><td><strong>${e(r.name)}</strong><small>${e(r.sku)} · ${r.is_kit?'Make':'Buy'}</small></td><td>${qty(r.daily_usage)}</td><td>${qty(r.on_hand)} / ${qty(r.incoming)}</td><td>${qty(r.reorder_point)}</td><td>${r.eoq===null?'—':qty(r.eoq)}</td><td>${qty(r.suggested_quantity)}</td><td>${date(r.order_by)}</td><td>${date(r.review_due)}<small>${r.last_reviewed?`${date(r.last_reviewed)}: ${e(r.last_decision)}`:'Never reviewed'}</small></td><td>${btn('Review',`sp-review:${r.id}`,'small-button')} ${btn('Policy',`sp-policy:${r.id}`,'small-button')}${!r.is_kit&&r.suggested_quantity>0?' '+btn('Draft PO',`sp-reorder-po:${r.id}`,'small-button'):''}</td></tr>`).join('')}</tbody></table></div>
      <details><summary>How the suggested quantity is calculated</summary><p>When inventory position falls to the lead-time reorder point, order the greater of EOQ and the lead-time + review-period target deficit. Safety-stock deficits can suggest quantities even with zero sales. EOQ is unavailable when demand or unit holding cost is zero. Order-by dates use current stock cover less lead time and may be overdue.</p></details></section>`;
  }
  function policyDialog(id) {
    const r=plan.find(x=>x.id===id);
    open(`${heading('Item planning policy',e(r.name))}<form id="sp-policy-form" data-product="${id}">${r.is_kit?'<p>Kit: replenished by production.</p>':`<label>Supplier<select name="supplier" required>${options(suppliers,r.supplier_id)}</select></label>`}${input(r.is_kit?'Build lead time (days)':'Component lead time (days)','lead',r.lead_days,'number','min="0" max="365" step="1" required')}${input('Safety stock (units)','safety',r.safety_stock,'number','min="0" max="1000000" step="1" required')}${input('Manual review interval (days)','review',r.review_days,'number','min="1" max="365" step="1" required')}<button class="primary wide">Save policy</button></form>`);
  }
  function reviewDialog(id) {
    const r=plan.find(x=>x.id===id);
    open(`${heading('Manual inventory review',e(r.name))}<p>Annual demand ${qty(r.annual_demand)} · ordering cost ${money(r.ordering_cost)} · annual holding cost per unit ${money(r.holding_cost)}. Current inventory position ${qty(r.inventory_position)}; reorder point ${qty(r.reorder_point)}; EOQ ${r.eoq===null?'unavailable':qty(r.eoq)}.</p>
      <form id="sp-review-form" data-request="${crypto.randomUUID()}" data-product="${id}"><label>Decision<select name="decision"><option>Order</option><option>Defer</option><option>Sufficient</option></select></label><label>Explanation<textarea name="note" minlength="3" maxlength="1000" required></textarea></label><p>This records a decision and a snapshot of these inputs. It does not automatically place a PO.</p><button class="primary wide">Save review</button></form>`);
  }
  function settingsDialog() {
    open(`${heading('Ordering settings')}<form id="sp-settings-form">${input('Cost to place one order ($)','ordering',S.settings.ordering_cost,'number','min="0.01" max="1000000" step="0.01" required')}${input('Annual holding cost (% of item cost)','holding',Number(S.settings.annual_holding_rate)*100,'number','min="0.01" max="1000" step="0.01" required')}<p>These stored values drive EOQ for every item.</p><button class="primary wide">Save settings</button></form>`);
  }
  function mrpView() {
    if(error)return setup();
    const rows=mrp.rows||[],filtered=rows.filter(r=>(week==='all'||r.week===Number(week))&&(location==='all'||r.location_id===location));
    return `${pendingNotice()}<section class="panel planning-panel"><div class="panel-heading"><div><h2>Four-week material requirements plan</h2><p>${e(mrp.as_of)} through ${e(mrp.through)} · ${mrp.confirmed_orders||0} confirmed unfulfilled orders · ${mrp.bom_parents||0} kit BOMs</p></div>${btn('Recalculate','sp-refresh','primary')}</div>
      <p>Finished kit stock is allocated first. Only the remaining builds generate component requirements, backed off by kit build time. Component stock and timely incoming POs are allocated once, at the order’s location. Overdue demand is rolled into today and retains its original need date.</p>
      ${mrp.overdue_incoming||mrp.unassigned_incoming||mrp.missing_boms?`<div class="pending-note">${qty(mrp.overdue_incoming)} overdue PO units and ${qty(mrp.unassigned_incoming)} units without a delivery location are excluded from timely supply. Update their delivery plans in Purchasing. ${mrp.missing_boms||0} kits have no BOM.</div>`:''}
      <p>Firm issued build output: ${qty(mrp.firm_build_units)} units. Only builds whose components have already been issued count here. Suggestions are planning advice, not inventory receipts or production orders.</p>
      <div class="planning-filters"><label>Week<select id="mrp-week"><option value="all">All four weeks</option>${[1,2,3,4].map(n=>`<option value="${n}" ${week===String(n)?'selected':''}>Week ${n}</option>`).join('')}</select></label><label>Location<select id="mrp-location"><option value="all">All locations</option>${options(S.locations,location)}</select></label></div>
      <div class="table-wrap"><table><thead><tr><th>WEEK / NEED DATE</th><th>ITEM / LOCATION</th><th>GROSS NEED</th><th>OPENING BALANCE</th><th>ARRIVING ON DATE</th><th>SUGGESTED</th><th>ORDER / START BY</th><th></th></tr></thead><tbody>${filtered.map(r=>{const index=rows.indexOf(r);return `<tr><td>Week ${r.week}<small>${e(r.required_date)}</small></td><td><strong>${e(r.name)}</strong><small>${e(locationName(r.location_id))}</small></td><td>${qty(r.gross)}</td><td>${qty(r.opening)}</td><td>${qty(r.incoming)}</td><td><span class="badge ${r.suggested_quantity>0?'warning':''}">${r.action} ${qty(r.suggested_quantity)}</span></td><td>${date(r.order_by)}${r.late?'<small class="negative">Past order-by date</small>':''}</td><td>${btn('Explain',`sp-explain:${index}`,'small-button')}${r.action==='Buy'&&r.suggested_quantity>0?' '+btn('Draft PO',`sp-mrp-po:${index}`,'small-button'):''}</td></tr>`;}).join('')||'<tr><td colspan="8" class="empty">No matching confirmed demand. Place a sales order to populate this plan.</td></tr>'}</tbody></table></div></section>`;
  }
  function explain(index) {
    const r=mrp.rows[index];
    open(`${heading('Why this recommendation?',e(r.name))}<p>${e(r.explanation)}</p><div class="pnl"><div><span>Required at ${e(locationName(r.location_id))}</span><strong>${e(r.required_date)}</strong></div><div><span>Gross requirement</span><strong>${qty(r.gross)}</strong></div><div><span>Projected opening balance</span><strong>${qty(r.opening)}</strong></div><div><span>Incoming on this date</span><strong>${qty(r.incoming)}</strong></div><div><span>${r.action} shortage</span><strong>${qty(r.suggested_quantity)}</strong></div><div><span>Lead time</span><strong>${r.lead_days} days</strong></div><div><span>Order / start by</span><strong>${date(r.order_by)}</strong></div></div><p>${qty(r.other_location_stock)} units are held at other locations. Transfer them explicitly if appropriate; they are not counted here. Incoming balances may include earlier timely receipts already carried forward. ${r.action==='Make'?'Build suggestions require components; check the associated Buy rows.':''}</p>${btn('Done','close')}`);
  }
  function draftSuggestion(r,origin) {
    const productId=r.product_id||r.id;
    if(!r.supplier_id)throw new Error('Assign a supplier in the item policy first.');
    if(r.suggested_quantity>10000)throw new Error('The suggestion exceeds 10,000 units. Review it and split purchases manually.');
    newPurchase(r.supplier_id,{product_id:productId,quantity:r.suggested_quantity,location_id:r.location_id||S.location,origin});
  }
  async function sendPending() {
    if(!pending)return;S.busy=true;
    try {
      const req=pending, result=await rpc(req.name,req.args);
      remember(null);modal.close();await load();page=0;await refresh();render();
      if(req.name==='create_purchase_draft')details(result);
      notify(`${req.label} saved. Shared records updated.`);
    }catch(err){
      if(err.code&&/^(P0001|22...|23...)$/.test(err.code))remember(null);
      render();throw err;
    }finally{S.busy=false;}
  }
  async function submit(form) {
    const f=new FormData(form),id=form.id,n=name=>Number(f.get(name));
    if(pending)throw new Error('Retry the saved request first.');
    if(id==='po-form') {
      const items=S.products.filter(x=>x.supplier_id===f.get('supplier')&&!x.is_kit).map(x=>({product_id:x.id,quantity:n(`qty-${x.id}`),unit_cost:n(`cost-${x.id}`)}));
      if(items.some(x=>!Number.isInteger(x.quantity)||x.quantity<0||x.quantity>10000))throw new Error('Use whole-number quantities from 0–10000.');
      if(!items.some(x=>x.quantity>0))throw new Error('Enter a quantity for at least one item.');
      remember({label:'PO draft',name:'create_purchase_draft',args:{p_id:form.dataset.request,p_supplier:f.get('supplier'),p_location:f.get('location'),p_items:items.filter(x=>x.quantity>0)}});
    }else if(id==='receive-form')remember({label:'delivery receipt',name:'receive_purchase',args:{p_id:form.dataset.request,p_line:f.get('line'),p_location:f.get('location'),p_quantity:n('quantity')}});
    else if(id==='sp-payment-form')remember({label:'supplier payment',name:'record_supplier_payment',args:{p_id:form.dataset.request,p_receipt:form.dataset.receipt,p_amount:n('amount'),p_paid:f.get('paid'),p_reference:f.get('reference')}});
    else if(id==='sp-review-form')remember({label:'inventory review',name:'review_planning_item',args:{p_id:form.dataset.request,p_product:form.dataset.product,p_decision:f.get('decision'),p_note:f.get('note')}});
    else {
      S.busy=true;
      try {
        if(id==='sp-dispatch-form')await rpc('dispatch_purchase',{p_order:form.dataset.order,p_method:f.get('method'),p_reference:f.get('reference')});
        if(id==='sp-delivery-form')await rpc('update_purchase_delivery',{p_order:form.dataset.order,p_location:f.get('location'),p_expected:f.get('expected'),p_note:f.get('note')});
        if(id==='sp-supplier-form')await rpc('save_supplier',{p_id:form.dataset.supplier,p_name:f.get('name'),p_email:f.get('email'),p_phone:f.get('phone'),p_lead:n('lead'),p_terms:n('terms')});
        if(id==='sp-settings-form')await rpc('save_ordering_settings',{p_ordering:n('ordering'),p_holding:n('holding')/100});
        if(id==='sp-policy-form')await rpc('save_item_policy',{p_product:form.dataset.product,p_supplier:f.get('supplier')||null,p_lead:n('lead'),p_safety:n('safety'),p_review:n('review')});
        modal.close();await load();await refresh();render();notify('Settings saved. Calculations updated.');
      }finally{S.busy=false;}
      return;
    }
    modal.close();render();await sendPending();
  }
  async function action(name,id) {
    if(name==='sp-tab'){tab=id;selectedSupplier='';await refresh();render();}
    else if(name==='sp-refresh'){await load();await refresh();render();}
    else if(name==='new-po')newPurchase();
    else if(name==='po')details(id);
    else if(name==='receive-po')receiveDialog(id);
    else if(name==='sp-dispatch')dispatchDialog(id);
    else if(name==='sp-delivery')deliveryDialog(id);
    else if(name==='sp-email')emailOrder(id);
    else if(name==='close-po'){S.busy=true;try{await rpc('close_purchase',{p_order:id});await refresh();render();details(id);}finally{S.busy=false;}}
    else if(name==='sp-next'||name==='sp-prev'){page+=name==='sp-next'?1:-1;await refresh();render();}
    else if(name==='sp-supplier'){selectedSupplier=id;billPage=0;await refresh();render();}
    else if(name==='sp-supplier-back'){selectedSupplier='';render();}
    else if(name==='sp-supplier-new')supplierDialog();
    else if(name==='sp-supplier-edit')supplierDialog(id);
    else if(name==='sp-bills-next'||name==='sp-bills-prev'){billPage+=name==='sp-bills-next'?1:-1;await refresh();render();}
    else if(name==='sp-pay')billDialog(id,true);
    else if(name==='sp-bill')billDialog(id);
    else if(name==='sp-settings')settingsDialog();
    else if(name==='sp-policy')policyDialog(id);
    else if(name==='sp-review')reviewDialog(id);
    else if(name==='sp-retry')await sendPending();
    else if(name==='sp-explain')explain(Number(id));
    else if(name==='sp-mrp-po')draftSuggestion(mrp.rows[Number(id)],'dated MRP shortage');
    else if(name==='sp-reorder-po')draftSuggestion(plan.find(x=>x.id===id),'company-wide forecast review');
  }
  function change(target) {
    if(target.id==='po-supplier')newPurchase(target.value);
    if(target.id==='receive-line')modal.querySelector('[name="quantity"]').max=target.selectedOptions[0].dataset.remaining;
    if(target.id==='mrp-week'){week=target.value;render();}
    if(target.id==='mrp-location'){location=target.value;render();}
  }
  function scan(target) {
    const code=target.value.trim().toLowerCase(),item=S.products.find(x=>x.barcode.toLowerCase()===code||x.sku.toLowerCase()===code);
    const option=item&&modal.querySelector(`#receive-line option[data-product="${item.id}"]`);
    if(!option)throw new Error('This barcode is not an outstanding item on this PO.');
    const select=modal.querySelector('#receive-line');select.value=option.value;change(select);target.value='';modal.querySelector('[name="quantity"]').focus();
  }
  function reset(){tab='orders';error='';orders=[];suppliers=[];cards=[];plan=[];mrp={rows:[]};page=0;more=false;selectedSupplier='';bills=[];billPage=0;pending=null;week='all';location='all';}
  return {refresh,view,mrpView,action,submit,change,scan,reset};
}
