-- Fictional data only. Safe to run again: settings.seeded prevents duplication.
begin;
do $$
declare
  v_location uuid; v_product record; s stock%rowtype; d date; n integer; j integer; idx integer;
  sid uuid; pid uuid; v_qty integer; receipt_count integer; basket_count integer;
  v_subtotal numeric; v_cogs numeric; v_tax numeric; receive_qty integer; receipt_cost numeric;
  start_day date := (current_date-interval '6 months')::date;
  item_codes text[] := array[
    'PEN','PEN','PEN','PENCIL','PENCIL','NOTEBOOK','NOTEBOOK','NOTEBOOK',
    'ERASER','HIGHLIGHTER','FOLDER','INDEX','STICKY','BINDER','PAPER',
    'RULER','GLUE','SCISSORS','MARKERS','CRAYONS','TAPE','STAPLER','CALCULATOR','USB','CLIPS',
    'KIT-STUDY','KIT-EXAM','KIT-ART','KIT-DESK','KIT-PRESENT'];
begin
  if exists(select 1 from settings where id and seeded) then
    raise notice 'Sample data already exists; no changes made.'; return;
  end if;
  insert into settings(id) values(true) on conflict do nothing;
  insert into locations(id,name) values
    (md5('storefront')::uuid,'Storefront'),
    (md5('stockroom')::uuid,'Stockroom'),
    (md5('pickup')::uuid,'Campus Pickup');
  insert into suppliers(id,name,email,phone,quoted_lead_days,payment_term_days) values
    (md5('supplier1')::uuid,'Wasatch Paper Works','orders@wasatch-paper.example','801-555-0101',5,30),
    (md5('supplier2')::uuid,'Summit Writing Supply','orders@summit-writing.example','801-555-0102',4,30),
    (md5('supplier3')::uuid,'Canyon Art Materials','orders@canyon-art.example','801-555-0103',8,30),
    (md5('supplier4')::uuid,'Valley Office Essentials','orders@valley-office.example','801-555-0104',6,15),
    (md5('supplier5')::uuid,'Peak Tech Wholesale','orders@peak-tech.example','801-555-0105',12,30),
    (md5('supplier6')::uuid,'Aspen Packaging','orders@aspen-packaging.example','801-555-0106',7,15);
  insert into products(id,sku,barcode,name,category,supplier_id,standard_cost,price,reorder_point,lead_days,is_kit)
  select md5(x.sku)::uuid,x.sku,'CS'||lpad(row_number() over()::text,5,'0'),x.name,x.category,
    case when x.supplier=0 then null else md5('supplier'||x.supplier)::uuid end,
    x.cost,x.price,x.reorder,x.lead,x.kit
  from (values
    ('PEN','Blue ballpoint pen','Writing',2,0.35,1.00,35,4,false),
    ('PENCIL','No. 2 pencil','Writing',2,0.20,0.60,40,4,false),
    ('NOTEBOOK','College ruled notebook','Paper',1,1.10,2.75,30,5,false),
    ('ERASER','White block eraser','Writing',2,0.25,0.75,22,4,false),
    ('HIGHLIGHTER','Yellow highlighter','Writing',2,0.55,1.50,20,4,false),
    ('FOLDER','Two pocket folder','Paper',1,0.40,1.00,24,5,false),
    ('INDEX','Index cards · 100 pack','Paper',1,0.90,2.25,18,5,false),
    ('STICKY','Sticky note pad','Paper',1,0.65,1.75,20,5,false),
    ('BINDER','One inch binder','Organization',4,1.80,4.50,14,6,false),
    ('PAPER','Loose leaf paper · 100 sheets','Paper',1,1.20,3.00,20,5,false),
    ('RULER','12 inch ruler','Art',3,0.45,1.25,10,8,false),
    ('GLUE','Glue stick','Art',3,0.50,1.50,14,8,false),
    ('SCISSORS','Student scissors','Art',3,1.25,3.25,10,8,false),
    ('MARKERS','Washable markers · 8 pack','Art',3,2.10,5.25,12,8,false),
    ('CRAYONS','Crayons · 24 pack','Art',3,0.95,2.50,12,8,false),
    ('TAPE','Clear tape dispenser','Organization',6,0.75,2.00,10,7,false),
    ('STAPLER','Mini stapler','Organization',4,1.65,4.25,10,6,false),
    ('CALCULATOR','Basic calculator','Technology',5,3.50,8.50,8,12,false),
    ('USB','32 GB USB drive','Technology',5,3.00,7.50,10,12,false),
    ('CLIPS','Binder clips · 12 pack','Organization',4,0.80,2.25,10,6,false),
    ('KIT-STUDY','Study essentials kit','Kits',0,3.00,8.50,10,2,true),
    ('KIT-EXAM','Exam ready kit','Kits',0,4.15,10.50,10,2,true),
    ('KIT-ART','Creative studio kit','Kits',0,5.25,13.00,8,2,true),
    ('KIT-DESK','Organized desk kit','Kits',0,5.65,14.00,8,2,true),
    ('KIT-PRESENT','Presentation kit','Kits',0,4.40,11.00,8,2,true)
  ) x(sku,name,category,supplier,cost,price,reorder,lead,kit);
  insert into bom(parent_id,component_id,quantity)
  select md5(b.parent)::uuid,md5(b.component)::uuid,b.qty from (values
    ('KIT-STUDY','PEN',2),('KIT-STUDY','NOTEBOOK',1),('KIT-STUDY','HIGHLIGHTER',1),('KIT-STUDY','STICKY',1),
    ('KIT-EXAM','PENCIL',2),('KIT-EXAM','ERASER',1),('KIT-EXAM','CALCULATOR',1),
    ('KIT-ART','MARKERS',1),('KIT-ART','CRAYONS',1),('KIT-ART','GLUE',1),('KIT-ART','SCISSORS',1),('KIT-ART','RULER',1),
    ('KIT-DESK','BINDER',1),('KIT-DESK','PAPER',1),('KIT-DESK','STAPLER',1),('KIT-DESK','CLIPS',1),('KIT-DESK','PENCIL',1),
    ('KIT-PRESENT','USB',1),('KIT-PRESENT','FOLDER',1),('KIT-PRESENT','PEN',1),('KIT-PRESENT','STICKY',1)
  ) b(parent,component,qty);
  -- Opening kit cost is rolled up from its actual BOM, not a typed total.
  update products p set standard_cost=b.cost from
    (select parent_id,sum(b.quantity*c.standard_cost) cost from bom b join products c on c.id=b.component_id group by parent_id)b
    where p.id=b.parent_id;
  insert into customers(id,name,email)
  select md5('customer'||c.n)::uuid,c.name,lower(replace(c.name,' ','.'))||'@example.com'
    from unnest(array['Alex Morgan','Jordan Lee','Taylor Brooks','Casey Rivera','Morgan Ellis',
      'Riley Chen','Avery Patel','Cameron Reed','Jamie Park','Sam Bennett']) with ordinality c(name,n);
  insert into stock(product_id,location_id,quantity,average_cost)
  select p.id,l.id,case when l.name='Stockroom' then p.reorder_point*5 else p.reorder_point*2 end,p.standard_cost
    from products p cross join locations l;
  insert into movements(product_id,location_id,quantity,unit_cost,reason,note,created_at)
  select product_id,location_id,quantity,average_cost,'OPENING','Opening inventory, including preassembled kits',
    (start_day-1)::timestamp at time zone 'UTC' from stock;

  -- Demand follows item popularity, weekday traffic, and back-to-school/exam
  -- peaks. Deterministic variation makes this reproducible rather than flat.
  for d in select generate_series(start_day,current_date-1,interval '1 day')::date loop
    receipt_count := case when extract(dow from d) in(0,6) then 4 else 8 end
      + case when extract(month from d) in(8,9) then 5 when extract(month from d) in(4,12) then 3 else 0 end
      + ((extract(day from d)::int*7)%3);
    for n in 1..receipt_count loop
      v_location := case when n%4=0 then md5('pickup')::uuid else md5('storefront')::uuid end;
      sid := gen_random_uuid();
      v_subtotal := 0; v_cogs := 0;
      insert into sales(id,location_id,customer_id,created_at,subtotal,discount,tax,total,cogs)
        values(sid,v_location,md5('customer'||(1+n%10))::uuid,d::timestamp at time zone 'UTC'+interval '15 hours'+n*interval '12 minutes',0,0,0,0,0);
      basket_count := 1+(n+extract(day from d)::int)%3;
      for j in 1..basket_count loop
        idx := 1+((hashtext(d::text||':'||n||':'||j)::bigint+2147483648)%array_length(item_codes,1))::int;
        pid := md5(item_codes[idx])::uuid;
        -- Avoid duplicate receipt lines; repeated scans are covered by checkout tests.
        if exists(select 1 from sale_lines where sale_id=sid and product_id=pid) then continue; end if;
        select * into v_product from products where id=pid;
        v_qty := case when v_product.sku in('PEN','PENCIL','NOTEBOOK') then 1+(n+j)%3 else 1 end;
        select * into s from stock where product_id=pid and location_id=v_location;
        if s.quantity<greatest(v_qty,v_product.reorder_point) then
          receive_qty := greatest(v_product.reorder_point*3,v_qty);
          receipt_cost := round(v_product.standard_cost*(1+0.015*sin(extract(month from d)+idx)::numeric),2);
          update stock set average_cost=(s.quantity*s.average_cost+receive_qty*receipt_cost)/(s.quantity+receive_qty),
            quantity=quantity+receive_qty where product_id=pid and location_id=v_location;
          insert into movements(product_id,location_id,quantity,unit_cost,reason,note,created_at)
            values(pid,v_location,receive_qty,receipt_cost,'HISTORICAL_RECEIPT','Generated historical replenishment; not a purchase order',
              (select created_at-interval '1 minute' from sales where id=sid));
          select * into s from stock where product_id=pid and location_id=v_location;
        end if;
        insert into sale_lines(sale_id,product_id,quantity,unit_price,unit_cost) values(sid,pid,v_qty,v_product.price,s.average_cost);
        update stock set quantity=quantity-v_qty where product_id=pid and location_id=v_location;
        insert into movements(product_id,location_id,quantity,unit_cost,reason,note,sale_id,created_at)
          select pid,v_location,-v_qty,s.average_cost,'SALE','Generated historical sale',sid,created_at from sales where id=sid;
        v_subtotal := v_subtotal+v_qty*v_product.price;
        v_cogs := v_cogs+round(v_qty*s.average_cost,2);
      end loop;
      v_tax := round(v_subtotal*(select tax_rate from settings where id),2);
      update sales set subtotal=v_subtotal,tax=v_tax,total=v_subtotal+v_tax,cogs=v_cogs where id=sid;
    end loop;
  end loop;
  update settings set seeded=true where id;
end $$;
commit;
