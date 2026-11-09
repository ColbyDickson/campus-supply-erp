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

test('login, navigation, barcode checkout, receipt, adjustment, transfer, and reports interact correctly',async()=>{
  const {window:w,code}=await openApp();
  const p='11111111-1111-4111-8111-111111111111',l='22222222-2222-4222-8222-222222222222',other='33333333-3333-4333-8333-333333333333';
  const user={id:'44444444-4444-4444-8444-444444444444',email:'teammate@example.com',aud:'authenticated',role:'authenticated'};
  const supplier='55555555-5555-4555-8555-555555555555';
  const products=[{id:p,name:'Blue ballpoint pen',sku:'PEN',barcode:'CS00001',category:'Writing',supplier_id:supplier,price:1,standard_cost:0.35,reorder_point:5,lead_days:4,is_kit:false}];
  const rows={products,suppliers:[{id:supplier,name:'Test writing supplier',email:'orders@example.com',phone:'801-555-0100',quoted_lead_days:4,payment_term_days:30}],purchase_orders:[],locations:[{id:l,name:'Storefront'},{id:other,name:'Stockroom'}],stock:[{product_id:p,location_id:l,quantity:10,average_cost:0.35},{product_id:p,location_id:other,quantity:5,average_cost:0.35}],customers:[],settings:{tax_rate:0.0725},sales:[],movements:[]};
  let checkoutCalls=0, printed=0;
  w.print=()=>{printed++;};
  class NoNetworkWebSocket {static OPEN=1;static CLOSED=3;constructor(){this.readyState=0;}addEventListener(){}removeEventListener(){}send(){}close(){this.readyState=3;}}
  w.WebSocket=NoNetworkWebSocket;
  w.fetch=async(input,init={})=>{
    const url=new URL(typeof input==='string'?input:input.url),path=url.pathname;
    let result;
    const data=init.body?JSON.parse(init.body):{};
    if(path==='/auth/v1/token'){
      const payload={sub:user.id,role:'authenticated',exp:Math.floor(Date.now()/1000)+3600};
      result={access_token:`${btoa('{}')}.${btoa(JSON.stringify(payload))}.signature`,refresh_token:'test-refresh',expires_in:3600,token_type:'bearer',user};
    }else if(path==='/auth/v1/user')result={user};
    else if(path.endsWith('/rpc/is_staff'))result=true;
    else if(path.endsWith('/rpc/financial_report'))result={net_sales:20,cogs:7,gross_profit:13,operating_profit:13,inventory_adjustment_expense:0,current_inventory:5.25,opening_inventory:10,closing_inventory:5.25,turnover:0.918};
    else if(path.endsWith('/rpc/sales_summary'))result={receipt_count:2,daily_sales:[{day:'2026-11-08',revenue:20}],top_items:[{name:'Blue ballpoint pen',sku:'PEN',units:20,sales:20}]};
    else if(path.endsWith('/rpc/create_purchase_order')){
      rows.purchase_orders.unshift({id:data.p_id,supplier_id:data.p_supplier,sent_at:new Date().toISOString(),status:'Order Sent',quoted_lead_days:4,payment_term_days:30,expected_date:'2026-11-13',purchase_lines:data.p_items.map(x=>({...x,id:'66666666-6666-4666-8666-666666666666',received:0,purchase_receipts:[]}))});result=data.p_id;
    }else if(path.endsWith('/rpc/receive_purchase')){
      const po=rows.purchase_orders[0],line=po.purchase_lines[0];line.received+=data.p_quantity;rows.stock[0].quantity+=data.p_quantity;
      line.purchase_receipts.push({id:data.p_id,location_id:data.p_location,quantity:data.p_quantity,received_at:new Date().toISOString()});if(line.received===line.quantity)po.status='Received';result=data.p_id;
    }else if(path.endsWith('/rpc/close_purchase')){rows.purchase_orders[0].status='Closed';result=null;}
    else if(path.endsWith('/rpc/checkout')){
      checkoutCalls++;rows.stock[0].quantity-=data.p_items[0].quantity;
      const sale={id:data.p_request_id,location_id:l,created_at:new Date().toISOString(),subtotal:1,discount:0,tax:0.07,total:1.07,cogs:0.35,sale_lines:[{product_id:p,quantity:1,unit_price:1,unit_cost:0.35,products:products[0]}]};
      rows.sales.unshift(sale);result=sale.id;
    }else if(path.endsWith('/rpc/adjust_stock')){rows.stock[0].quantity+=data.p_delta;result=null;}
    else if(path.endsWith('/rpc/transfer_stock')){rows.stock[0].quantity-=data.p_quantity;rows.stock[1].quantity+=data.p_quantity;result=null;}
    else if(path.startsWith('/rest/v1/')){
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
    await waitFor(()=>w.document.querySelector('[data-act^="receive-po:"]'));
    const po=rows.purchase_orders[0];click(w,`receive-po:${po.id}`);
    const receiveScan=w.document.querySelector('#receive-scan');receiveScan.value='CS00001';receiveScan.dispatchEvent(new w.KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}));
    w.document.querySelector('#receive-form [name="quantity"]').value='2';submit(w,'#receive-form');
    await waitFor(()=>!w.document.querySelector('#modal').open&&w.document.querySelector('.page').textContent.includes('Received'));
    assert.equal(rows.stock[0].quantity,8);click(w,`po:${po.id}`);click(w,`close-po:${po.id}`);
    await waitFor(()=>w.document.querySelector('#modal').textContent.includes('Closed'));assert.equal(po.status,'Closed');click(w,'close');
    click(w,'nav:guide');assert.match(w.document.querySelector('.page').textContent,/To build/);
  }catch(error){
    console.error('UI failure notice:',w.document.querySelector('#notice')?.textContent);
    console.error('UI failure stage:',w.document.querySelector('h1')?.textContent,w.document.querySelector('#modal')?.innerHTML.slice(0,200));
    throw error;
  }finally{await new Promise(r=>setTimeout(r,50));await w.happyDOM.close();}
});
