-- Apply once after 005. Extends the shared database without resetting data.
begin;
alter table public.purchase_orders drop constraint purchase_orders_status_check;
alter table public.purchase_orders add constraint purchase_orders_status_check check(status in('Draft','Order Sent','Received','Closed'));
alter table public.purchase_orders alter column sent_at drop not null;
alter table public.purchase_orders alter column expected_date drop not null;
alter table public.purchase_orders add column delivery_location_id uuid references public.locations(id);
alter table public.purchase_orders add column dispatch_method text;
alter table public.purchase_orders add column dispatch_reference text;
alter table public.purchase_orders add column source text not null default 'manual';
alter table public.purchase_orders add column closure_reason text;
alter table public.purchase_orders add column request_payload jsonb;
alter table public.purchase_orders add column planning_date date;
alter table public.purchase_orders add column planning_note text;
alter table public.purchase_lines add column cancelled_quantity integer not null default 0
  check(cancelled_quantity>=0 and cancelled_quantity+received<=quantity);
alter table public.purchase_receipts add column due_date date;
update public.purchase_receipts r set due_date=(r.received_at at time zone 'UTC')::date+o.payment_term_days
  from public.purchase_lines l join public.purchase_orders o on o.id=l.purchase_order_id where l.id=r.line_id;
alter table public.purchase_receipts alter column due_date set not null;

create table public.supplier_payments(
  id uuid primary key, receipt_id uuid not null references public.purchase_receipts(id),
  amount numeric(14,2) not null check(amount>0 and amount::text not in('NaN','Infinity')),
  paid_on date not null, reference text not null, source text not null default 'manual',
  created_by uuid not null references auth.users(id),created_at timestamptz not null default now()
);
create index supplier_payments_receipt_idx on public.supplier_payments(receipt_id);
create table public.item_planning(
  product_id uuid primary key references public.products(id),
  safety_stock integer not null default 0 check(safety_stock between 0 and 1000000),
  review_days integer not null default 7 check(review_days between 1 and 365)
);
insert into public.item_planning select id,ceil(reorder_point*0.25),7 from public.products;
create table public.planning_reviews(
  id uuid primary key,product_id uuid not null references public.products(id),
  decision text not null check(decision in('Order','Defer','Sufficient')),
  note text not null check(length(trim(note))>=3), snapshot jsonb not null,
  created_by uuid not null references auth.users(id),reviewed_at timestamptz not null default now()
);
create index planning_reviews_item_idx on public.planning_reviews(product_id,reviewed_at desc);
create table public.supplier_history_imports(id text primary key,applied_at timestamptz not null default now(),linked_movements integer not null);
-- Production integration contract: the production owner may replace this view
-- with issued, not-yet-received build output whose components are already
-- deducted from stock. Do not include unissued or suggested MRP builds.
create view public.mrp_firm_build_supply with(security_invoker=true) as
  select null::uuid product_id,null::uuid location_id,null::date available_date,0::integer quantity where false;
revoke all on public.mrp_firm_build_supply from public,anon,authenticated;
grant select on public.mrp_firm_build_supply to authenticated;
do $$ declare t text; begin
  foreach t in array array['supplier_payments','item_planning','planning_reviews','supplier_history_imports'] loop
    execute format('alter table public.%I enable row level security',t);
    execute format('create policy staff_read on public.%I for select to authenticated using(public.is_staff())',t);
    execute format('revoke all on public.%I from public,anon,authenticated',t);
    execute format('grant select on public.%I to authenticated',t);
  end loop;
end $$;

create function public.mrp_plan()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_today date:=(now() at time zone 'UTC')::date; v_end date:=v_today+27;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if exists(select 1 from bom b join products c on c.id=b.component_id where c.is_kit) then
    raise exception 'This MRP supports single-level BOMs; nested kit components need a planning extension';
  end if;
  return (with recursive
    demand as(select l.product_id,o.location_id,greatest(o.required_date,v_today) event_date,min(o.required_date) raw_date,
      sum(l.quantity)::numeric gross,'Sales orders '||string_agg(distinct left(o.id::text,8),', ') explanation
      from sales_order_lines l join sales_orders o on o.id=l.sales_order_id
      where o.status='Order Placed' and o.required_date<=v_end group by 1,2,3),
    inventory as(select product_id,location_id,quantity::numeric quantity from stock),
    kit_events as(
      select d.product_id,d.location_id,d.event_date,d.raw_date,d.gross,0::numeric supply,d.explanation
        from demand d join products p on p.id=d.product_id where p.is_kit
      union all
      select f.product_id,f.location_id,greatest(f.available_date,v_today),f.available_date,0::numeric,f.quantity::numeric,'Firm scheduled build'
        from mrp_firm_build_supply f join products p on p.id=f.product_id
        where p.is_kit and f.quantity>0 and f.available_date>=v_today and f.available_date<=v_end),
    kit_timeline as(select product_id,location_id,event_date,
      coalesce(min(raw_date) filter(where gross>0),event_date) raw_date,sum(gross) gross,sum(supply) supply,
      string_agg(explanation,'; ') explanation,row_number() over(partition by product_id,location_id order by event_date) n
      from kit_events group by 1,2,3),
    kit_net as(
      select t.*,coalesce(i.quantity,0)::numeric opening,
        greatest(0::numeric,coalesce(i.quantity,0)+t.supply-t.gross) projected,
        greatest(0::numeric,t.gross-coalesce(i.quantity,0)-t.supply) planned
      from kit_timeline t left join inventory i using(product_id,location_id) where t.n=1
      union all
      select t.*,k.projected opening,greatest(0::numeric,k.projected+t.supply-t.gross) projected,
        greatest(0::numeric,t.gross-k.projected-t.supply) planned
      from kit_net k join kit_timeline t on t.product_id=k.product_id and t.location_id=k.location_id and t.n=k.n+1),
    buy_demand as(
      select d.* from demand d join products p on p.id=d.product_id where not p.is_kit
      union all
      select b.component_id,k.location_id,greatest(v_today,k.raw_date-p.lead_days),k.raw_date-p.lead_days,
        k.planned*b.quantity,'Build '||k.planned::text||' × '||p.name||'; '||k.explanation
      from kit_net k join products p on p.id=k.product_id join bom b on b.parent_id=k.product_id where k.planned>0),
    open_supply as(select l.product_id,o.delivery_location_id location_id,coalesce(o.planning_date,o.expected_date) event_date,
      sum(l.quantity-l.received-l.cancelled_quantity)::numeric supply
      from purchase_lines l join purchase_orders o on o.id=l.purchase_order_id where o.status='Order Sent'
      and l.quantity>l.received+l.cancelled_quantity group by 1,2,3),
    buy_events as(
      select product_id,location_id,event_date,raw_date,gross,0::numeric supply,explanation from buy_demand
      union all select product_id,location_id,event_date,event_date,0::numeric,supply,'Open PO arriving by this date'
        from open_supply where location_id is not null and event_date between v_today and v_end),
    buy_timeline as(select product_id,location_id,event_date,
      coalesce(min(raw_date) filter(where gross>0),event_date) raw_date,sum(gross) gross,sum(supply) supply,
      string_agg(explanation,'; ') explanation,row_number() over(partition by product_id,location_id order by event_date) n
      from buy_events group by 1,2,3),
    buy_net as(
      select t.*,coalesce(i.quantity,0)::numeric opening,
        greatest(0::numeric,coalesce(i.quantity,0)+t.supply-t.gross) projected,
        greatest(0::numeric,t.gross-coalesce(i.quantity,0)-t.supply) planned
      from buy_timeline t left join inventory i using(product_id,location_id) where t.n=1
      union all
      select t.*,k.projected opening,greatest(0::numeric,k.projected+t.supply-t.gross) projected,
        greatest(0::numeric,t.gross-k.projected-t.supply) planned
      from buy_net k join buy_timeline t on t.product_id=k.product_id and t.location_id=k.location_id and t.n=k.n+1),
    net as(select *, 'Make'::text action from kit_net where gross>0 union all select *,'Buy'::text action from buy_net where gross>0)
    select jsonb_build_object('as_of',v_today,'through',v_end,
      'confirmed_orders',(select count(*) from sales_orders where status='Order Placed' and required_date<=v_end),
      'bom_parents',(select count(distinct parent_id) from bom),
      'firm_build_units',(select coalesce(sum(quantity),0) from mrp_firm_build_supply where quantity>0 and available_date between v_today and v_end),
      'unassigned_incoming',(select coalesce(sum(supply),0) from open_supply where location_id is null),
      'overdue_incoming',(select coalesce(sum(supply),0) from open_supply where event_date<v_today),
      'missing_boms',(select count(*) from products p where is_kit and not exists(select 1 from bom where parent_id=p.id)),
      'rows',coalesce((select jsonb_agg(jsonb_build_object('product_id',n.product_id,'name',p.name,'sku',p.sku,'supplier_id',p.supplier_id,
        'location_id',n.location_id,'action',n.action,'week',1+(n.event_date-v_today)/7,'event_date',n.event_date,'required_date',n.raw_date,
        'gross',n.gross,'opening',n.opening,'incoming',n.supply,'suggested_quantity',n.planned,'projected_balance',n.projected,
        'lead_days',p.lead_days,'order_by',case when n.planned>0 then n.raw_date-p.lead_days else null end,
        'late',n.planned>0 and n.raw_date-p.lead_days<v_today,'explanation',n.explanation,
        'other_location_stock',(select coalesce(sum(quantity),0) from stock where product_id=n.product_id and location_id<>n.location_id)
      ) order by n.event_date,n.action,p.name,n.location_id) from net n join products p on p.id=n.product_id),'[]'::jsonb)));
end $$;

create function public.save_supplier(p_id uuid,p_name text,p_email text,p_phone text,p_lead integer,p_terms integer)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_id is null or p_name is null or length(trim(p_name)) not between 2 and 150
    or p_email is null or p_email!~'^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
    or p_phone is null or length(trim(p_phone)) not between 3 and 50
    or p_lead is null or p_lead not between 0 and 365 or p_terms is null or p_terms not between 0 and 365 then
    raise exception 'Enter a name, email, phone, and lead/payment days from 0–365';
  end if;
  insert into suppliers(id,name,email,phone,quoted_lead_days,payment_term_days)
    values(p_id,trim(p_name),trim(p_email),trim(p_phone),p_lead,p_terms)
    on conflict(id) do update set name=excluded.name,email=excluded.email,phone=excluded.phone,
      quoted_lead_days=excluded.quoted_lead_days,payment_term_days=excluded.payment_term_days;
  -- Component planning follows the supplier's current quote; PO snapshots stay fixed.
  update products set lead_days=p_lead where supplier_id=p_id and not is_kit;
  return p_id;
end $$;

create function public.supplier_scorecards()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  return (with
    receipts as(select r.*,l.purchase_order_id from purchase_receipts r join purchase_lines l on l.id=r.line_id
      where (r.received_at at time zone 'UTC')::date<=(now() at time zone 'UTC')::date),
    ordered as(select purchase_order_id,sum(quantity) quantity from purchase_lines group by 1),
    received as(select purchase_order_id,sum(quantity) quantity,max((received_at at time zone 'UTC')::date) last_date from receipts group by 1),
    orders as(select o.*,q.quantity ordered,coalesce(r.quantity,0) received,r.last_date,
        (o.expected_date<=(now() at time zone 'UTC')::date or coalesce(r.quantity,0)>=q.quantity) eligible
      from purchase_orders o join ordered q on q.purchase_order_id=o.id left join received r on r.purchase_order_id=o.id
      where o.status<>'Draft' and o.sent_at is not null),
    performance as(select supplier_id,count(*) orders,
        count(*) filter(where eligible) eligible_orders,
        avg(case when received>=ordered and last_date<=expected_date then 1.0 else 0 end) filter(where eligible) on_time_rate,
        sum(received) filter(where eligible)/nullif(sum(ordered) filter(where eligible),0)::numeric fill_rate,
        count(*) filter(where source='historical_import') sample_orders
      from orders group by 1),
    leads as(select o.supplier_id,
      sum(((r.received_at at time zone 'UTC')::date-(o.sent_at at time zone 'UTC')::date)*r.quantity)::numeric/nullif(sum(r.quantity),0) actual_days,
      sum(o.quoted_lead_days*r.quantity)::numeric/nullif(sum(r.quantity),0) quoted_days
      from receipts r join purchase_orders o on o.id=r.purchase_order_id group by 1),
    paid as(select receipt_id,sum(amount) amount from supplier_payments group by 1),
    debt as(select o.supplier_id,sum(greatest(0,r.quantity*r.unit_cost-coalesce(p.amount,0))) owed,
        sum(case when r.due_date<(now() at time zone 'UTC')::date then greatest(0,r.quantity*r.unit_cost-coalesce(p.amount,0)) else 0 end) overdue
      from receipts r join purchase_orders o on o.id=r.purchase_order_id left join paid p on p.receipt_id=r.id group by 1)
    select coalesce(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'email',s.email,'phone',s.phone,
      'quoted_lead_days',s.quoted_lead_days,'payment_term_days',s.payment_term_days,
      'orders',coalesce(p.orders,0),'eligible_orders',coalesce(p.eligible_orders,0),'sample_orders',coalesce(p.sample_orders,0),
      'on_time_rate',p.on_time_rate,'fill_rate',p.fill_rate,'actual_days',l.actual_days,'quoted_days',l.quoted_days,
      'owed',coalesce(d.owed,0),'overdue',coalesce(d.overdue,0),
      'rating',case when coalesce(p.orders,0)=0 then 'No history' when coalesce(p.eligible_orders,0)=0 then 'Observing'
        when p.on_time_rate<0.70 or p.fill_rate<0.80 or l.actual_days>greatest(l.quoted_days*1.75,2) then 'Replace'
        when p.on_time_rate>=0.90 and p.fill_rate>=0.95 and coalesce(l.actual_days,0)<=greatest(l.quoted_days*1.25,1) then 'Keep' else 'Watch' end
    ) order by s.name),'[]'::jsonb) from suppliers s left join performance p on p.supplier_id=s.id
      left join leads l on l.supplier_id=s.id left join debt d on d.supplier_id=s.id);
end $$;

create function public.supplier_bills(p_supplier uuid,p_page integer default 0)
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_page is null or p_page not between 0 and 100000 then raise exception 'Invalid page'; end if;
  return (select coalesce(jsonb_agg(x),'[]'::jsonb) from (
    select r.id,r.received_at,r.due_date,r.quantity,r.unit_cost,o.id po_id,o.source,p.name product,
      r.quantity*r.unit_cost amount,coalesce(pay.amount,0) paid,r.quantity*r.unit_cost-coalesce(pay.amount,0) outstanding,
      coalesce(pay.payments,'[]'::jsonb) payments
    from purchase_receipts r join purchase_lines l on l.id=r.line_id join purchase_orders o on o.id=l.purchase_order_id join products p on p.id=l.product_id
    left join lateral(select sum(amount) amount,jsonb_agg(jsonb_build_object('amount',amount,'paid_on',paid_on,'reference',reference) order by paid_on) payments
      from supplier_payments where receipt_id=r.id)pay on true
    where o.supplier_id=p_supplier order by (r.quantity*r.unit_cost>coalesce(pay.amount,0)) desc,r.due_date,r.id limit 21 offset p_page*20
  )x);
end $$;

create function public.replenishment_plan()
returns jsonb language plpgsql stable security definer set search_path=public,pg_temp as $$
declare v_today date:=(now() at time zone 'UTC')::date; v_from date;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  v_from:=(v_today-interval '6 months')::date;
  return (with
    -- A kit's historical sales imply component usage. Do not also count build
    -- movements: this avoids double counting once production is integrated.
    sold as(select l.product_id,sum(l.quantity)::numeric quantity from sale_lines l join sales s on s.id=l.sale_id
      where s.created_at>=v_from::timestamp at time zone 'UTC' and s.created_at<(v_today+1)::timestamp at time zone 'UTC' group by 1),
    usage as(select product_id,sum(quantity) quantity from (
      select * from sold union all select b.component_id,s.quantity*b.quantity from sold s join bom b on b.parent_id=s.product_id
    )u group by 1),
    inventory as(select product_id,sum(quantity) quantity,sum(quantity*average_cost)/nullif(sum(quantity),0) cost from stock group by 1),
    incoming as(select l.product_id,sum(l.quantity-l.received-l.cancelled_quantity) quantity from purchase_lines l join purchase_orders o on o.id=l.purchase_order_id
      where o.status='Order Sent' group by 1),
    base as(select p.*,coalesce(pol.safety_stock,0) safety_stock,coalesce(pol.review_days,7) review_days,
      coalesce(u.quantity,0)/(v_today-v_from+1) daily_usage,coalesce(i.quantity,0) on_hand,coalesce(i.cost,p.standard_cost) unit_cost,
      coalesce(inc.quantity,0) incoming,rev.reviewed_at,rev.decision last_decision,
      s.ordering_cost,s.annual_holding_rate
      from products p cross join settings s left join usage u on u.product_id=p.id left join inventory i on i.product_id=p.id
      left join incoming inc on inc.product_id=p.id left join item_planning pol on pol.product_id=p.id
      left join lateral(select reviewed_at,decision from planning_reviews where product_id=p.id order by reviewed_at desc limit 1)rev on true),
    calculated as(select *,ceil(daily_usage*lead_days+safety_stock) reorder_level,
      case when daily_usage>0 and unit_cost>0 then ceil(sqrt(2*daily_usage*365*ordering_cost/(unit_cost*annual_holding_rate))) else null end eoq,
      on_hand+incoming inventory_position from base),
    suggested as(select *,case when inventory_position<reorder_level or(daily_usage>0 and inventory_position<=reorder_level)
      then greatest(coalesce(eoq,0),ceil(daily_usage*(lead_days+review_days)+safety_stock-inventory_position),0) else 0 end suggested_quantity
      from calculated)
    select coalesce(jsonb_agg(jsonb_build_object('id',id,'sku',sku,'name',name,'is_kit',is_kit,'supplier_id',supplier_id,'lead_days',lead_days,
      'safety_stock',safety_stock,'review_days',review_days,'daily_usage',daily_usage,'annual_demand',daily_usage*365,
      'unit_cost',unit_cost,'holding_cost',unit_cost*annual_holding_rate,'ordering_cost',ordering_cost,'holding_rate',annual_holding_rate,
      'on_hand',on_hand,'incoming',incoming,'inventory_position',inventory_position,'reorder_point',reorder_level,'eoq',eoq,
      'suggested_quantity',suggested_quantity,
      'order_by',case when suggested_quantity>0 then v_today+case when daily_usage>0 then floor(greatest(on_hand-safety_stock,0)/daily_usage)::int else 0 end-lead_days else null end,
      'last_reviewed',reviewed_at,'last_decision',last_decision,
      'review_due',case when reviewed_at is null then v_today else (reviewed_at at time zone 'UTC')::date+review_days end,
      'history_from',v_from,'history_through',v_today,'history_days',v_today-v_from+1
    ) order by suggested_quantity desc,name),'[]'::jsonb) from suggested);
end $$;

create function public.review_planning_item(p_id uuid,p_product uuid,p_decision text,p_note text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_snapshot jsonb;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_id is null or p_decision is null or p_decision not in('Order','Defer','Sufficient') or p_note is null or length(trim(p_note))<3 then raise exception 'Enter a decision and review explanation'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  if exists(select 1 from planning_reviews where id=p_id) then
    if not exists(select 1 from planning_reviews where id=p_id and created_by=auth.uid() and product_id=p_product and decision=p_decision and note=trim(p_note)) then raise exception 'Request ID already used'; end if;
    return p_id;
  end if;
  select value into v_snapshot from jsonb_array_elements(replenishment_plan()) where value->>'id'=p_product::text;
  if v_snapshot is null then raise exception 'Item not found'; end if;
  insert into planning_reviews(id,product_id,decision,note,snapshot,created_by) values(p_id,p_product,p_decision,trim(p_note),v_snapshot,auth.uid());
  -- Store the reviewed setting too; the UI always prefers the live calculation.
  update products set reorder_point=(v_snapshot->>'reorder_point')::int where id=p_product;
  return p_id;
end $$;

create function public.save_item_policy(p_product uuid,p_supplier uuid,p_lead integer,p_safety integer,p_review integer)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_lead is null or p_lead not between 0 and 365 or p_safety is null or p_safety not between 0 and 1000000
    or p_review is null or p_review not between 1 and 365 then raise exception 'Invalid planning settings'; end if;
  if not exists(select 1 from products where id=p_product and (is_kit or exists(select 1 from suppliers where id=p_supplier))) then
    raise exception 'Choose an item and a supplier for purchased items'; end if;
  update products set supplier_id=case when is_kit then null else p_supplier end,lead_days=p_lead where id=p_product;
  insert into item_planning values(p_product,p_safety,p_review) on conflict(product_id)
    do update set safety_stock=excluded.safety_stock,review_days=excluded.review_days;
end $$;

create function public.save_ordering_settings(p_ordering numeric,p_holding numeric)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_ordering is null or p_ordering::text in('NaN','Infinity','-Infinity') or p_ordering<=0 or p_ordering>1000000
    or p_holding is null or p_holding::text in('NaN','Infinity','-Infinity') or p_holding<=0 or p_holding>10 then
    raise exception 'Ordering cost must be positive and holding rate must be greater than zero and at most 1000 percent'; end if;
  update settings set ordering_cost=p_ordering,annual_holding_rate=p_holding where id;
end $$;

create function public.create_purchase_draft(p_id uuid,p_supplier uuid,p_location uuid,p_items jsonb)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_payload jsonb; v_existing purchase_orders%rowtype;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_id is null or not exists(select 1 from locations where id=p_location) then raise exception 'Choose a delivery location'; end if;
  v_payload:=jsonb_build_object('supplier',p_supplier,'location',p_location,'items',p_items);
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  select * into v_existing from purchase_orders where id=p_id;
  if found then
    if v_existing.created_by<>auth.uid() or v_existing.request_payload is distinct from v_payload then raise exception 'Request ID already used'; end if;
    return p_id;
  end if;
  perform create_purchase_order(p_id,p_supplier,p_items);
  update purchase_orders set status='Draft',sent_at=null,expected_date=null,delivery_location_id=p_location,request_payload=v_payload where id=p_id;
  return p_id;
end $$;

create function public.dispatch_purchase(p_order uuid,p_method text,p_reference text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare o purchase_orders%rowtype; s suppliers%rowtype;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_method is null or p_method not in('Email','Printed / shared document','Manual') or p_reference is null or length(trim(p_reference))<3 then raise exception 'Record how and to whom the PO was sent'; end if;
  select * into o from purchase_orders where id=p_order for update;
  if not found then raise exception 'PO not found'; end if;
  if o.status<>'Draft' then return; end if;
  select * into strict s from suppliers where id=o.supplier_id;
  update purchase_orders set status='Order Sent',sent_at=now(),quoted_lead_days=s.quoted_lead_days,payment_term_days=s.payment_term_days,
    expected_date=(now() at time zone 'UTC')::date+s.quoted_lead_days,dispatch_method=p_method,dispatch_reference=trim(p_reference) where id=p_order;
end $$;

create function public.update_purchase_delivery(p_order uuid,p_location uuid,p_expected date,p_note text)
returns void language plpgsql security definer set search_path=public,pg_temp as $$
declare o purchase_orders%rowtype;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if not exists(select 1 from locations where id=p_location) or p_expected is null or p_note is null or length(trim(p_note))<3 then raise exception 'Choose location, expected date and an explanation'; end if;
  select * into o from purchase_orders where id=p_order for update;
  if not found or o.status<>'Order Sent' then raise exception 'Only an open sent PO can be rescheduled'; end if;
  if p_expected<(o.sent_at at time zone 'UTC')::date then raise exception 'Expected delivery cannot precede sending'; end if;
  -- Original expected date is retained for supplier scorecards; planning ETA may change.
  update purchase_orders set delivery_location_id=p_location,planning_date=p_expected,planning_note=trim(p_note) where id=p_order;
end $$;

create or replace function public.receive_purchase(p_id uuid,p_line uuid,p_location uuid,p_quantity integer)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare v_order_id uuid; o purchase_orders%rowtype; l purchase_lines%rowtype; s stock%rowtype;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_id is null then raise exception 'Request ID required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  if exists(select 1 from purchase_receipts where id=p_id) then
    if not exists(select 1 from purchase_receipts where id=p_id and created_by=auth.uid() and line_id=p_line and location_id=p_location and quantity=p_quantity) then raise exception 'Request ID already used for a different receipt'; end if;
    return p_id;
  end if;
  if p_quantity is null or p_quantity not between 1 and 10000 then raise exception 'Enter 1–10000 units'; end if;
  select purchase_order_id into v_order_id from purchase_lines where id=p_line;
  if not found then raise exception 'PO line not found'; end if;
  select * into strict o from purchase_orders where id=v_order_id for update;
  if o.status<>'Order Sent' then raise exception 'Only an open PO can receive items'; end if;
  select * into strict l from purchase_lines where id=p_line for update;
  if p_quantity>l.quantity-l.received-l.cancelled_quantity then raise exception 'Quantity exceeds the outstanding PO quantity'; end if;
  if o.delivery_location_id is not null and p_location<>o.delivery_location_id then raise exception 'Receive into the planned location or update the delivery plan first'; end if;
  select * into s from stock where product_id=l.product_id and location_id=p_location for update;
  if not found then raise exception 'Choose a valid inventory location'; end if;
  update stock set quantity=quantity+p_quantity,average_cost=(s.quantity*s.average_cost+p_quantity*l.unit_cost)/(s.quantity+p_quantity)
    where product_id=l.product_id and location_id=p_location;
  insert into purchase_receipts(id,line_id,location_id,quantity,unit_cost,created_by,due_date)
    values(p_id,p_line,p_location,p_quantity,l.unit_cost,auth.uid(),(now() at time zone 'UTC')::date+o.payment_term_days);
  insert into movements(product_id,location_id,quantity,unit_cost,reason,note,purchase_receipt_id,created_by)
    values(l.product_id,p_location,p_quantity,l.unit_cost,'PO_RECEIPT','Receipt against PO '||v_order_id::text,p_id,auth.uid());
  update purchase_lines set received=received+p_quantity where id=p_line;
  if not exists(select 1 from purchase_lines where purchase_order_id=v_order_id and received+cancelled_quantity<quantity) then
    update purchase_orders set status='Received' where id=v_order_id;
  end if;
  return p_id;
end $$;

create function public.record_supplier_payment(p_id uuid,p_receipt uuid,p_amount numeric,p_paid date,p_reference text)
returns uuid language plpgsql security definer set search_path=public,pg_temp as $$
declare r purchase_receipts%rowtype; v_paid numeric; v_previous supplier_payments%rowtype;
begin
  if not is_staff() then raise exception 'Staff access required'; end if;
  if p_id is null then raise exception 'Request ID required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_id::text,0));
  select * into v_previous from supplier_payments where id=p_id;
  if found then
    if v_previous.created_by<>auth.uid() or v_previous.receipt_id is distinct from p_receipt or v_previous.amount is distinct from p_amount
      or v_previous.paid_on is distinct from p_paid or v_previous.reference is distinct from trim(p_reference) then raise exception 'Request ID already used'; end if;
    return p_id;
  end if;
  if p_amount is null or p_amount::text!~'^[0-9]+([.][0-9]{1,2})?$' or p_amount<=0 then raise exception 'Enter a positive payment with at most two decimals'; end if;
  select * into r from purchase_receipts where id=p_receipt for update;
  if not found then raise exception 'Receipt bill not found'; end if;
  if p_paid is null or p_paid<(r.received_at at time zone 'UTC')::date or p_paid>(now() at time zone 'UTC')::date then raise exception 'Payment date must be between receipt and today (UTC)'; end if;
  if p_reference is null or length(trim(p_reference))<3 then raise exception 'Enter a payment reference'; end if;
  select coalesce(sum(amount),0) into v_paid from supplier_payments where receipt_id=p_receipt;
  if p_amount>r.quantity*r.unit_cost-v_paid then raise exception 'Payment exceeds amount owed'; end if;
  insert into supplier_payments(id,receipt_id,amount,paid_on,reference,created_by) values(p_id,p_receipt,p_amount,p_paid,trim(p_reference),auth.uid());
  return p_id;
end $$;

-- Explicit grants: all business mutations and aggregates enforce staff access.
do $$ declare f record; begin
  for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
    ('save_supplier','save_item_policy','save_ordering_settings','create_purchase_draft','dispatch_purchase','update_purchase_delivery',
     'receive_purchase','record_supplier_payment','supplier_scorecards','supplier_bills','replenishment_plan','review_planning_item','mrp_plan') loop
    execute format('revoke all on function %s from public,anon',f.signature);
    execute format('grant execute on function %s to authenticated',f.signature);
  end loop;
end $$;
notify pgrst,'reload schema';
commit;
