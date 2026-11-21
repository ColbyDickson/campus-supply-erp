import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { test, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

let db;
const staff=randomUUID(),secondStaff=randomUUID(),customer=randomUUID(),loc=randomUUID(),otherLoc=randomUUID(),pen=randomUUID(),book=randomUUID();
const q=async(sql,args=[]) => (await db.query(sql,args)).rows;
const one=async(sql,args=[]) => (await q(sql,args))[0];
const items=[{product_id:pen,quantity:2},{product_id:book,quantity:1}];
const place=(id=randomUUID(),lines=items,discount=1,date='2099-01-01')=>q('select create_sales_order($1,$2,$3,$4,$5::jsonb,$6)',[id,customer,loc,date,JSON.stringify(lines),discount]);
const transition=(id,status)=>q('select transition_sales_order($1,$2)',[id,status]);
const stock=()=>q('select * from stock order by product_id,location_id');
const counts=()=>one('select (select count(*) from sales)::int sales,(select count(*) from movements)::int movements');
before(async()=>{
  db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema public,auth to anon,authenticated;`);
  for(const file of ['001_schema.sql','004_purchasing.sql','005_sales_orders.sql'])await db.exec(await readFile(new URL(`../supabase/${file}`,import.meta.url),'utf8'));
  await q('insert into auth.users values($1),($2)',[staff,secondStaff]);
  await q("insert into team_members values($1,'Staff'),($2,'Other staff')",[staff,secondStaff]);
  await q("insert into customers values($1,'Test customer','customer@example.com')",[customer]);
  await q("insert into locations values($1,'Storefront'),($2,'Stockroom')",[loc,otherLoc]);
  await db.exec('insert into settings(tax_rate) values(0.10)');
  for(const [id,sku,price,cost] of [[pen,'PEN',3,1],[book,'BOOK',10,4]]){
    await q("insert into products(id,sku,barcode,name,category,standard_cost,price,reorder_point,lead_days) values($1,$2,$2,$2,'Test',$4,$3,5,3)",[id,sku,price,cost]);
    await q('insert into stock values($1,$2,20,$4),($1,$3,30,$4)',[id,loc,otherLoc,cost]);
    await q("insert into movements(product_id,location_id,quantity,unit_cost,reason,note,created_at) values($1,$2,20,$4,'OPENING','Test stock',now()-interval '1 day'),($1,$3,30,$4,'OPENING','Test stock',now()-interval '1 day')",[id,loc,otherLoc,cost]);
  }
});
after(async()=>{await db?.close();});
beforeEach(async()=>{await db.exec('begin');await q("select set_config('request.jwt.claim.sub',$1,true)",[staff]);});
afterEach(async()=>{await db.exec('rollback');});

test('order saves confirmed lines, stored prices and tax, without changing stock or financials',async()=>{
  const id=randomUUID(),before=await stock(),baseline=await counts();
  await place(id,[{product_id:pen,quantity:1,unit_price:0},{product_id:pen,quantity:1},{product_id:book,quantity:1}]);
  const o=await one('select * from sales_orders where id=$1',[id]);
  assert.equal(o.status,'Order Placed');assert.equal(Number(o.subtotal),16);assert.equal(Number(o.discount),1);assert.equal(Number(o.tax),1.5);assert.equal(Number(o.total),16.5);
  const lines=await q('select * from sales_order_lines where sales_order_id=$1',[id]);assert.equal(lines.length,2);assert.equal(lines.find(l=>l.product_id===pen).quantity,2);
  assert.deepEqual(await stock(),before);assert.deepEqual(await counts(),baseline);
  assert.equal(Number((await one('select financial_report(current_date,current_date) r')).r.net_sales),0);
});

test('fulfillment uses the quote, current cost, one receipt and one stock deduction; close is financial no-op',async()=>{
  const id=randomUUID();await place(id);
  await q('update products set price=99 where id=$1',[pen]);await db.exec('update settings set tax_rate=0.25');
  await q('update stock set average_cost=2 where product_id=$1 and location_id=$2',[pen,loc]);
  await transition(id,'Fulfilled');
  const sale=await one('select * from sales where id=$1',[id]);assert.equal(Number(sale.total),16.5);assert.equal(Number(sale.cogs),8);assert.equal(sale.customer_id,customer);
  assert.equal((await one('select quantity from stock where product_id=$1 and location_id=$2',[pen,loc])).quantity,18);
  assert.equal((await one('select quantity from stock where product_id=$1 and location_id=$2',[pen,otherLoc])).quantity,30);
  assert.equal(Number((await one('select unit_price from sale_lines where sale_id=$1 and product_id=$2',[id,pen])).unit_price),3);
  const report=(await one('select financial_report(current_date,current_date) r')).r;
  assert.equal(Number(report.net_sales),15);assert.equal(Number(report.cogs),8);assert.equal(Number(report.gross_profit),7);
  const before=await stock(),baseline=await counts();
  await transition(id,'Fulfilled');await transition(id,'Closed');await transition(id,'Closed');await transition(id,'Fulfilled');
  assert.deepEqual(await stock(),before);assert.deepEqual(await counts(),baseline);
  assert.equal((await one('select status from sales_orders where id=$1',[id])).status,'Closed');
  await assert.rejects(transition(id,'Cancelled'),/Cannot change/);
});

test('insufficient stock rolls back the whole fulfillment and can succeed after replenishment',async()=>{
  const id=randomUUID();await place(id);await q('update stock set quantity=0 where product_id=$1 and location_id=$2',[book,loc]);
  const before=await stock(),baseline=await counts();
  // Expected errors use savepoints because each test is otherwise transactional.
  await db.exec('savepoint failure');await assert.rejects(transition(id,'Fulfilled'),/Insufficient stock/);await db.exec('rollback to failure');
  assert.deepEqual(await stock(),before);assert.deepEqual(await counts(),baseline);
  assert.equal((await one('select status from sales_orders where id=$1',[id])).status,'Order Placed');
  await q('update stock set quantity=5 where product_id=$1 and location_id=$2',[book,loc]);await transition(id,'Fulfilled');
  assert.equal(Number((await one('select count(*) n from sales where id=$1',[id])).n),1);
});

async function rejected(run,pattern){await db.exec('savepoint expected_error');await assert.rejects(run(),pattern);await db.exec('rollback to expected_error');}

test('cancel has no stock/finance effect and terminal states cannot be reopened or fulfilled',async()=>{
  const id=randomUUID();await place(id);const before=await stock(),baseline=await counts();
  await rejected(()=>transition(id,'Closed'),/Cannot change/);
  await transition(id,'Cancelled');await transition(id,'Cancelled');
  await rejected(()=>transition(id,'Fulfilled'),/Cannot change/);await rejected(()=>transition(id,'Order Placed'),/Choose/);
  assert.deepEqual(await stock(),before);assert.deepEqual(await counts(),baseline);
  assert.ok((await one('select cancelled_at from sales_orders where id=$1',[id])).cancelled_at);
});

test('creating twice and fulfillment by another staff user produce one order and one sale',async()=>{
  const id=randomUUID();await place(id);await place(id);
  assert.equal(Number((await one('select count(*) n from sales_orders')).n),1);
  await q("select set_config('request.jwt.claim.sub',$1,true)",[secondStaff]);
  await rejected(()=>place(id),/already used/);await transition(id,'Fulfilled');
  assert.equal((await one('select created_by from sales where id=$1',[id])).created_by,secondStaff);
  await transition(id,'Fulfilled');assert.equal(Number((await one('select count(*) n from sales')).n),1);
});

test('invalid quantities, aggregated overflow, invalid dates, identities, discounts and empty orders fail atomically',async()=>{
  for(const quantity of [0,-1,1.2,null,'NaN',10001])await rejected(()=>place(randomUUID(),[{product_id:pen,quantity}]),/quantity|Quantity/);
  await rejected(()=>place(randomUUID(),[{product_id:pen,quantity:6000},{product_id:pen,quantity:6000}]),/check constraint/);
  for(const lines of [[],null,{},[{quantity:1}],[{product_id:randomUUID(),quantity:1}]])await rejected(()=>place(randomUUID(),lines));
  for(const discount of [-1,100,null,'NaN','Infinity',0.001])await rejected(()=>place(randomUUID(),items,discount));
  for(const date of [null,'2000-01-01'])await rejected(()=>place(randomUUID(),items,0,date),/Required date/);
  await rejected(()=>q('select create_sales_order($1,$2,$3,current_date,$4,0)',[randomUUID(),randomUUID(),loc,JSON.stringify(items)]),/customer/);
  await rejected(()=>q('select create_sales_order($1,$2,$3,current_date,$4,0)',[randomUUID(),customer,randomUUID(),JSON.stringify(items)]),/location/);
  assert.equal(Number((await one('select count(*) n from sales_orders')).n),0);
});

test('two orders competing for stock: second fails without extra receipt or negative stock',async()=>{
  const a=randomUUID(),b=randomUUID();await place(a);await place(b);await q('update stock set quantity=2 where product_id=$1 and location_id=$2',[pen,loc]);
  await transition(a,'Fulfilled');await rejected(()=>transition(b,'Fulfilled'),/Insufficient stock/);
  assert.equal(Number((await one('select count(*) n from sales')).n),1);assert.equal((await one('select min(quantity) n from stock')).n,0);
});

test('staff RLS allows reads but direct writes fail; customer and anonymous access fail',async()=>{
  const id=randomUUID();await place(id);await db.exec('set local role authenticated');
  assert.equal((await q('select * from sales_orders')).length,1);
  await rejected(()=>q("update sales_orders set status='Cancelled' where id=$1",[id]),/permission denied/);
  await rejected(()=>q('delete from sales_order_lines'),/permission denied/);
  await q("select set_config('request.jwt.claim.sub',$1,true)",[randomUUID()]);
  assert.equal((await q('select * from sales_orders')).length,0);assert.equal((await q('select * from sales_order_lines')).length,0);
  await rejected(()=>place(),/Staff access required/);await rejected(()=>transition(id,'Fulfilled'),/Staff access required/);
  await db.exec('set local role anon');await rejected(()=>q('select * from sales_orders'),/permission denied/);await rejected(()=>place(),/permission denied/);
});


test('POS and sales orders use the same stock and reporting ledger',async()=>{
  const id=randomUUID();await place(id);await q('update stock set quantity=2 where product_id=$1 and location_id=$2',[pen,loc]);
  const receipt=randomUUID();
  await q('select checkout($1,$2,$3,$4::jsonb,0)',[receipt,loc,customer,JSON.stringify([{product_id:pen,quantity:1}])]);
  await rejected(()=>transition(id,'Fulfilled'),/Insufficient stock/);
  assert.equal(Number((await one('select financial_report(current_date,current_date) r')).r.net_sales),3);
  assert.equal((await one('select quantity from stock where product_id=$1 and location_id=$2',[pen,loc])).quantity,1);
  assert.equal((await one('select status from sales_orders where id=$1',[id])).status,'Order Placed');
});
