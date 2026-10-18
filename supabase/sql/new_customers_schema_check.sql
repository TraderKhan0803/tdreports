-- Read-only. One statement, one result table (section / item / value), so
-- the Supabase SQL Editor shows every check at once. Run it and send the
-- result back before part 1.
select section, item, value
from (
  -- 1. Columns the new-customer logic reads
  select 1 as s, 0 as n, 'column'::text as section,
         (table_name || '.' || column_name)::text as item,
         (data_type || case when is_nullable = 'NO' then ' not null' else '' end)::text as value
  from information_schema.columns
  where table_schema = 'public'
    and (table_name = 'customer_links'
         or (table_name = 'orders' and column_name in
             ('id', 'order_id', 'customer', 'status', 'order_date_iso', 'order_date_str', 'year', 'month', 'is_first_order')))

  -- 2. Indexes / unique constraints
  union all
  select 2, 0, 'index', (tablename || '.' || indexname)::text, indexdef::text
  from pg_indexes
  where schemaname = 'public' and tablename in ('orders', 'customer_links')

  -- 3. Existing triggers
  union all
  select 3, 0, 'trigger', (c.relname || '.' || t.tgname)::text, pg_get_triggerdef(t.oid)::text
  from pg_trigger t
  join pg_class c on c.oid = t.tgrelid
  where c.relnamespace = 'public'::regnamespace
    and c.relname in ('orders', 'customer_links')
    and not t.tgisinternal

  -- 4. Size and current flag values
  union all
  select 4, x.n, 'orders', x.item, x.value
  from (
    select count(*)::text as total,
           count(distinct order_id)::text as distinct_ids,
           count(*) filter (where is_first_order = 'New Customer')::text as new_,
           count(*) filter (where is_first_order = 'Recurring Customer')::text as recurring,
           count(*) filter (where is_first_order is null
                              or is_first_order not in ('New Customer', 'Recurring Customer'))::text as other
    from public.orders
  ) o
  cross join lateral (values
    (1, 'rows', o.total),
    (2, 'distinct order_id', o.distinct_ids),
    (3, 'flag = New Customer', o.new_),
    (4, 'flag = Recurring Customer', o.recurring),
    (5, 'flag = other/empty', o.other)
  ) as x(n, item, value)

  -- 5. Status spellings
  union all
  select 5, 0, 'status', coalesce(nullif(lower(status), ''), '(empty)'), count(*)::text
  from public.orders
  group by lower(status)

  -- 6. customer_links contents
  union all
  select 6, 1, 'customer_links', 'rows / distinct aliases / groups',
         count(*)::text || ' / ' || count(distinct alias)::text || ' / ' || count(distinct primary_name)::text
  from public.customer_links

  -- 7. Were links ever saved? saveLinkGroup / deleteLink log these only
  -- after the database call succeeds.
  union all
  select 7, 1, 'link history', 'activity_log "Created customer link"',
         count(*)::text || coalesce(' (first ' || min("timestamp")::text || ', last ' || max("timestamp")::text || ')', '')
  from public.activity_log
  where message like 'Created customer link%'
  union all
  select 7, 2, 'link history', 'activity_log "Removed customer link"',
         count(*)::text || coalesce(' (last ' || max("timestamp")::text || ')', '')
  from public.activity_log
  where message like 'Removed customer link%'

  -- 8. Anywhere else links could be: other tables or admin_config types
  union all
  select 8, 1, 'other link storage', 'tables named like %link% / %alias%',
         coalesce(string_agg(table_name::text, ', '), 'none')
  from information_schema.tables
  where table_schema = 'public'
    and (table_name ilike '%link%' or table_name ilike '%alias%')
    and table_name <> 'customer_links'
  union all
  select 8, 2, 'other link storage', 'admin_config types like %link% / %alias%',
         coalesce(string_agg(distinct type, ', '), 'none')
  from public.admin_config
  where type ilike '%link%' or type ilike '%alias%'
) checks
order by s, n, item;
