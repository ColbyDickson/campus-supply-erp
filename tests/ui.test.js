// DOM interaction checks using a fake transport; these do not replace a live
// Supabase / physical scanner / real-browser check. No preview server is used.
import { Window } from 'happy-dom';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import assert from 'node:assert/strict';

async function openApp() {
  // Only evaluate the application bundle built from this checkout, never third-party input.
  const window = new Window({url:'https://erp.example.com/campus-supply-erp/',settings:{enableJavaScriptEvaluation:true,disableCSSFileLoading:true,suppressInsecureJavaScriptEnvironmentWarning:true}});
  // Happy DOM does not render canvas text. Supply measurement only for
  // JsBarcode's SVG generator; real label layout remains a manual check.
  window.HTMLCanvasElement.prototype.getContext = () => ({font:'',measureText:text=>({width:text.length*8})});
  window.document.body.innerHTML='<div id="app"></div><div id="notice"></div><dialog id="modal"></dialog><div id="print-area"></div>';
  const dir=new URL('../docs/assets/',import.meta.url);
  const js=(await readdir(dir)).find(x=>x.endsWith('.js'));
  return {window,code:await readFile(new URL(js,dir),'utf8')};
}
async function waitFor(fn) {
  for(let i=0;i<100;i++){if(fn())return;await new Promise(r=>setTimeout(r,20));}
  assert.fail('UI did not reach the expected state');
}
const submit=(w,id)=>w.document.querySelector(id).dispatchEvent(new w.Event('submit',{bubbles:true,cancelable:true}));
const click=(w,act)=>{const el=w.document.querySelector(`[data-act="${act}"]`);assert.ok(el,`Missing action ${act}`);el.click();};

test('connection form rejects secret keys without saving them',async()=>{
  const {window:w,code}=await openApp();
  try {
    w.eval(code);
    w.document.querySelector('[name="url"]').value='https://demo.supabase.co';
    w.document.querySelector('[name="key"]').value='sb_secret_do_not_store';
    submit(w,'#connection-form');
    await waitFor(()=>w.document.querySelector('#notice').textContent.includes('Never enter'));
    assert.equal(w.localStorage.getItem('campus-connection'),null);
  }finally{await w.happyDOM.close();}
});

test('POS, inventory, purchasing and sales orders interact correctly, including order retries and setup errors',async()=>{
  const {window:w,code}=await openApp();
  const p='11111111-1111-4111-8111-111111111111',l='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
  const user={id:'44444444-4444-4444-8444-444444444444',email:'teammate@example.com',aud:'authenticated',role:'authenticated'};
  const supplier='55555555-5555-4555-8555-555555555555';
  const products=[{id:p,name:'Blue ballpoint pen',sku:'PEN',barcode:'CS00001',category:'Writing',supplier_id:supplier,price:1,standard_cost:0.35,reorder_point:5,lead_days:4,is_kit:false}];
  const rows={products,suppliers:[{id:supplier,name:'Test writing supplier',email:'orders@example.com',phone:'801-555-0100',quoted_lead_days:4,payment_term_days:30}],purchase_orders:[],locations:[{id:l,name:'Storefront'},{id:other,name:'Stockroom'}],stock:[{product_id:p,location_id:l,quantity:10,average_cost:0.35},{product_id:p,location_id:other,quantity:5,average_cost:0.35}],customers:[{id:'77777777-7777-4777-8777-777777777777',name:'Test customer'}],sales_orders:[],settings:{tax_rate:0.0725,ordering_cost:25,annual_holding_rate:0.25},sales:[],movements:[]};
  let checkoutCalls=0, printed=0, orderCalls=0, orderRequest, failFulfill=true, orderUnavailable=false, planningUnavailable=false,reviewed=false;
  const payments=[];
  const mockPlan=()=>[{...products[0],safety_stock:2,review_days:7,daily_usage:3,annual_demand:1095,unit_cost:.35,holding_cost:.0875,ordering_cost:rows.settings.ordering_cost,holding_rate:rows.settings.annual_holding_rate,on_hand:rows.stock.reduce((n,x)=>n+x.quantity,0),incoming:0,inventory_position:13,reorder_point:14,eoq:791,suggested_quantity:791,order_by:'2026-11-25',last_reviewed:reviewed?new Date().toISOString():null,last_decision:reviewed?'Defer':null,review_due:'2026-11-30',history_from:'2026-05-23',history_through:'2026-11-22',history_days:184}];
  const mockBills=()=>rows.purchase_orders.flatMap(po=>po.purchase_lines.flatMap(line=>line.purchase_receipts.map(r=>({...r,po_id:po.id,source:'manual',product:products[0].name,unit_cost:line.unit_cost,amount:r.quantity*line.unit_cost,paid:payments.filter(x=>x.id===r.id).reduce((n,x)=>n+x.amount,0),outstanding:r.quantity*line.unit_cost-payments.filter(x=>x.id===r.id).reduce((n,x)=>n+x.amount,0),payments:payments.filter(x=>x.id===r.id)}))));
  w.print=()=>{printed++;};
  class NoNetworkWebSocket {static OPEN=1;static CLOSED=3;constructor(){this.readyState=0;}addEventListener(){}removeEventListener(){}send(){}close(){this.readyState=3;}}
  w.WebSocket=NoNetworkWebSocket;
  w.fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input.url),path=url.pathname;
    let result;
    const data=init.body?JSON.parse(init.body):{};
    if(planningUnavailable&&['replenishment_plan','mrp_plan','supplier_scorecards'].some(x=>path.endsWith('/rpc/'+x)))return new w.Response(JSON.stringify({code:'PGRST202',message:'Planning migration not applied'}),{status:404,headers:{'content-type':'application/json'}});
    if(path==='/auth/v1/token'){
      const payload={sub:user.id,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600};
      result={access_token:`${btoa('{}')}.${btoa(JSON.stringify(payload))}.signature`,refresh_token:'test-refresh',expires_in:3600,token_type:'bearer',user};
    }else if(path==='/auth/v1/user')result={user};
    else if(path.endsWith('/rpc/is_staff'))result=true;
    else if(path.endsWith('/rpc/financial_report'))result={net_sales:20,cogs:7,gross_profit:13,operating_profit:13,inventory_adjustment_expense:0,current_inventory:5.25,opening_inventory:10,closing_inventory:5.25,turnover:0.918};
    else if(path.endsWith('/rpc/sales_summary'))result={receipt_count:2,daily_sales:[{day:'2026-11-08',revenue:20}],top_items:[{name:'Blue ballpoint pen',sku:'PEN',units:20,sales:20}]};
    else if(path.endsWith('/rpc/replenishment_plan'))result=mockPlan();
    else if(path.endsWith('/rpc/supplier_scorecards'))result=rows.suppliers.map(s=>({...s,orders:rows.purchase_orders.length,eligible_orders:1,sample_orders:0,on_time_rate:1,fill_rate:1,actual_days:4,quoted_days:4,owed:mockBills().reduce((n,b)=>n+b.outstanding,0),overdue:0,rating:'Keep'}));
    else if(path.endsWith('/rpc/supplier_bills'))result=mockBills();
    else if(path.endsWith('/rpc/mrp_plan'))result={as_of:'2026-11-23',through:'2026-12-20',confirmed_orders:1,bom_parents:5,firm_build_units:0,unassigned_incoming:0,overdue_incoming:0,missing_boms:0,rows:[{product_id:p,name:products[0].name,sku:'PEN',supplier_id:supplier,location_id:l,action:'Buy',week:1,event_date:'2026-11-27',required_date:'2026-11-27',gross:20,opening:8,incoming:0,suggested_quantity:12,lead_days:4,order_by:'2026-11-23',late:false,explanation:'Sales orders test demand',other_location_stock:7}]};
    else if(path.endsWith('/rpc/save_supplier')){Object.assign(rows.suppliers[0],{name:data.p_name,email:data.p_email,phone:data.p_phone,quoted_lead_days:data.p_lead,payment_term_days:data.p_terms});result=data.p_id;}
    else if(path.endsWith('/rpc/save_ordering_settings')){rows.settings.ordering_cost=data.p_ordering;rows.settings.annual_holding_rate=data.p_holding;result=null;}
    else if(path.endsWith('/rpc/review_planning_item')){reviewed=true;result=data.p_id;}
    else if(path.endsWith('/rpc/save_item_policy')){assert.equal(data.p_safety,3);result=null;}
    else if(path.endsWith('/rpc/record_supplier_payment')){payments.push({id:data.p_receipt,amount:data.p_amount,paid_on:data.p_paid,reference:data.p_reference});result=data.p_id;}
    else if(path.endsWith('/rpc/create_sales_order')){
      orderCalls++;
      if(!orderRequest){
        orderRequest=data;
        rows.sales_orders.unshift({id:data.p_id,customer_id:data.p_customer,location_id:data.p_location,required_date:data.p_required_date,status:'Order Placed',created_at:new Date().toISOString(),subtotal:2,discount:0,tax_rate:0.0725,tax:0.15,total:2.15,sales_order_lines:data.p_items.map(x=>({...x,unit_price:1,product_name:products[0].name,sku:'PEN'}))});
        return new w.Response(JSON.stringify({message:'Simulated lost response'}),{status:503,headers:{'content-type':'application/json'}});
      }
      assert.deepEqual(data,orderRequest);result=data.p_id;
    }else if(path.endsWith('/rpc/transition_sales_order')){
      if(data.p_status==='Fulfilled'&&failFulfill){failFulfill=false;return new w.Response(JSON.stringify({code:'P0001',message:'Insufficient stock (simulated)'}),{status:400,headers:{'content-type':'application/json'}});}
      const order=rows.sales_orders[0];order.status=data.p_status;
      if(data.p_status==='Fulfilled'){
        order.sale_id=order.id;order.fulfilled_at=new Date().toISOString();rows.stock[0].quantity-=2;
        rows.sales.unshift({id:order.id,location_id:l,created_at:order.fulfilled_at,subtotal:2,discount:0,tax:0.15,total:2.15,cogs:0.7,sale_lines:[{quantity:2,unit_price:1,products:products[0]}]});
      }result=order.id;
    }else if(path.endsWith('/rpc/create_purchase_draft')){
      rows.purchase_orders.unshift({id:data.p_id,supplier_id:data.p_supplier,delivery_location_id:data.p_location,sent_at:null,status:'Draft',source:'manual',quoted_lead_days:4,payment_term_days:30,expected_date:null,purchase_lines:data.p_items.map(x=>({...x,id:'66666666-6666-4666-8666-666666666666',received:0,cancelled_quantity:0,purchase_receipts:[]}))});result=data.p_id;
    }else if(path.endsWith('/rpc/dispatch_purchase')){
      Object.assign(rows.purchase_orders[0],{sent_at:new Date().toISOString(),status:'Order Sent',expected_date:'2026-11-27',dispatch_method:data.p_method,dispatch_reference:data.p_reference});result=null;
    }else if(path.endsWith('/rpc/receive_purchase')){
      const po=rows.purchase_orders[0],line=po.purchase_lines[0];line.received+=data.p_quantity;rows.stock[0].quantity+=data.p_quantity;
      line.purchase_receipts.push({id:data.p_id,location_id:data.p_location,quantity:data.p_quantity,received_at:new Date().toISOString(),unit_cost:line.unit_cost,due_date:'2026-12-23'});if(line.received===line.quantity)po.status='Received';result=data.p_id;
    }else if(path.endsWith('/rpc/close_purchase')){rows.purchase_orders[0].status='Closed';result=null;}
    else if(path.endsWith('/rpc/checkout')){
      checkoutCalls++;rows.stock[0].quantity-=data.p_items[0].quantity;
      const sale={id:data.p_request_id,location_id:l,created_at:new Date().toISOString(),subtotal:1,discount:0,tax:0.07,total:1.07,cogs:0.35,sale_lines:[{product_id:p,quantity:1,unit_price:1,unit_cost:0.35,products:products[0]}]};
      rows.sales.unshift(sale);result=sale.id;
    }else if(path.endsWith('/rpc/adjust_stock')){rows.stock[0].quantity+=data.p_delta;result=null;}
    else if(path.endsWith('/rpc/transfer_stock')){rows.stock[0].quantity-=data.p_quantity;rows.stock[1].quantity+=data.p_quantity;result=null;}
    else if(path.startsWith('/rest/v1/')){
      if(path.endsWith('/sales_orders')&&orderUnavailable)return new w.Response(JSON.stringify({message:'Sales orders table not found'}),{status:404,headers:{'content-type':'application/json'}});
      result=rows[path.split('/').pop()];
      if(path.endsWith('/sales')&&url.searchParams.has('id'))result=rows.sales[0];
      if(result===undefined)throw new Error(`Unhandled mock table: ${path}`);
    }else throw new Error(`Unhandled mock request: ${path}`);
    return new w.Response(JSON.stringify(result),{status:200,headers:{'content-type':'application/json'}});
  };
  w.localStorage.setItem('campus-connection',JSON.stringify({url:'https://demo.supabase.co',key:'sb_publishable_mock'}));
  try {
    w.eval(code);await waitFor(()=>w.document.querySelector('#login-form'));
    w.document.querySelector('[name="email"]').value=user.email;
    w.document.querySelector('[name="password"]').value='fake-test-password';submit(w,'#login-form');
    await waitFor(()=>w.document.querySelector('.metrics'));
    assert.match(w.document.querySelector('h1').textContent,/Business overview/);
    click(w,'nav:checkout');
    const scan=w.document.querySelector('#pos-search');scan.value='CS00001';scan.dispatchEvent(new w.Event('input',{bubbles:true}));
    w.document.querySelector('#pos-search').dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    assert.match(w.document.querySelector('.cart-lines').textContent,/Blue ballpoint pen/);
    submit(w,'#sale-form');await waitFor(()=>w.document.querySelector('.receipt')&&w.document.querySelector('#sale-form fieldset:not([disabled])'));
    assert.equal(checkoutCalls,1);assert.equal(rows.stock[0].quantity,9);
    assert.match(w.document.querySelector('.receipt').textContent,/\$1\.07/);
    click(w,'print-receipt');assert.equal(printed,1);click(w,'close');
    click(w,'nav:inventory');click(w,`adjust:${p}`);
    w.document.querySelector('[name="quantity"]').value='-1';
    w.document.querySelector('[name="note"]').value='Broken pen';submit(w,'#inventory-form');
    await waitFor(()=>!w.document.querySelector('#modal').open&&w.document.querySelector('.stock-number')?.textContent==='8');assert.equal(rows.stock[0].quantity,8);
    click(w,`transfer:${p}`);w.document.querySelector('[name="quantity"]').value='2';
    w.document.querySelector('[name="note"]').value='Move to stockroom';submit(w,'#inventory-form');
    await waitFor(()=>!w.document.querySelector('#modal').open&&w.document.querySelector('.stock-number')?.textContent==='6');assert.equal(rows.stock[0].quantity,6);assert.equal(rows.stock[1].quantity,7);
    click(w,'labels');await waitFor(()=>w.document.querySelector('[data-barcode] rect'));click(w,'print-labels');assert.equal(printed,2);click(w,'close');
    click(w,'nav:reports');assert.match(w.document.querySelector('h1').textContent,/Financial reports/);
    assert.match(w.document.querySelector('.pnl').textContent,/\$13\.00/);
    click(w,'nav:purchasing');await waitFor(()=>w.document.querySelector('[data-act="new-po"]'));
    click(w,'new-po');w.document.querySelector(`[name="qty-${p}"]`).value='2';submit(w,'#po-form');
    await waitFor(()=>w.document.querySelector('[data-act^="sp-dispatch:"]'));
    const po=rows.purchase_orders[0];assert.equal(po.status,'Draft');click(w,`sp-dispatch:${po.id}`);
    w.document.querySelector('#sp-dispatch-form [name="reference"]').value='Shared printed PO';submit(w,'#sp-dispatch-form');
    await waitFor(()=>!w.document.querySelector('#modal').open&&po.status==='Order Sent');click(w,`po:${po.id}`);click(w,`receive-po:${po.id}`);
    const receiveScan=w.document.querySelector('#receive-scan');receiveScan.value='CS00001';receiveScan.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    w.document.querySelector('#receive-form [name="quantity"]').value='2';submit(w,'#receive-form');
    await waitFor(()=>!w.document.querySelector('#modal').open&&w.document.querySelector('.page').textContent.includes('Received'));
    assert.equal(rows.stock[0].quantity,8);click(w,`po:${po.id}`);click(w,`close-po:${po.id}`);
    await waitFor(()=>w.document.querySelector('#modal').textContent.includes('Closed'));assert.equal(po.status,'Closed');click(w,'close');
    click(w,'sp-tab:suppliers');await waitFor(()=>w.document.querySelector(`[data-act="sp-supplier:${supplier}"]`));click(w,`sp-supplier:${supplier}`);
    await waitFor(()=>w.document.querySelector('[data-act^="sp-pay:"]'));const bill=mockBills()[0];click(w,`sp-pay:${bill.id}`);
    w.document.querySelector('#sp-payment-form [name="amount"]').value='0.35';w.document.querySelector('#sp-payment-form [name="reference"]').value='Payment test';submit(w,'#sp-payment-form');
    await waitFor(()=>!w.document.querySelector('#modal').open&&payments.length===1);assert.equal(mockBills()[0].outstanding,.35);
    click(w,`sp-supplier-edit:${supplier}`);w.document.querySelector('#sp-supplier-form [name="name"]').value='Updated supplier';submit(w,'#sp-supplier-form');
    await waitFor(()=>!w.document.querySelector('#modal').open&&w.document.querySelector('.page').textContent.includes('Updated supplier'));
    click(w,'sp-tab:reorder');await waitFor(()=>w.document.querySelector('[data-act="sp-settings"]'));click(w,'sp-settings');
    w.document.querySelector('#sp-settings-form [name="holding"]').value='30';submit(w,'#sp-settings-form');await waitFor(()=>!w.document.querySelector('#modal').open&&rows.settings.annual_holding_rate===.3);
    click(w,`sp-review:${p}`);w.document.querySelector('#sp-review-form [name="decision"]').value='Defer';w.document.querySelector('#sp-review-form [name="note"]').value='Transfer first';submit(w,'#sp-review-form');await waitFor(()=>!w.document.querySelector('#modal').open&&reviewed);
    click(w,`sp-policy:${p}`);w.document.querySelector('#sp-policy-form [name="safety"]').value='3';submit(w,'#sp-policy-form');await waitFor(()=>!w.document.querySelector('#modal').open);
    click(w,'nav:mrp');await waitFor(()=>w.document.querySelector('[data-act="sp-explain:0"]'));click(w,'sp-explain:0');assert.match(w.document.querySelector('#modal').textContent,/Sales orders test demand/);click(w,'close');
    click(w,'sp-mrp-po:0');assert.equal(w.document.querySelector(`[name="qty-${p}"]`).value,'12');click(w,'close');
    click(w,'nav:orders');await waitFor(()=>w.document.querySelector('[data-act="so-new"]'));
    click(w,'so-new');w.document.querySelector(`#sales-order-form [name="qty-${p}"]`).value='2';
    w.document.querySelector(`#sales-order-form [name="qty-${p}"]`).dispatchEvent(new w.Event('input',{bubbles:true}));
    assert.match(w.document.querySelector('#order-estimate').textContent,/2.15/);
    submit(w,'#sales-order-form');await waitFor(()=>w.document.querySelector('#notice').textContent.includes('Simulated lost response'));
    assert.ok(w.localStorage.getItem(`campus-pending-order:${user.id}`));assert.equal(rows.stock[0].quantity,8);
    assert.ok(w.document.querySelector('[data-act="so-new"]').disabled);
    click(w,'so-retry');await waitFor(()=>w.document.querySelector('[data-act^="so-fulfill:"]'));
    assert.equal(orderCalls,2);assert.equal(rows.sales_orders.length,1);assert.equal(w.localStorage.getItem(`campus-pending-order:${user.id}`),null);
    const order=rows.sales_orders[0];click(w,`so-fulfill:${order.id}`);
    await waitFor(()=>w.document.querySelector('#notice').textContent.includes('Insufficient stock'));
    assert.equal(order.status,'Order Placed');assert.equal(rows.stock[0].quantity,8);
    click(w,`so-fulfill:${order.id}`);await waitFor(()=>w.document.querySelector('[data-act^="so-close:"]'));
    assert.equal(rows.stock[0].quantity,6);click(w,`receipt:${order.id}`);await waitFor(()=>w.document.querySelector('.receipt')?.textContent.includes('Thanks for stopping'));
    assert.match(w.document.querySelector('.receipt').textContent,/2.15/);click(w,'close');click(w,`so-view:${order.id}`);click(w,`so-close:${order.id}`);
    await waitFor(()=>w.document.querySelector('#modal').textContent.includes('Status: Closed'));assert.equal(rows.stock[0].quantity,6);click(w,'close');
    orderUnavailable=true;click(w,'refresh');await waitFor(()=>w.document.querySelector('.page').textContent.includes('005_sales_orders.sql'));
    click(w,'nav:checkout');assert.ok(w.document.querySelector('#sale-form'));
    click(w,'nav:guide');assert.match(w.document.querySelector('.page').textContent,/To build/);
    planningUnavailable=true;click(w,'nav:mrp');await waitFor(()=>w.document.querySelector('.page').textContent.includes('006_supplier_planning_mrp.sql'));click(w,'nav:checkout');assert.ok(w.document.querySelector('#sale-form'));
  }catch(error){
    console.error('UI failure notice:',w.document.querySelector('#notice')?.textContent);
    console.error('UI failure stage:',w.document.querySelector('h1')?.textContent,w.document.querySelector('#modal')?.innerHTML.slice(0,200));
    throw error;
  }finally{await new Promise(r=>setTimeout(r,50));await w.happyDOM.close();}
});
