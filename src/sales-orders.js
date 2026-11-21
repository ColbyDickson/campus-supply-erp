import { money, escapeHtml as e, utcDay, cartTotals } from './domain.js';

// Keep sales order behavior separate from the shared application shell.
export function salesOrdersModule({ S, modal, button, options, locationName, load, render, notify }) {
  let orders=[], error='', pending=null, more=false, page=0;
  const key=()=>`campus-pending-order:${S.session.user.id}`;
  const remember=value=>{ pending=value; if(value)localStorage.setItem(key(),JSON.stringify(value));else localStorage.removeItem(key()); };
  async function refresh() {
    pending=JSON.parse(localStorage.getItem(key())||'null');
    const result=await S.client.from('sales_orders').select('*,sales_order_lines(*)').order('created_at',{ascending:false}).order('id').range(page*100,page*100+100);
    error=result.error?.message||'';
    if(!result.error){orders=result.data.slice(0,100);more=result.data.length>100;}
  }
  function view() {
    if(error)return `<section class="panel"><h2>Sales orders are unavailable</h2><p>If this is the first setup, ask the coordinator to apply <strong>supabase/005_sales_orders.sql</strong> after migration 004, then press Refresh. Existing checkout still works.</p><p>${e(error)}</p></section>`;
    return `${pending?`<div class="pending-note">An order is awaiting confirmation. Retry the saved request before creating another. ${button('Retry / confirm order','so-retry','secondary')}</div>`:''}
      <section class="panel"><div class="panel-heading"><div><h2>Sales orders</h2><p>Page ${page+1} · up to 100 orders per page · required dates use UTC.</p></div>${button('＋ New sales order','so-new','primary',pending?'disabled':'')}</div>
      <p class="hint">Placing an order records demand without reserving or deducting stock. Fulfill when all items are handed over: this creates one receipt and records stock, revenue and costs. Payment is simulated.</p>
      <div class="table-wrap"><table><thead><tr><th>ORDER</th><th>CUSTOMER</th><th>LOCATION</th><th>REQUIRED (UTC)</th><th>STATUS</th><th>TOTAL</th><th></th></tr></thead><tbody>${orders.map(o=>`<tr><td class="mono">${e(o.id.slice(0,8))}</td><td>${e(S.customers.find(c=>c.id===o.customer_id)?.name)}</td><td>${e(locationName(o.location_id))}</td><td>${e(o.required_date)}</td><td><span class="badge">${e(o.status)}</span></td><td>${money(o.total)}</td><td>${button('View order',`so-view:${o.id}`,'small-button')}</td></tr>`).join('')||'<tr><td colspan="7" class="empty">No sales orders on this page.</td></tr>'}</tbody></table></div>
      <div class="dialog-actions">${button('Previous page','so-prev','secondary',page?'':'disabled')}${button('Next page','so-next','secondary',more?'':'disabled')}</div></section>`;
  }
  function createDialog() {
    if(pending)throw new Error('Confirm the saved request first.');
    if(!S.customers.length)throw new Error('A customer record is required. Ask the coordinator to add one.');
    modal.innerHTML=`<div class="dialog-heading"><h2>New sales order</h2>${button('×','close','icon-button','aria-label="Close dialog"')}</div>
      <form id="sales-order-form"><label>Customer<select name="customer" required>${options(S.customers,'')}</select></label>
      <label>Pickup location<select name="location" required>${options(S.locations,S.location)}</select></label>
      <label>Required date (UTC)<input name="required" type="date" min="${utcDay()}" value="${utcDay()}" required></label>
      <p class="hint">Enter quantities for the items to order. Stock is checked at fulfillment, not reserved now.</p>
      <div class="table-wrap"><table><thead><tr><th>ITEM</th><th>UNIT PRICE</th><th>QUANTITY</th></tr></thead><tbody>${S.products.map(p=>`<tr><td>${e(p.name)}<small> ${e(p.sku)}</small></td><td>${money(p.price)}</td><td><input name="qty-${p.id}" aria-label="Quantity for ${e(p.name)}" type="number" min="0" max="10000" step="1" value="0"></td></tr>`).join('')}</tbody></table></div>
      <label>Discount amount ($)<input name="discount" type="number" min="0" step="0.01" value="0" required></label>
      <p id="order-estimate" class="hint" aria-live="polite">Choose items to see the estimated total.</p>
      <button class="primary wide">Place sales order</button><p class="hint">The database saves the final prices and tax. No payment is collected now.</p></form>`;
    modal.showModal();
  }
  function estimate(form) {
    const data=new FormData(form);
    const items=S.products.map(p=>({product_id:p.id,quantity:Number(data.get(`qty-${p.id}`))})).filter(l=>l.quantity>0);
    const t=cartTotals(items,S.products,Number(data.get('discount')),S.settings.tax_rate);
    form.querySelector('#order-estimate').textContent=`Estimate: subtotal ${money(t.subtotal)} − discount ${money(t.discount)} + tax ${money(t.tax)} = ${money(t.total)}. Database confirms on save.`;
  }
  function details(id) {
    const o=orders.find(o=>o.id===id);
    if(!o)throw new Error('Order is no longer on this page. Refresh the list.');
    const document=`<div class="receipt"><p class="eyebrow">CAMPUS SUPPLY CO. · SALES ORDER</p><h2>${e(S.customers.find(c=>c.id===o.customer_id)?.name)}</h2>
      <p class="mono">Order ${e(o.id)}</p><p>${e(locationName(o.location_id))} · Required ${e(o.required_date)} UTC<br>Status: ${e(o.status)}</p>
      ${o.sales_order_lines.map(l=>`<div class="receipt-line"><div><strong>${e(l.product_name)}</strong><small>${e(l.sku)} · ${l.quantity} × ${money(l.unit_price)}</small></div><strong>${money(l.quantity*Number(l.unit_price))}</strong></div>`).join('')}
      <hr><div class="totals"><div><span>Subtotal</span><span>${money(o.subtotal)}</span></div><div><span>Discount</span><span>−${money(o.discount)}</span></div><div><span>Tax (${(Number(o.tax_rate)*100).toFixed(2)}%)</span><span>${money(o.tax)}</span></div><div class="grand-total"><span>Total</span><span>${money(o.total)}</span></div></div>
      ${o.fulfilled_at?`<p>Fulfilled ${e(o.fulfilled_at)}<br>Receipt ${e(o.sale_id)}</p>`:''}
      ${o.closed_at?`<p>Closed ${e(o.closed_at)}</p>`:''}${o.cancelled_at?`<p>Cancelled ${e(o.cancelled_at)}</p>`:''}
      <p class="hint">${o.status==='Order Placed'?'No stock is reserved. Fulfill all lines together when handed over. Prices and tax above are fixed; product costs are recorded at fulfillment.':'Fulfillment records stock and financial effects once; closing only ends the workflow. Cancelled orders have no financial effect.'} Class simulation; no card processing.</p></div>`;
    modal.innerHTML=`${document}<div class="dialog-actions">${o.status==='Order Placed'?`${button('Fulfill order',`so-fulfill:${id}`,'primary')}${button('Cancel order',`so-cancel:${id}`,'secondary')}`:''}${o.status==='Fulfilled'?button('Close order',`so-close:${id}`,'primary'):''}${o.sale_id?button('View receipt',`receipt:${o.sale_id}`,'secondary'):''}${button('Print order','print-receipt','secondary')}${button('Done','close','secondary')}</div>`;
    modal.dataset.receipt=document;if(!modal.open)modal.showModal();
  }
  async function sendPending() {
    if(!pending)return;
    S.busy=true;
    try {
      const {data:id,error:err}=await S.client.rpc('create_sales_order',pending);
      if(err){if(err.code&&/^(P0001|22...|23...)$/.test(err.code))remember(null);throw err;}
      remember(null);modal.close();page=0;await refresh();render();
      if(orders.some(o=>o.id===id))details(id);
      notify('Order placed. Stock and financials change when it is fulfilled.');
    } finally { S.busy=false;render(); }
  }
  async function submit(form) {
    const data=new FormData(form);
    const items=S.products.map(p=>({product_id:p.id,quantity:Number(data.get(`qty-${p.id}`))}));
    if(items.some(l=>!Number.isInteger(l.quantity)||l.quantity<0||l.quantity>10000))throw new Error('Enter whole-number quantities from 0 to 10000.');
    const selected=items.filter(l=>l.quantity>0),discount=Number(data.get('discount'));
    if(!selected.length)throw new Error('Enter a quantity for at least one item.');
    if(!Number.isFinite(discount)||discount<0||discount>cartTotals(selected,S.products,0,0).subtotal)throw new Error('Discount must be between zero and the subtotal.');
    remember({p_id:crypto.randomUUID(),p_customer:data.get('customer'),p_location:data.get('location'),p_required_date:data.get('required'),p_items:selected,p_discount:discount});
    // Close the editable draft; all retries send the same persisted request.
    modal.close();render();await sendPending();
  }
  async function action(name,id) {
    if(name==='so-new')createDialog();
    else if(name==='so-view')details(id);
    else if(name==='so-retry')await sendPending();
    else if(name==='so-next'||name==='so-prev'){page+=name==='so-next'?1:-1;await refresh();render();}
    else if(['so-fulfill','so-close','so-cancel'].includes(name)){
      S.busy=true;
      try {
        const {error:err}=await S.client.rpc('transition_sales_order',{p_order:id,p_status:{'so-fulfill':'Fulfilled','so-close':'Closed','so-cancel':'Cancelled'}[name]});
        if(err)throw err;
        await load();await refresh();render();details(id);notify('Order updated. Repeated requests will not create a second sale.');
      }finally{S.busy=false;}
    }
  }
  function reset(){orders=[];pending=null;error='';page=0;more=false;}
  return { refresh, view, submit, action, estimate, reset };
}
