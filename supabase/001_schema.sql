-- Campus Supply Co. foundation. Run in a NEW Supabase project's SQL Editor.
-- All write operations use transactional database functions, not browser math.
begin;

create table public.team_members (
  user_id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null
);
create function public.is_staff() returns boolean language sql stable security definer
set search_path = public as $$
  select exists(select 1 from team_members where user_id = auth.uid());
$$;

create table public.settings (
  id boolean primary key default true check (id),
  tax_rate numeric(6,5) not null default 0.0725 check(tax_rate between 0 and 1),
  ordering_cost numeric(12,2) not null default 25 check(ordering_cost > 0),
  annual_holding_rate numeric(6,4) not null default 0.25 check(annual_holding_rate > 0),
  currency text not null default 'USD',
  seeded boolean not null default false
);
create table public.locations (
  id uuid primary key default gen_random_uuid(),
  name text unique not null
);
create table public.suppliers (
  id uuid primary key default gen_random_uuid(),
  name text unique not null,
  email text not null,
  phone text not null,
  quoted_lead_days integer not null check(quoted_lead_days >= 0),
  payment_term_days integer not null check(payment_term_days >= 0)
);
create table public.products (
  id uuid primary key default gen_random_uuid(),
  sku text unique not null,
  barcode text unique not null,
  name text not null,
  category text not null,
  supplier_id uuid references suppliers(id),
  standard_cost numeric(12,2) not null check(standard_cost >= 0),
  price numeric(12,2) not null check(price >= 0),
  reorder_point integer not null check(reorder_point >= 0),
  lead_days integer not null check(lead_days >= 0),
  is_kit boolean not null default false
);
create table public.bom (
  parent_id uuid references products(id),
  component_id uuid references products(id),
  quantity integer not null check(quantity > 0),
  primary key(parent_id, component_id),
  check(parent_id <> component_id)
);
create table public.customers (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text unique not null
);
create table public.stock (
  product_id uuid references products(id),
  location_id uuid references locations(id),
  quantity integer not null default 0 check(quantity >= 0),
  average_cost numeric(14,6) not null check(average_cost >= 0),
  primary key(product_id, location_id)
);
create table public.sales (
  id uuid primary key,
  location_id uuid not null references locations(id),
  customer_id uuid references customers(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id),
  subtotal numeric(14,2) not null check(subtotal >= 0),
  discount numeric(14,2) not null check(discount between 0 and subtotal),
  tax numeric(14,2) not null check(tax >= 0),
  total numeric(14,2) not null,
  cogs numeric(14,2) not null check(cogs >= 0),
  check(total = subtotal - discount + tax)
);
create table public.sale_lines (
  id uuid primary key default gen_random_uuid(),
  sale_id uuid not null references sales(id),
  product_id uuid not null references products(id),
  quantity integer not null check(quantity > 0),
  unit_price numeric(12,2) not null check(unit_price >= 0),
  unit_cost numeric(14,6) not null check(unit_cost >= 0),
  unique(sale_id, product_id)
);
create table public.movements (
  id uuid primary key default gen_random_uuid(),
  product_id uuid not null references products(id),
  location_id uuid not null references locations(id),
  quantity integer not null check(quantity <> 0),
  unit_cost numeric(14,6) not null check(unit_cost >= 0),
  reason text not null check(reason in ('OPENING','HISTORICAL_RECEIPT','SALE','TRANSFER_IN','TRANSFER_OUT','CYCLE_COUNT','DAMAGE')),
  note text not null,
  sale_id uuid references sales(id),
  created_at timestamptz not null default now(),
  created_by uuid references auth.users(id)
);
create index sales_created_idx on sales(created_at);
create index lines_product_idx on sale_lines(product_id);
create index movement_created_idx on movements(created_at);
create index movement_product_idx on movements(product_id,location_id);

-- Read access requires an explicitly enrolled teammate. Customers will receive
-- separate, restricted policies when the customer portal is implemented.
do $$ declare t text; begin
  foreach t in array array['team_members','settings','locations','suppliers','products','bom','customers','stock','sales','sale_lines','movements'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy staff_read on public.%I for select to authenticated using (public.is_staff())',t);
    execute format('revoke all on public.%I from anon, authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
  end loop;
end $$;
revoke all on function public.is_staff() from public, anon;
grant execute on function public.is_staff() to authenticated;

create function public.checkout(
  p_request_id uuid, p_location uuid, p_customer uuid,
  p_items jsonb, p_discount numeric default 0
) returns uuid language plpgsql security definer set search_path = public as $$
declare
  r record; s stock%rowtype; v_subtotal numeric := 0; v_cogs numeric := 0;
  v_tax numeric; v_rate numeric;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_request_id is null then raise exception 'A request ID is required'; end if;
  -- Same request can safely be retried after a network interruption.
  perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
  if exists(select 1 from sales where id=p_request_id) then
    if not exists(select 1 from sales where id=p_request_id and created_by=auth.uid()) then
      raise exception 'Request ID already used';
    end if;
    return p_request_id;
  end if;
  if p_items is null or jsonb_typeof(p_items) <> 'array' then raise exception 'Cart must be a list'; end if;
  if jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Add 1–100 cart lines'; end if;
  if p_discount is null or p_discount::text in ('NaN','Infinity','-Infinity') or p_discount < 0 or p_discount <> round(p_discount,2) then
    raise exception 'Discount must be a nonnegative amount with at most two decimals';
  end if;
  if not exists(select 1 from locations where id=p_location) then raise exception 'Choose a location'; end if;
  if p_customer is not null and not exists(select 1 from customers where id=p_customer) then raise exception 'Customer not found'; end if;
  for r in select value as item from jsonb_array_elements(p_items) loop
    if r.item->>'product_id' is null or r.item->>'quantity' is null
      or (r.item->>'quantity') !~ '^[0-9]+$' then raise exception 'Each line needs an item and a whole-number quantity'; end if;
    if (r.item->>'quantity')::numeric not between 1 and 10000 then raise exception 'Quantity must be 1–10000'; end if;
    if not exists(select 1 from products where id=(r.item->>'product_id')::uuid) then raise exception 'Unknown product'; end if;
  end loop;
  -- Aggregate repeated scans; acquire stock locks in a consistent order.
  for r in
    select (x->>'product_id')::uuid as product_id, sum((x->>'quantity')::integer)::integer as qty
    from jsonb_array_elements(p_items) x group by 1 order by 1
  loop
    select * into s from stock where product_id=r.product_id and location_id=p_location for update;
    if not found or s.quantity < r.qty then
      raise exception 'Insufficient stock for %', (select name from products where id=r.product_id);
    end if;
    v_subtotal := v_subtotal + r.qty*(select price from products where id=r.product_id);
    v_cogs := v_cogs + round(r.qty*s.average_cost,2);
  end loop;
  if p_discount > v_subtotal then raise exception 'Discount exceeds subtotal'; end if;
  select tax_rate into strict v_rate from settings where id;
  v_tax := round((v_subtotal-p_discount)*v_rate,2);
  insert into sales(id,location_id,customer_id,created_by,subtotal,discount,tax,total,cogs)
    values(p_request_id,p_location,p_customer,auth.uid(),v_subtotal,p_discount,v_tax,v_subtotal-p_discount+v_tax,v_cogs);
  for r in
    select (x->>'product_id')::uuid as product_id, sum((x->>'quantity')::integer)::integer as qty
    from jsonb_array_elements(p_items) x group by 1 order by 1
  loop
    select * into strict s from stock where product_id=r.product_id and location_id=p_location;
    insert into sale_lines(sale_id,product_id,quantity,unit_price,unit_cost)
      select p_request_id,r.product_id,r.qty,price,s.average_cost from products where id=r.product_id;
    update stock set quantity=quantity-r.qty where product_id=r.product_id and location_id=p_location;
    insert into movements(product_id,location_id,quantity,unit_cost,reason,note,sale_id,created_by)
      values(r.product_id,p_location,-r.qty,s.average_cost,'SALE','POS checkout',p_request_id,auth.uid());
  end loop;
  return p_request_id;
end $$;

create function public.adjust_stock(p_product uuid,p_location uuid,p_delta integer,p_reason text,p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare s stock%rowtype;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_delta is null or p_delta=0 or abs(p_delta::bigint)>10000 then raise exception 'Enter a change from -10000 to 10000, excluding zero'; end if;
  if p_reason is null or p_reason not in ('CYCLE_COUNT','DAMAGE') then raise exception 'Choose a valid reason'; end if;
  if p_reason='DAMAGE' and p_delta>0 then raise exception 'Damage must remove stock'; end if;
  if p_note is null or length(trim(p_note))<3 then raise exception 'Explain the adjustment (at least three characters)'; end if;
  select * into s from stock where product_id=p_product and location_id=p_location for update;
  if not found then raise exception 'Stock record not found'; end if;
  if s.quantity+p_delta<0 then raise exception 'Adjustment would make stock negative'; end if;
  update stock set quantity=quantity+p_delta where product_id=p_product and location_id=p_location;
  insert into movements(product_id,location_id,quantity,unit_cost,reason,note,created_by)
    values(p_product,p_location,p_delta,s.average_cost,p_reason,trim(p_note),auth.uid());
end $$;

create function public.transfer_stock(p_product uuid,p_from uuid,p_to uuid,p_quantity integer,p_note text)
returns void language plpgsql security definer set search_path = public as $$
declare a stock%rowtype; b stock%rowtype;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_from is null or p_to is null or p_from=p_to then raise exception 'Choose different locations'; end if;
  if p_quantity is null or p_quantity not between 1 and 10000 then raise exception 'Enter 1–10000 units'; end if;
  if p_note is null or length(trim(p_note))<3 then raise exception 'Explain the transfer'; end if;
  perform 1 from stock where product_id=p_product and location_id in(p_from,p_to) order by location_id for update;
  select * into a from stock where product_id=p_product and location_id=p_from;
  select * into b from stock where product_id=p_product and location_id=p_to;
  if a.product_id is null or b.product_id is null then raise exception 'Stock record not found'; end if;
  if a.quantity < p_quantity then raise exception 'Insufficient stock for transfer'; end if;
  update stock set quantity=quantity-p_quantity where product_id=p_product and location_id=p_from;
  update stock set average_cost=(b.quantity*b.average_cost+p_quantity*a.average_cost)/(b.quantity+p_quantity),
    quantity=quantity+p_quantity where product_id=p_product and location_id=p_to;
  insert into movements(product_id,location_id,quantity,unit_cost,reason,note,created_by) values
    (p_product,p_from,-p_quantity,a.average_cost,'TRANSFER_OUT',trim(p_note),auth.uid()),
    (p_product,p_to,p_quantity,a.average_cost,'TRANSFER_IN',trim(p_note),auth.uid());
end $$;

create function public.financial_report(p_from date,p_to date)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_net numeric; v_cogs numeric; v_adjust numeric; v_open numeric; v_close numeric; v_current numeric;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_from is null or p_to is null or p_to<p_from then raise exception 'Choose a valid date range'; end if;
  select coalesce(sum(subtotal-discount),0),coalesce(sum(cogs),0) into v_net,v_cogs
    from sales where created_at >= p_from::timestamp at time zone 'UTC' and created_at < (p_to+1)::timestamp at time zone 'UTC';
  select coalesce(-sum(quantity*unit_cost),0) into v_adjust from movements
    where reason in('CYCLE_COUNT','DAMAGE') and created_at >= p_from::timestamp at time zone 'UTC' and created_at < (p_to+1)::timestamp at time zone 'UTC';
  select coalesce(sum(quantity*unit_cost),0) into v_open from movements where created_at < p_from::timestamp at time zone 'UTC';
  select coalesce(sum(quantity*unit_cost),0) into v_close from movements where created_at < (p_to+1)::timestamp at time zone 'UTC';
  select coalesce(sum(quantity*average_cost),0) into v_current from stock;
  return jsonb_build_object('net_sales',v_net,'cogs',v_cogs,'gross_profit',v_net-v_cogs,
    'inventory_adjustment_expense',round(v_adjust,2),'operating_profit',round(v_net-v_cogs-v_adjust,2),
    'opening_inventory',round(v_open,2),'closing_inventory',round(v_close,2),'current_inventory',round(v_current,2),
    'turnover',case when (v_open+v_close)>0 then round(v_cogs/((v_open+v_close)/2),3) else null end);
end $$;

create function public.sales_summary(p_from date,p_to date)
returns jsonb language plpgsql security definer set search_path = public as $$
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_from is null or p_to is null or p_to<p_from then raise exception 'Choose a valid date range'; end if;
  return jsonb_build_object(
    'receipt_count',(select count(*) from sales where (created_at at time zone 'UTC')::date between p_from and p_to),
    'daily_sales',coalesce((select jsonb_agg(x order by x.day) from (
      select (created_at at time zone 'UTC')::date as day,sum(subtotal-discount) as revenue
      from sales where (created_at at time zone 'UTC')::date between p_from and p_to group by 1
    )x),'[]'::jsonb),
    'top_items',coalesce((select jsonb_agg(x) from (
      select p.name,p.sku,sum(l.quantity) as units,sum(l.quantity*l.unit_price) as sales
      from sale_lines l join products p on p.id=l.product_id join sales s on s.id=l.sale_id
      where (s.created_at at time zone 'UTC')::date between p_from and p_to
      group by p.id order by sum(l.quantity) desc,p.sku limit 8
    )x),'[]'::jsonb)
  );
end $$;

revoke all on function public.checkout(uuid,uuid,uuid,jsonb,numeric) from public,anon;
revoke all on function public.adjust_stock(uuid,uuid,integer,text,text) from public,anon;
revoke all on function public.transfer_stock(uuid,uuid,uuid,integer,text) from public,anon;
revoke all on function public.financial_report(date,date) from public,anon;
revoke all on function public.sales_summary(date,date) from public,anon;
grant execute on function public.checkout(uuid,uuid,uuid,jsonb,numeric),public.adjust_stock(uuid,uuid,integer,text,text),
  public.transfer_stock(uuid,uuid,uuid,integer,text),public.financial_report(date,date),public.sales_summary(date,date) to authenticated;

-- Realtime plus a browser polling fallback. Safe if the project has no publication.
do $$ declare t text; begin
  if exists(select 1 from pg_publication where pubname='supabase_realtime') then
    foreach t in array array['stock','sales','movements'] loop
      if not exists(select 1 from pg_publication_tables where pubname='supabase_realtime' and schemaname='public' and tablename=t) then
        execute format('alter publication supabase_realtime add table public.%I',t);
      end if;
    end loop;
  end if;
end $$;
commit;
