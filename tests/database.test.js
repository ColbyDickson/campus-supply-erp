import { PGlite } from '@electric-sql/pglite';
import { readFile } from 'node:fs/promises';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

let db, product, location, other, staff = randomUUID();
const query = async (sql, args = []) => (await db.query(sql, args)).rows;
const one = async (sql, args = []) => (await query(sql, args))[0];
const stock = async (p = product.id, l = location.id) => one('select * from stock where product_id=$1 and location_id=$2', [p,l]);
const checkout = (id, items, discount = 0) => query('select checkout($1,$2,null,$3::jsonb,$4)', [id,location.id,JSON.stringify(items),discount]);

before(async () => {
  db = new PGlite();
  await db.exec(`create role anon; create role authenticated; create schema auth;
    create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema public,auth to anon,authenticated;`);
  await db.exec(await readFile(new URL('../supabase/001_schema.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/002_seed.sql',import.meta.url),'utf8'));
  await db.exec(await readFile(new URL('../supabase/004_purchasing.sql',import.meta.url),'utf8'));
  await query('insert into auth.users values($1)', [staff]);
  await query('insert into team_members values($1,$2)', [staff,'Test teammate']);
  await query("select set_config('request.jwt.claim.sub',$1,false)", [staff]);
  product = await one("select * from products where sku='PEN'");
  location = await one("select * from locations where name='Storefront'");
  other = await one("select * from locations where name='Stockroom'");
});
after(async () => { await db?.close(); });

test('starting data meets all required counts and covers six months', async () => {
  assert.equal(Number((await one('select count(*) n from products')).n),25);
  assert.equal(Number((await one('select count(distinct parent_id) n from bom')).n),5);
  assert.equal(Number((await one('select count(*) n from locations')).n),3);
  assert.equal(Number((await one('select count(*) n from suppliers')).n),6);
  assert.equal(Number((await one('select count(*) n from customers')).n),10);
  assert.equal((await one("select min(created_at)::date=(current_date-interval '6 months')::date as ok from sales")).ok,true);
  assert.equal(Number((await one('select count(*) n from products where barcode is null or price is null or lead_days is null')).n),0);
  const demand = await query('select product_id,sum(quantity)::int n from sale_lines group by product_id');
  assert.equal(demand.length,25);
  assert.ok(new Set(demand.map(x=>x.n)).size>12);
});
test('seed is repeatable without duplicate records', async () => {
  const before = await one('select count(*) n from sales');
  await db.exec(await readFile(new URL('../supabase/002_seed.sql',import.meta.url),'utf8'));
  assert.deepEqual(await one('select count(*) n from sales'),before);
});
test('opening and history movement quantities reconcile to stock', async () => {
  const bad = await query(`select s.* from stock s left join (
    select product_id,location_id,sum(quantity) quantity from movements group by 1,2
    )m using(product_id,location_id) where s.quantity<>m.quantity`);
  assert.equal(bad.length,0);
});
test('kit opening costs equal BOM component costs', async () => {
  assert.equal((await query(`select p.id from products p join bom b on b.parent_id=p.id join products c on c.id=b.component_id
    group by p.id having p.standard_cost<>sum(b.quantity*c.standard_cost)`)).length,0);
});
test('multi-line checkout aggregates scans, uses stored prices, tax, and costs', async () => {
  const second = await one("select * from products where sku='NOTEBOOK'");
  const a=await stock(), b=await stock(second.id);
  const id=randomUUID();
  await checkout(id,[{product_id:product.id,quantity:1,unit_price:0.01},{product_id:product.id,quantity:2},{product_id:second.id,quantity:1}],1);
  const sale=await one('select * from sales where id=$1',[id]);
  assert.equal((await stock()).quantity,a.quantity-3);
  assert.equal((await stock(second.id)).quantity,b.quantity-1);
  assert.equal(Number(sale.subtotal),3*Number(product.price)+Number(second.price));
  assert.equal(Number(sale.tax),Math.round((Number(sale.subtotal)-1)*0.0725*100)/100);
  assert.equal(Number(sale.total),Number(sale.subtotal)-1+Number(sale.tax));
  assert.equal(Number((await one('select count(*) n from sale_lines where sale_id=$1',[id])).n),2);
  assert.equal(Number(sale.cogs),Math.round(3*Number(a.average_cost)*100)/100+Math.round(Number(b.average_cost)*100)/100);
});
test('retrying the same checkout request does not sell twice', async () => {
  const before=await stock(), id=randomUUID(), items=[{product_id:product.id,quantity:1}];
  await checkout(id,items); await checkout(id,items);
  assert.equal((await stock()).quantity,before.quantity-1);
  assert.equal(Number((await one('select count(*) n from sales where id=$1',[id])).n),1);
});
test('insufficient stock rolls back every line and sale', async () => {
  const before=await stock(), id=randomUUID(), second=await one("select id from products where sku='USB'");
  await assert.rejects(checkout(id,[{product_id:product.id,quantity:1},{product_id:second.id,quantity:10000}]),/Insufficient stock/);
  assert.deepEqual(await stock(),before);
  assert.equal(Number((await one('select count(*) n from sales where id=$1',[id])).n),0);
});
test('invalid quantities, missing products, and invalid discounts are rejected', async () => {
  for (const quantity of [0,-1,1.5,null,'NaN']) {
    await assert.rejects(checkout(randomUUID(),[{product_id:product.id,quantity}]));
  }
  await assert.rejects(checkout(randomUUID(),[]));
  await assert.rejects(checkout(randomUUID(),[{quantity:1}]));
  for (const discount of [-1,100000,'NaN',null,0.001]) {
    await assert.rejects(checkout(randomUUID(),[{product_id:product.id,quantity:1}],discount));
  }
});
test('transfers preserve quantity and value and weight the destination cost', async () => {
  const a=await stock(), b=await stock(product.id,other.id), qty=3;
  await query('select transfer_stock($1,$2,$3,$4,$5)',[product.id,location.id,other.id,qty,'Restock stockroom']);
  const aa=await stock(),bb=await stock(product.id,other.id);
  assert.equal(aa.quantity,a.quantity-qty); assert.equal(bb.quantity,b.quantity+qty);
  const oldValue=a.quantity*Number(a.average_cost)+b.quantity*Number(b.average_cost);
  const newValue=aa.quantity*Number(aa.average_cost)+bb.quantity*Number(bb.average_cost);
  assert.ok(Math.abs(newValue-oldValue)<0.001);
  await assert.rejects(query('select transfer_stock($1,$2,$2,1,$3)',[product.id,location.id,'Invalid move']));
});
test('adjustments require a reason, cannot add damage, and cannot go negative', async () => {
  const before=await stock();
  await query('select adjust_stock($1,$2,-1,$3,$4)',[product.id,location.id,'DAMAGE','Broken pen']);
  assert.equal((await stock()).quantity,before.quantity-1);
  for(const [delta,reason,note] of [[1,'DAMAGE','wrong sign'],[-10000,'CYCLE_COUNT','too many'],[1,'OTHER','reason'],[1,'CYCLE_COUNT','']]) {
    await assert.rejects(query('select adjust_stock($1,$2,$3,$4,$5)',[product.id,location.id,delta,reason,note]));
  }
});
test('financial reports exclude tax, include adjustments, and calculate turnover', async () => {
  const report=(await one("select financial_report(current_date,current_date) result")).result;
  const sums=await one('select sum(subtotal-discount) net,sum(cogs) cogs from sales where created_at::date=current_date');
  assert.equal(Number(report.net_sales),Number(sums.net));
  assert.equal(Number(report.cogs),Number(sums.cogs));
  assert.equal(Number(report.gross_profit),Number(sums.net)-Number(sums.cogs));
  assert.ok(Number(report.inventory_adjustment_expense)>0);
  assert.ok(Number(report.turnover)>0);
  assert.ok(Math.abs(Number(report.current_inventory)-Number(report.closing_inventory))<0.01);
  const summary=(await one("select sales_summary(current_date-200,current_date) result")).result;
  assert.ok(summary.receipt_count>1000); assert.ok(summary.daily_sales.length>180); assert.equal(summary.top_items.length,8);
});
test('unenrolled users cannot read data or use write/report functions', async () => {
  await query("select set_config('request.jwt.claim.sub',$1,false)",[randomUUID()]);
  await db.exec('set role authenticated');
  try {
    assert.equal((await query('select * from products')).length,0);
    await assert.rejects(checkout(randomUUID(),[{product_id:product.id,quantity:1}]),/Staff access required/);
    await assert.rejects(query('select financial_report(current_date,current_date)'),/Staff access required/);
    await assert.rejects(query('select adjust_stock($1,$2,-1,$3,$4)',[product.id,location.id,'DAMAGE','Not authorized']),/Staff access required/);
    await assert.rejects(query('insert into team_members values($1,$2)',[randomUUID(),'Escalate']));
  } finally { await db.exec('reset role'); await query("select set_config('request.jwt.claim.sub',$1,false)",[staff]); }
});
test('enrolled teammates can read but cannot write tables directly', async () => {
  await db.exec('set role authenticated');
  try {
    assert.equal((await query('select * from products')).length,25);
    await assert.rejects(query('update stock set quantity=999 where product_id=$1',[product.id]));
    await assert.rejects(query('update products set price=0.01 where id=$1',[product.id]));
  } finally { await db.exec('reset role'); }
});
test('anonymous users have no table access or RPC execution', async () => {
  await db.exec('set role anon');
  try {
    await assert.rejects(query('select * from products'));
    await assert.rejects(checkout(randomUUID(),[{product_id:product.id,quantity:1}]));
  } finally { await db.exec('reset role'); }
});

test('purchase order snapshots lead time, supports partial receipts, values stock, and closes only when complete', async()=>{
  const id=randomUUID(),otherItem=await one("select * from products where sku='PENCIL'");
  const items=[{product_id:product.id,quantity:4,unit_cost:0.50},{product_id:otherItem.id,quantity:2,unit_cost:0.30}];
  const create=()=>query('select create_purchase_order($1,$2,$3::jsonb)',[id,product.supplier_id,JSON.stringify(items)]);
  await create();await create();
  const po=await one('select * from purchase_orders where id=$1',[id]);
  assert.equal(po.status,'Order Sent');
  assert.equal((await one('select expected_date=(sent_at at time zone \'UTC\')::date+quoted_lead_days ok from purchase_orders where id=$1',[id])).ok,true);
  const lines=await query('select * from purchase_lines where purchase_order_id=$1 order by product_id',[id]);
  const line=lines.find(l=>l.product_id===product.id),second=lines.find(l=>l.product_id===otherItem.id);
  await assert.rejects(query('select close_purchase($1)',[id]),/Receive all/);
  const before=await stock(), receipt=randomUUID();
  const receive=(rid,lid,qty)=>query('select receive_purchase($1,$2,$3,$4)',[rid,lid,location.id,qty]);
  await receive(receipt,line.id,2);await receive(receipt,line.id,2);
  assert.equal((await stock()).quantity,before.quantity+2);
  assert.ok(Math.abs(Number((await stock()).average_cost)-(before.quantity*Number(before.average_cost)+1)/(before.quantity+2))<0.000001);
  assert.equal((await one('select status from purchase_orders where id=$1',[id])).status,'Order Sent');
  await assert.rejects(receive(randomUUID(),line.id,3),/exceeds/);
  await assert.rejects(receive(receipt,line.id,1),/different receipt/);
  assert.equal((await stock()).quantity,before.quantity+2);
  await receive(randomUUID(),line.id,2);await receive(randomUUID(),second.id,2);
  assert.equal((await one('select status from purchase_orders where id=$1',[id])).status,'Received');
  await query('select close_purchase($1)',[id]);await query('select close_purchase($1)',[id]);
  assert.equal((await one('select status from purchase_orders where id=$1',[id])).status,'Closed');
  const report=(await one('select financial_report(current_date,current_date) r')).r;
  assert.ok(Math.abs(Number(report.current_inventory)-Number(report.closing_inventory))<0.01);
});
test('invalid POs and receipts roll back and staff controls apply to purchasing',async()=>{
  const id=randomUUID();
  await assert.rejects(query('select create_purchase_order($1,$2,$3::jsonb)',[id,product.supplier_id,JSON.stringify([{product_id:product.id,quantity:1,unit_cost:0.5},{product_id:product.id,quantity:1,unit_cost:0.5}])]));
  assert.equal((await query('select * from purchase_orders where id=$1',[id])).length,0);
  for(const line of [{product_id:product.id,quantity:0,unit_cost:1},{product_id:product.id,quantity:1,unit_cost:-1},{product_id:product.id,quantity:1,unit_cost:'NaN'}]){
    await assert.rejects(query('select create_purchase_order($1,$2,$3::jsonb)',[id,product.supplier_id,JSON.stringify([line])]));
  }
  const usb=await one("select * from products where sku='USB'");
  await assert.rejects(query('select create_purchase_order($1,$2,$3::jsonb)',[id,product.supplier_id,JSON.stringify([{product_id:usb.id,quantity:1,unit_cost:3}])]),/selected supplier/);
  await db.exec('set role authenticated');
  try{await assert.rejects(query('update purchase_orders set status=\'Closed\''));}finally{await db.exec('reset role');}
  await query("select set_config('request.jwt.claim.sub',$1,false)",[randomUUID()]);await db.exec('set role authenticated');
  try{
    assert.equal((await query('select * from purchase_orders')).length,0);
    await assert.rejects(query('select create_purchase_order($1,$2,$3::jsonb)',[id,product.supplier_id,'[]']),/Staff access/);
    await assert.rejects(query('select receive_purchase($1,$2,$3,1)',[id,id,location.id]),/Staff access/);
    await assert.rejects(query('select close_purchase($1)',[id]),/Staff access/);
  }finally{await db.exec('reset role');await query("select set_config('request.jwt.claim.sub',$1,false)",[staff]);}
  await db.exec(await readFile(new URL('../supabase/004_purchasing.sql',import.meta.url),'utf8'));
  assert.equal(Number((await one('select count(*) n from purchase_orders')).n),1);
});
