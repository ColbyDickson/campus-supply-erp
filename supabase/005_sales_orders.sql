-- Run once after 004_purchasing.sql. Additive: never reset/reseed shared data.
begin;
create table public.sales_orders (
  id uuid primary key,
  customer_id uuid not null references public.customers(id),
  location_id uuid not null references public.locations(id),
  required_date date not null,
  status text not null default 'Order Placed' check(status in ('Order Placed','Fulfilled','Closed','Cancelled')),
  created_at timestamptz not null default now(),
  created_by uuid not null references auth.users(id),
  fulfilled_at timestamptz,
  closed_at timestamptz,
  cancelled_at timestamptz,
  sale_id uuid unique references public.sales(id),
  subtotal numeric(14,2) not null check(subtotal>=0),
  discount numeric(14,2) not null check(discount between 0 and subtotal),
  tax_rate numeric(6,5) not null check(tax_rate between 0 and 1),
  tax numeric(14,2) not null check(tax>=0),
  total numeric(14,2) not null check(total=subtotal-discount+tax),
  check ((status in ('Fulfilled','Closed')) = (sale_id is not null)),
  check ((sale_id is not null) = (fulfilled_at is not null)),
  check ((status='Closed') = (closed_at is not null)),
  check ((status='Cancelled') = (cancelled_at is not null))
);
create table public.sales_order_lines (
  id uuid primary key default gen_random_uuid(),
  sales_order_id uuid not null references public.sales_orders(id),
  product_id uuid not null references public.products(id),
  quantity integer not null check(quantity between 1 and 10000),
  unit_price numeric(12,2) not null check(unit_price>=0),
  product_name text not null,
  sku text not null,
  unique(sales_order_id,product_id)
);
create index sales_orders_demand_idx on public.sales_orders(status,required_date,location_id);
create index sales_orders_created_idx on public.sales_orders(created_at desc,id);
create index sales_order_lines_product_idx on public.sales_order_lines(product_id);
do $$ declare t text; begin
  foreach t in array array['sales_orders','sales_order_lines'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('create policy staff_read on public.%I for select to authenticated using(public.is_staff())',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
  end loop;
end $$;

-- Orders record confirmed demand, not hard stock reservations. Physical stock,
-- revenue and COGS change only on fulfillment. MRP should read Order Placed lines.
create function public.create_sales_order(p_id uuid,p_customer uuid,p_location uuid,p_required_date date,p_items jsonb,p_discount numeric default 0)
returns uuid language plpgsql security definer set search_path=public as $$
declare r record; v_subtotal numeric:=0; v_rate numeric; v_tax numeric;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_id is null then raise exception 'Request ID required'; end if;
  -- Same lock namespace as checkout; a sales order's ID is its future receipt ID.
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  if exists(select 1 from sales_orders where id=p_id) then
    if not exists(select 1 from sales_orders where id=p_id and created_by=auth.uid()) then raise exception 'Request ID already used'; end if;
    return p_id;
  end if;
  if exists(select 1 from sales where id=p_id) then raise exception 'Request ID already used'; end if;
  if not exists(select 1 from customers where id=p_customer) then raise exception 'Choose a customer'; end if;
  if not exists(select 1 from locations where id=p_location) then raise exception 'Choose a location'; end if;
  if p_required_date is null or p_required_date<(now() at time zone 'UTC')::date then raise exception 'Required date must be today (UTC) or later'; end if;
  if p_discount is null or p_discount::text in ('NaN','Infinity','-Infinity') or p_discount<0 or p_discount<>round(p_discount,2) then raise exception 'Enter a nonnegative discount with at most two decimals'; end if;
  if p_items is null or jsonb_typeof(p_items)<>'array' then raise exception 'Items must be a list'; end if;
  if jsonb_array_length(p_items) not between 1 and 100 then raise exception 'Add 1–100 item lines'; end if;
  for r in select value x from jsonb_array_elements(p_items) loop
    if r.x->>'product_id' is null or r.x->>'quantity' is null or (r.x->>'quantity') !~ '^[0-9]+$' then raise exception 'Each line needs a product and whole-number quantity'; end if;
    if (r.x->>'quantity')::numeric not between 1 and 10000 then raise exception 'Quantity must be 1–10000'; end if;
    if not exists(select 1 from products where id=(r.x->>'product_id')::uuid) then raise exception 'Unknown product'; end if;
  end loop;
  -- Lock catalog prices against concurrent edits until all snapshots are stored.
  perform 1 from products where id in (select (x->>'product_id')::uuid from jsonb_array_elements(p_items) x) order by id for share;
  select sum((x->>'quantity')::integer*p.price) into v_subtotal from jsonb_array_elements(p_items) x join products p on p.id=(x->>'product_id')::uuid;
  if p_discount>v_subtotal then raise exception 'Discount exceeds subtotal'; end if;
  select tax_rate into strict v_rate from settings where id;
  v_tax:=round((v_subtotal-p_discount)*v_rate,2);
  insert into sales_orders(id,customer_id,location_id,required_date,created_by,subtotal,discount,tax_rate,tax,total)
    values(p_id,p_customer,p_location,p_required_date,auth.uid(),v_subtotal,p_discount,v_rate,v_tax,v_subtotal-p_discount+v_tax);
  insert into sales_order_lines(sales_order_id,product_id,quantity,unit_price,product_name,sku)
    select p_id,p.id,sum((x->>'quantity')::integer)::integer,p.price,p.name,p.sku
    from jsonb_array_elements(p_items) x join products p on p.id=(x->>'product_id')::uuid group by p.id;
  return p_id;
end $$;

create function public.transition_sales_order(p_order uuid,p_status text)
returns uuid language plpgsql security definer set search_path=public as $$
declare o sales_orders%rowtype; r record; s stock%rowtype; v_cogs numeric:=0;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_status is null or p_status not in ('Fulfilled','Closed','Cancelled') then raise exception 'Choose Fulfilled, Closed or Cancelled'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_order::text,0));
  select * into o from sales_orders where id=p_order for update;
  if not found then raise exception 'Sales order not found'; end if;
  -- Repeated status requests cannot create another sale, even after closing.
  if o.status=p_status or (o.status='Closed' and p_status='Fulfilled') then return p_order; end if;
  if p_status='Cancelled' and o.status='Order Placed' then
    update sales_orders set status='Cancelled',cancelled_at=now() where id=p_order;
  elsif p_status='Closed' and o.status='Fulfilled' then
    update sales_orders set status='Closed',closed_at=now() where id=p_order;
  elsif p_status='Fulfilled' and o.status='Order Placed' then
    if exists(select 1 from sales where id=p_order) then raise exception 'Receipt ID already used; contact the coordinator'; end if;
    for r in select * from sales_order_lines where sales_order_id=p_order order by product_id loop
      select * into s from stock where product_id=r.product_id and location_id=o.location_id for update;
      if not found or s.quantity<r.quantity then raise exception 'Insufficient stock for %. Receive or transfer stock, then retry fulfillment.',r.product_name; end if;
      v_cogs:=v_cogs+round(r.quantity*s.average_cost,2);
    end loop;
    insert into sales(id,location_id,customer_id,created_by,subtotal,discount,tax,total,cogs)
      values(p_order,o.location_id,o.customer_id,auth.uid(),o.subtotal,o.discount,o.tax,o.total,v_cogs);
    for r in select * from sales_order_lines where sales_order_id=p_order order by product_id loop
      select * into strict s from stock where product_id=r.product_id and location_id=o.location_id;
      insert into sale_lines(sale_id,product_id,quantity,unit_price,unit_cost)
        values(p_order,r.product_id,r.quantity,r.unit_price,s.average_cost);
      update stock set quantity=quantity-r.quantity where product_id=r.product_id and location_id=o.location_id;
      insert into movements(product_id,location_id,quantity,unit_cost,reason,note,sale_id,created_by)
        values(r.product_id,o.location_id,-r.quantity,s.average_cost,'SALE','Sales order fulfillment',p_order,auth.uid());
    end loop;
    update sales_orders set status='Fulfilled',fulfilled_at=now(),sale_id=p_order where id=p_order;
  else raise exception 'Cannot change % to %',o.status,p_status;
  end if;
  return p_order;
end $$;
revoke all on function public.create_sales_order(uuid,uuid,uuid,date,jsonb,numeric) from public,anon;
revoke all on function public.transition_sales_order(uuid,text) from public,anon;
grant execute on function public.create_sales_order(uuid,uuid,uuid,date,jsonb,numeric) to authenticated;
grant execute on function public.transition_sales_order(uuid,text) to authenticated;
commit;
