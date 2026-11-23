-- Run once after 006. Links existing generated historical replenishments to
-- sample PO/receipt/payment records. DOES NOT receive stock again or change
-- any stock quantity, average cost, sale, or inventory movement value/date.
begin;
do $$
declare r record; v_actor uuid; v_po uuid; v_line uuid; v_receipt uuid;
  v_days integer; v_short integer; v_ordered integer; v_sent timestamptz;
  v_due date; v_payment numeric; v_paid date; v_i integer:=0; v_today date:=(now() at time zone 'UTC')::date;
begin
  if exists(select 1 from supplier_history_imports where id='007_supplier_history') then
    raise notice 'Historical supplier data already linked; nothing changed.';return;
  end if;
  select user_id into v_actor from team_members order by user_id limit 1;
  if v_actor is null then raise exception 'Enroll at least one teammate before importing supplier history'; end if;
  for r in select m.*,p.supplier_id,s.quoted_lead_days,s.payment_term_days
    from movements m join products p on p.id=m.product_id join suppliers s on s.id=p.supplier_id
    where m.reason='HISTORICAL_RECEIPT' and m.quantity>0 and not p.is_kit and m.purchase_receipt_id is null
    order by m.created_at,m.id
  loop
    v_i:=v_i+1;
    v_po:=md5('sample-po:'||r.id)::uuid;v_line:=md5('sample-po-line:'||r.id)::uuid;v_receipt:=md5('sample-receipt:'||r.id)::uuid;
    -- Vary reliability by supplier and over time; all measures are subsequently
    -- computed from these records, never entered as supplier ratings.
    v_days:=greatest(1,r.quoted_lead_days+case
      when r.supplier_id=md5('supplier2')::uuid and v_i%19<>0 then -1
      when r.supplier_id=md5('supplier2')::uuid and v_i%19=0 then 1
      when r.supplier_id=md5('supplier3')::uuid and v_i%5=0 then 3
      when r.supplier_id=md5('supplier4')::uuid and v_i%17=0 then 1
      when r.supplier_id=md5('supplier5')::uuid and v_i%2=0 then 5
      when r.supplier_id=md5('supplier6')::uuid and v_i%4=0 then 2
      when r.supplier_id=md5('supplier1')::uuid and v_i%7=0 then 1 else 0 end);
    v_short:=case when r.supplier_id=md5('supplier5')::uuid and v_i%3=0 then greatest(1,ceil(r.quantity*0.3)::int)
      when v_i%17=0 then greatest(1,ceil(r.quantity*0.1)::int) else 0 end;
    v_ordered:=r.quantity+v_short;v_sent:=r.created_at-make_interval(days=>v_days);
    v_due:=(r.created_at at time zone 'UTC')::date+r.payment_term_days;
    insert into purchase_orders(id,supplier_id,sent_at,quoted_lead_days,payment_term_days,expected_date,status,created_by,
      delivery_location_id,dispatch_method,dispatch_reference,source,closure_reason)
    values(v_po,r.supplier_id,v_sent,r.quoted_lead_days,r.payment_term_days,(v_sent at time zone 'UTC')::date+r.quoted_lead_days,
      'Closed',v_actor,r.location_id,'Manual','Generated historical example','historical_import',
      case when v_short>0 then 'Generated supplier short shipment; remaining units cancelled' else 'Generated completed order' end);
    insert into purchase_lines(id,purchase_order_id,product_id,quantity,received,unit_cost,cancelled_quantity)
      values(v_line,v_po,r.product_id,v_ordered,r.quantity,r.unit_cost,v_short);
    insert into purchase_receipts(id,line_id,location_id,quantity,unit_cost,received_at,created_by,due_date)
      values(v_receipt,v_line,r.location_id,r.quantity,r.unit_cost,r.created_at,v_actor,v_due);
    update movements set purchase_receipt_id=v_receipt where id=r.id;
    v_payment:=case when v_i%11=0 then 0 when v_i%7=0 then round(r.quantity*r.unit_cost*0.5,2) else r.quantity*r.unit_cost end;
    v_paid:=greatest((r.created_at at time zone 'UTC')::date,least(v_today,v_due-case when v_i%6=0 then -3 else 3 end));
    if v_payment>0 then
      insert into supplier_payments(id,receipt_id,amount,paid_on,reference,source,created_by)
        values(md5('sample-payment:'||r.id)::uuid,v_receipt,v_payment,v_paid,'Generated historical payment','historical_import',v_actor);
    end if;
  end loop;
  insert into supplier_history_imports(id,linked_movements) values('007_supplier_history',v_i);
end $$;
commit;
