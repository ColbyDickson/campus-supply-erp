-- Run ONCE after 001/002 in the existing project. No reset or reseeding.
begin;
create table if not exists public.purchase_orders (
  id uuid primary key,
  supplier_id uuid not null references public.suppliers(id),
  sent_at timestamptz not null default now(),
  quoted_lead_days integer not null check(quoted_lead_days>=0),
  payment_term_days integer not null check(payment_term_days>=0),
  expected_date date not null,
  status text not null default 'Order Sent' check(status in('Order Sent','Received','Closed')),
  created_by uuid not null references auth.users(id)
);
create table if not exists public.purchase_lines (
  id uuid primary key default gen_random_uuid(),
  purchase_order_id uuid not null references public.purchase_orders(id),
  product_id uuid not null references public.products(id),
  quantity integer not null check(quantity>0),
  received integer not null default 0 check(received>=0 and received<=quantity),
  unit_cost numeric(12,2) not null check(unit_cost>=0),
  unique(purchase_order_id,product_id)
);
create table if not exists public.purchase_receipts (
  id uuid primary key,
  line_id uuid not null references public.purchase_lines(id),
  location_id uuid not null references public.locations(id),
  quantity integer not null check(quantity>0),
  unit_cost numeric(12,2) not null check(unit_cost>=0),
  received_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id)
);
create index if not exists purchase_lines_order_idx on public.purchase_lines(purchase_order_id);
create index if not exists purchase_receipts_line_idx on public.purchase_receipts(line_id);
alter table public.movements add column if not exists purchase_receipt_id uuid references public.purchase_receipts(id);
alter table public.movements drop constraint if exists movements_reason_check;
alter table public.movements add constraint movements_reason_check check(reason in
  ('OPENING','HISTORICAL_RECEIPT','SALE','TRANSFER_IN','TRANSFER_OUT','CYCLE_COUNT','DAMAGE','PO_RECEIPT'));
do $$ declare t text; begin
  foreach t in array array['purchase_orders','purchase_lines','purchase_receipts'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('drop policy if exists staff_read on public.%I',t);
    execute format('create policy staff_read on public.%I for select to authenticated using(public.is_staff())',t);
    execute format('revoke all on public.%I from anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
  end loop;
end $$;

create or replace function public.create_purchase_order(p_id uuid,p_supplier uuid,p_items jsonb)
returns uuid language plpgsql security definer set search_path=public as $$
declare r record; v_supplier suppliers%rowtype; v_product products%rowtype;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_id is null then raise exception 'Request ID required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  if exists(select 1 from purchase_orders where id=p_id) then
    if not exists(select 1 from purchase_orders where id=p_id and created_by=auth.uid()) then raise exception 'Request ID already used'; end if;
    return p_id;
  end if;
  select * into v_supplier from suppliers where id=p_supplier;
  if not found then raise exception 'Choose a supplier'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'Items must be a list'; end if;
  if jsonb_array_length(p_items) not between 1 and 25 then raise exception 'Add 1–25 items'; end if;
  insert into purchase_orders(id,supplier_id,quoted_lead_days,payment_term_days,expected_date,created_by)
    values(p_id,p_supplier,v_supplier.quoted_lead_days,v_supplier.payment_term_days,
      (now() at time zone 'UTC')::date+v_supplier.quoted_lead_days,auth.uid());
  for r in select value x from jsonb_array_elements(p_items) loop
    if r.x->>'product_id' is null or r.x->>'quantity' is null or (r.x->>'quantity')!~'^[0-9]+$'
      or (r.x->>'quantity')::numeric not between 1 and 10000 then raise exception 'Use whole-number quantities from 1–10000'; end if;
    if r.x->>'unit_cost' is null or (r.x->>'unit_cost')!~'^[0-9]+([.][0-9]{1,2})?$'
      or (r.x->>'unit_cost')::numeric>1000000 then raise exception 'Enter a cost from 0–1000000 with up to two decimals'; end if;
    select * into v_product from products where id=(r.x->>'product_id')::uuid;
    if not found then raise exception 'Product not found'; end if;
    if v_product.is_kit or v_product.supplier_id is distinct from p_supplier then raise exception 'Item must be purchased from the selected supplier'; end if;
    insert into purchase_lines(purchase_order_id,product_id,quantity,unit_cost)
      values(p_id,v_product.id,(r.x->>'quantity')::integer,(r.x->>'unit_cost')::numeric);
  end loop;
  return p_id;
end $$;

create or replace function public.receive_purchase(p_id uuid,p_line uuid,p_location uuid,p_quantity integer)
returns uuid language plpgsql security definer set search_path=public as $$
declare v_order_id uuid; v_order purchase_orders%rowtype; v_line purchase_lines%rowtype; v_stock stock%rowtype;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_id is null then raise exception 'Request ID required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  if exists(select 1 from purchase_receipts where id=p_id) then
    if not exists(select 1 from purchase_receipts where id=p_id and created_by=auth.uid()
      and line_id=p_line and location_id=p_location and quantity=p_quantity) then raise exception 'Request ID already used for a different receipt'; end if;
    return p_id;
  end if;
  if p_quantity is null or p_quantity not between 1 and 10000 then raise exception 'Enter 1–10000 units'; end if;
  select purchase_order_id into v_order_id from purchase_lines where id=p_line;
  if not found then raise exception 'PO line not found'; end if;
  -- Lock the order first so competing partial receipts cannot over-receive it.
  select * into strict v_order from purchase_orders where id=v_order_id for update;
  if v_order.status<>'Order Sent' then raise exception 'Only an open PO can receive items'; end if;
  select * into strict v_line from purchase_lines where id=p_line for update;
  if p_quantity>v_line.quantity-v_line.received then raise exception 'Quantity exceeds the outstanding PO quantity'; end if;
  select * into v_stock from stock where product_id=v_line.product_id and location_id=p_location for update;
  if not found then raise exception 'Choose a valid inventory location'; end if;
  update stock set quantity=quantity+p_quantity,
    average_cost=(v_stock.quantity*v_stock.average_cost+p_quantity*v_line.unit_cost)/(v_stock.quantity+p_quantity)
    where product_id=v_line.product_id and location_id=p_location;
  insert into purchase_receipts(id,line_id,location_id,quantity,unit_cost,created_by)
    values(p_id,p_line,p_location,p_quantity,v_line.unit_cost,auth.uid());
  insert into movements(product_id,location_id,quantity,unit_cost,reason,note,purchase_receipt_id,created_by)
    values(v_line.product_id,p_location,p_quantity,v_line.unit_cost,'PO_RECEIPT','Receipt against PO '||v_order_id::text,p_id,auth.uid());
  update purchase_lines set received=received+p_quantity where id=p_line;
  if not exists(select 1 from purchase_lines where purchase_order_id=v_order_id and received<quantity) then
    update purchase_orders set status='Received' where id=v_order_id;
  end if;
  return p_id;
end $$;

create or replace function public.close_purchase(p_order uuid)
returns void language plpgsql security definer set search_path=public as $$
declare v_status text;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  select status into v_status from purchase_orders where id=p_order for update;
  if v_status='Closed' then return; end if;
  if v_status is distinct from 'Received' then raise exception 'Receive all ordered units before closing'; end if;
  update purchase_orders set status='Closed' where id=p_order;
end $$;
revoke all on function public.create_purchase_order(uuid,uuid,jsonb),public.receive_purchase(uuid,uuid,uuid,integer),public.close_purchase(uuid) from public,anon;
grant execute on function public.create_purchase_order(uuid,uuid,jsonb),public.receive_purchase(uuid,uuid,uuid,integer),public.close_purchase(uuid) to authenticated;
commit;
