import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID as uuid } from 'node:crypto';

let db;
const actor=uuid(),supplier=uuid(),supplier2=uuid(),loc=uuid(),other=uuid(),component=uuid(),kit=uuid(),customer=uuid();
const sqlFile=async name=>readFile(new URL(`../supabase/${name}`,import.meta.url),'utf8');
const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
const one=async(sql,args=[]) => (await q(sql,args))[0];
const rpc=async(name,args=[]) => (await one(`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) value`,args)).value;
const bad=async(sql,args=[],pattern)=>{await db.exec('savepoint invalid');try{await assert.rejects(q(sql,args),pattern);}finally{await db.exec('rollback to invalid;release invalid');}};
const order=async(product,qty,days=7,location=loc)=>{
  const id=uuid();await q('select create_sales_order($1,$2,$3,current_date+$4::integer,$5::jsonb,0)',[id,customer,location,days,JSON.stringify([{product_id:product,quantity:qty}])]);return id;
};
const po=async(qty=3,days=4)=>{
  const id=uuid();await rpc('create_purchase_draft',[id,supplier,loc,JSON.stringify([{product_id:component,quantity:qty,unit_cost:1}])]);
  await rpc('dispatch_purchase',[id,'Manual','Test order sent']);
  await q('update purchase_orders set expected_date=current_date+$2::integer where id=$1',[id,days]);
  return {id,line:(await one('select id from purchase_lines where purchase_order_id=$1',[id])).id};
};
before(async()=>{
  db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to anon,authenticated;`);
  for(const f of ['001_schema.sql','004_purchasing.sql','005_sales_orders.sql','006_supplier_planning_mrp.sql'])await db.exec(await sqlFile(f));
  await q('insert into auth.users values($1)',[actor]);await q("insert into team_members values($1,'Planner')",[actor]);
  await q("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
  await q("insert into suppliers values($1,'Supplier One','one@example.com','555-0101',3,30),($2,'Supplier Two','two@example.com','555-0102',8,15)",[supplier,supplier2]);
  await q("insert into locations values($1,'Store'),($2,'Warehouse')",[loc,other]);
  await q("insert into customers values($1,'Customer','customer@example.com')",[customer]);
  await db.exec('insert into settings values(true,0.10,25,0.25,\'USD\',false)');
  await q("insert into products(id,sku,barcode,name,category,supplier_id,standard_cost,price,reorder_point,lead_days,is_kit) values($1,'COMP','COMP','Component','Supplies',$3,1,2,5,3,false),($2,'KIT','KIT','Kit','Kits',null,2,6,3,2,true)",[component,kit,supplier]);
  await q('insert into bom values($1,$2,2)',[kit,component]);
  await q('insert into stock values($1,$3,8,1),($1,$4,30,1),($2,$3,3,2),($2,$4,2,2)',[component,kit,loc,other]);
  await db.exec("insert into movements(product_id,location_id,quantity,unit_cost,reason,note,created_at) select product_id,location_id,quantity,average_cost,'OPENING','Test opening',now()-interval '7 months' from stock");
});
after(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec('begin');});
afterEach(async()=>{await db.exec('rollback');});

test('planning APIs compile and empty demand produces no invented shortages',async()=>{
  assert.deepEqual((await rpc('mrp_plan')).rows,[]);
  assert.equal((await rpc('replenishment_plan')).length,2);
  assert.equal((await rpc('supplier_scorecards'))[0].rating,'No history');
});
test('draft is excluded from MRP; dispatch snapshots terms and original expected date',async()=>{
  const id=uuid(),items=JSON.stringify([{product_id:component,quantity:5,unit_cost:1}]);
  await rpc('create_purchase_draft',[id,supplier,loc,items]);await rpc('create_purchase_draft',[id,supplier,loc,items]);
  assert.equal((await one('select status,sent_at from purchase_orders where id=$1',[id])).sent_at,null);
  await order(component,12,7);
  assert.equal((await rpc('mrp_plan')).rows[0].suggested_quantity,4);
  await rpc('dispatch_purchase',[id,'Email','Sent using email client']);
  assert.equal((await rpc('mrp_plan')).rows[0].suggested_quantity,0);
  const row=await one('select * from purchase_orders where id=$1',[id]);assert.equal(row.quoted_lead_days,3);assert.equal(row.payment_term_days,30);
  await rpc('save_supplier',[supplier,'Supplier changed','one@example.com','555-0101',10,15]);
  assert.equal((await one('select * from purchase_orders where id=$1',[id])).quoted_lead_days,3);
  assert.equal((await one('select lead_days from products where id=$1',[component])).lead_days,10);
});
test('MRP nets finished kits then explodes only required builds and dates component purchases',async()=>{
  await order(kit,10,7);await po(3,4);
  const before=await q('select * from stock order by product_id,location_id'),plan=await rpc('mrp_plan');
  const make=plan.rows.find(r=>r.action==='Make'),buy=plan.rows.find(r=>r.action==='Buy');
  assert.equal(make.suggested_quantity,7);assert.equal(buy.gross,14);assert.equal(buy.suggested_quantity,3);
  assert.equal(buy.opening,11);assert.equal(buy.other_location_stock,30);
  const day=(await one('select (current_date+5)::text need,(current_date+2)::text by')).need;
  assert.equal(buy.required_date,day);assert.equal(buy.order_by,(await one('select (current_date+2)::text d')).d);
  assert.deepEqual(await q('select * from stock order by product_id,location_id'),before);
});
test('MRP consumes stock and PO supply only once across competing requirements',async()=>{
  await order(component,8,2);await order(kit,10,7);await po(3,4);
  const buy=(await rpc('mrp_plan')).rows.filter(r=>r.action==='Buy');
  assert.equal(buy[0].suggested_quantity,0);assert.equal(buy[1].suggested_quantity,11);
});
test('late, overdue and wrong-location POs cannot cover earlier demand',async()=>{
  await order(component,10,2);const purchase=await po(5,3);
  assert.equal((await rpc('mrp_plan')).rows[0].suggested_quantity,2);
  await q('update purchase_orders set expected_date=current_date-1 where id=$1',[purchase.id]);
  assert.equal((await rpc('mrp_plan')).overdue_incoming,5);assert.equal((await rpc('mrp_plan')).rows[0].suggested_quantity,2);
  await q('update purchase_orders set expected_date=current_date+1,delivery_location_id=$2 where id=$1',[purchase.id,other]);
  assert.equal((await rpc('mrp_plan')).rows[0].suggested_quantity,2);
  await q('update purchase_orders set delivery_location_id=null where id=$1',[purchase.id]);
  assert.equal((await rpc('mrp_plan')).unassigned_incoming,5);
});
test('partial receipts move supply into on-hand without double counting; rescheduling retains scorecard promise',async()=>{
  await order(component,15,7);const purchase=await po(5,3);
  assert.equal((await rpc('mrp_plan')).rows[0].suggested_quantity,2);
  const receipt=uuid();await rpc('receive_purchase',[receipt,purchase.line,loc,2]);await rpc('receive_purchase',[receipt,purchase.line,loc,2]);
  assert.equal((await rpc('mrp_plan')).rows[0].suggested_quantity,2);
  const expected=(await one('select expected_date::text d from purchase_orders where id=$1',[purchase.id])).d;
  await q("select update_purchase_delivery($1,$2,current_date+20,'Supplier confirmed delay')",[purchase.id,loc]);
  assert.equal((await rpc('mrp_plan')).rows[0].suggested_quantity,5);
  assert.equal((await one('select expected_date::text d from purchase_orders where id=$1',[purchase.id])).d,expected);
});
test('firm production adapter offsets builds only when supply is timely',async()=>{
  await order(kit,10,7);
  await db.exec(`create or replace view public.mrp_firm_build_supply with(security_invoker=true) as select '${kit}'::uuid product_id,'${loc}'::uuid location_id,current_date+6 available_date,4 quantity`);
  assert.equal((await rpc('mrp_plan')).rows.find(r=>r.action==='Make').suggested_quantity,3);
  await db.exec(`create or replace view public.mrp_firm_build_supply with(security_invoker=true) as select '${kit}'::uuid product_id,'${loc}'::uuid location_id,current_date+8 available_date,4 quantity`);
  await order(kit,4,10);
  const make=(await rpc('mrp_plan')).rows.filter(r=>r.action==='Make');assert.equal(make[0].suggested_quantity,7);assert.equal(make[1].suggested_quantity,0);
});
test('cancelled, fulfilled and out-of-horizon orders are excluded; overdue dates are flagged',async()=>{
  const cancelled=await order(component,1,2);await rpc('transition_sales_order',[cancelled,'Cancelled']);
  const fulfilled=await order(component,1,2);await rpc('transition_sales_order',[fulfilled,'Fulfilled']);
  await order(component,100,35);assert.equal((await rpc('mrp_plan')).rows.length,0);
  const overdue=await order(component,20,1);await q('update sales_orders set required_date=current_date-2 where id=$1',[overdue]);
  assert.equal((await rpc('mrp_plan')).rows[0].late,true);
});
test('supplier bills use receipt terms, prevent overpayment, and deduplicate retries',async()=>{
  const purchase=await po(4),receipt=uuid();await rpc('receive_purchase',[receipt,purchase.line,loc,4]);
  assert.equal((await one('select due_date=(received_at at time zone \'UTC\')::date+30 ok from purchase_receipts where id=$1',[receipt])).ok,true);
  const payment=uuid(),today=(await one('select current_date::text d')).d;
  await rpc('record_supplier_payment',[payment,receipt,1,today,'Bank reference']);await rpc('record_supplier_payment',[payment,receipt,1,today,'Bank reference']);
  const bill=(await rpc('supplier_bills',[supplier,0]))[0];assert.equal(bill.outstanding,3);
  await bad('select record_supplier_payment($1,$2,4,current_date,$3)',[uuid(),receipt,'Too much'],/exceeds/);
  await bad('select record_supplier_payment($1,$2,1,current_date+1,$3)',[uuid(),receipt,'Future payment'],/Payment date/);
  await bad('select receive_purchase($1,$2,$3,1)',[uuid(),purchase.line,loc],/open PO/);
});
test('scorecards calculate on-time delivery, late incomplete orders, fill and weighted lead times',async()=>{
  const a=await po(10,0);await q('update purchase_orders set sent_at=now()-interval \'3 days\',expected_date=current_date where id=$1',[a.id]);
  await rpc('receive_purchase',[uuid(),a.line,loc,10]);
  const b=await po(10,0);await q('update purchase_orders set sent_at=now()-interval \'7 days\',expected_date=current_date-2 where id=$1',[b.id]);
  await rpc('receive_purchase',[uuid(),b.line,loc,5]);
  const card=(await rpc('supplier_scorecards')).find(s=>s.id===supplier);
  assert.equal(card.on_time_rate,0.5);assert.equal(card.fill_rate,0.75);assert.equal(card.rating,'Replace');assert.equal(card.owed,15);
  assert.ok(Math.abs(card.actual_days-(10*3+5*7)/15)<0.000001);
});
test('EOQ, reorder points and manual reviews derive from sales and editable inputs',async()=>{
  const id=uuid();await q('insert into sales(id,location_id,created_at,subtotal,discount,tax,total,cogs) values($1,$2,now()-interval \'10 days\',600,0,0,600,200)',[id,loc]);
  await q('insert into sale_lines(sale_id,product_id,quantity,unit_price,unit_cost) values($1,$2,100,6,2)',[id,kit]);
  await rpc('save_item_policy',[component,supplier,3,5,7]);
  let row=(await rpc('replenishment_plan')).find(r=>r.id===component);
  assert.equal(row.daily_usage,200/row.history_days);assert.equal(row.reorder_point,Math.ceil(row.daily_usage*3+5));
  assert.equal(row.eoq,Math.ceil(Math.sqrt(2*row.daily_usage*365*25/0.25)));
  await rpc('save_ordering_settings',[100,0.25]);const larger=(await rpc('replenishment_plan')).find(r=>r.id===component);assert.ok(larger.eoq>row.eoq);
  await rpc('checkout',[uuid(),loc,null,JSON.stringify([{product_id:component,quantity:1}]),0]);
  assert.ok((await rpc('replenishment_plan')).find(r=>r.id===component).daily_usage>row.daily_usage);
  await rpc('review_planning_item',[uuid(),component,'Defer','Use warehouse stock first']);
  row=(await rpc('replenishment_plan')).find(r=>r.id===component);assert.equal(row.last_decision,'Defer');assert.ok(row.last_reviewed);
});
test('zero-demand EOQ is unavailable and invalid policy/settings are rejected',async()=>{
  assert.equal((await rpc('replenishment_plan'))[0].eoq,null);
  await bad('select save_ordering_settings(0,0.25)');await bad("select save_ordering_settings('NaN',0.25)");
  await bad('select save_item_policy($1,$2,-1,0,7)',[component,supplier]);
});
test('nested optional BOMs are rejected explicitly rather than silently underplanning',async()=>{
  await q('insert into bom values($1,$2,1)',[component,kit]);
  await bad('select mrp_plan()',[],/single-level BOMs/);
});
test('staff-only policies protect every new table and planning/payment function',async()=>{
  await q("select set_config('request.jwt.claim.sub',$1,true)",[uuid()]);await db.exec('set local role authenticated');
  assert.equal((await q('select * from item_planning')).length,0);
  for(const name of ['mrp_plan','supplier_scorecards','replenishment_plan'])await bad(`select ${name}()`,[],/Staff access/);
  await bad('select save_supplier($1,$2,$3,$4,3,30)',[uuid(),'Bad','x@example.com','555'],/Staff access/);
  await bad('insert into item_planning values($1,100,7)',[component]);
});

test('historical import links real seed movements once, with no quantity/value/profit changes',async()=>{
  const history=new PGlite();
  try{
    await history.exec(`create role anon;create role authenticated;create schema auth;create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;`);
    for(const f of ['001_schema.sql','002_seed.sql','004_purchasing.sql','005_sales_orders.sql','006_supplier_planning_mrp.sql'])await history.exec(await sqlFile(f));
    await history.query('insert into auth.users values($1)',[actor]);await history.query("insert into team_members values($1,'Importer')",[actor]);await history.query("select set_config('request.jwt.claim.sub',$1,false)",[actor]);
    const state=async()=>({stock:(await history.query('select * from stock order by product_id,location_id')).rows,
      report:(await history.query("select financial_report(current_date-200,current_date) r")).rows});
    const before=await state();await history.exec(await sqlFile('007_supplier_history.sql'));assert.deepEqual(await state(),before);
    const count=(await history.query('select count(*) n from purchase_orders')).rows[0].n;assert.ok(Number(count)>20);
    const cards=(await history.query('select supplier_scorecards() r')).rows[0].r;assert.equal(cards.filter(c=>c.orders>0).length,6);
    assert.ok(cards.some(c=>c.owed>0));assert.ok(cards.some(c=>c.on_time_rate<1));
    assert.ok(new Set(cards.map(c=>c.rating)).size>=2);
    await history.exec(await sqlFile('007_supplier_history.sql'));assert.equal((await history.query('select count(*) n from purchase_orders')).rows[0].n,count);
  }finally{await history.close();}
});
