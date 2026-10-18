-- Read-only. Run in the Supabase SQL Editor and send the results back
-- before part 1, so the new-customer SQL matches the real column types.

-- 1. Columns the new-customer logic reads
select table_name, column_name, data_type, is_nullable
from information_schema.columns
where table_schema = 'public'
  and table_name in ('orders', 'customer_links')
order by table_name, ordinal_position;

-- 2. Indexes / unique constraints (is order_id unique? is alias indexed?)
select tablename, indexname, indexdef
from pg_indexes
where schemaname = 'public'
  and tablename in ('orders', 'customer_links')
order by tablename, indexname;

-- 3. Existing triggers on these tables
select c.relname as table_name, t.tgname as trigger_name, pg_get_triggerdef(t.oid) as definition
from pg_trigger t
join pg_class c on c.oid = t.tgrelid
where c.relnamespace = 'public'::regnamespace
  and c.relname in ('orders', 'customer_links')
  and not t.tgisinternal;

-- 4. Size and current flag values
select count(*) as orders,
       count(distinct order_id) as distinct_order_ids,
       count(*) filter (where is_first_order = 'New Customer') as flagged_new,
       count(*) filter (where is_first_order = 'Recurring Customer') as flagged_recurring,
       count(*) filter (where is_first_order is null or is_first_order not in ('New Customer', 'Recurring Customer')) as flagged_other
from public.orders;

-- 5. Status spellings (the new rule counts delivered / collected / assigned)
select lower(coalesce(status, '')) as status, count(*)
from public.orders
group by 1
order by 2 desc;

-- 6. customer_links size
select count(*) as links, count(distinct alias) as distinct_aliases, count(distinct primary_name) as groups
from public.customer_links;
