-- New-customer status, part 2: keep orders.is_first_order correct
-- automatically. Needs part 1 (20261019_new_customers_part1.sql).
--
--   * td_first_orders(keys) holds the rule; the part 1 views now read it.
--   * refresh_new_customer_flags(keys) writes the flag defined by the
--     order_new_customer_status view (first delivered/collected/assigned
--     order per linked customer = 'New Customer', every other order =
--     'Recurring Customer') for the given customer keys, or everyone.
--   * Triggers on orders refresh just the customers a statement touched:
--     inserts (uploads), deletes (batch / test-order deletes), and updates
--     that change customer, status, a date column, or the flag itself (so a
--     stale page PATCHing the flag gets corrected straight away).
--   * Triggers on customer_links refresh the customers whose links changed
--     (everyone on a truncate).
--   * Ends with a one-time full refresh and a check.
--
-- Safe to run more than once. All in one transaction: if anything fails,
-- nothing changes.

begin;

-- 1. The rule, once, as a function that can be limited to some customers.
-- customer_first_orders (part 1) is redefined on top of it below, so the
-- view, the dry run and the refresh can never disagree.
--
-- Index for the limited case: every order whose customer key is K has
-- lower(customer) = K, or is an exact alias of a group whose primary
-- lowercases to K. So the candidates can be found by index instead of
-- scanning all orders.
create index if not exists idx_orders_lower_customer on public.orders (lower(customer));

create or replace function public.td_first_orders(p_keys text[] default null)
returns table (customer_key text, customer_name text, first_order_id text, first_order_date date)
language plpgsql
stable
set search_path = public, pg_temp
as $$
declare
  names text[];
begin
  if p_keys is null then
    return query
      select distinct on (lower(c.customer_name))
             lower(c.customer_name), c.customer_name, c.order_id::text, c.order_date
      from (
        select o.order_id, public.td_customer_name(o.customer) as customer_name,
               public.td_order_date(o.order_date_iso::text, o.order_date_str::text) as order_date
        from public.orders o
        where lower(coalesce(o.status, '')) in ('delivered', 'collected', 'assigned')
      ) c
      where c.order_date is not null and c.customer_name <> ''
      order by lower(c.customer_name), c.order_date, c.order_id;
    return;
  end if;

  names := p_keys || array(select lower(l.alias) from public.customer_links l where lower(l.primary_name) = any(p_keys));
  return query
    select distinct on (lower(c.customer_name))
           lower(c.customer_name), c.customer_name, c.order_id::text, c.order_date
    from (
      select o.order_id, public.td_customer_name(o.customer) as customer_name,
             public.td_order_date(o.order_date_iso::text, o.order_date_str::text) as order_date
      from public.orders o
      where lower(o.customer) = any(names)
        and lower(coalesce(o.status, '')) in ('delivered', 'collected', 'assigned')
    ) c
    where c.order_date is not null and c.customer_name <> ''
      and lower(c.customer_name) = any(p_keys)
    order by lower(c.customer_name), c.order_date, c.order_id;
end;
$$;

create or replace view public.customer_first_orders
with (security_invoker = true)
as
select customer_key, customer_name, first_order_id, first_order_date
from public.td_first_orders(null);

-- 2. The refresh. Returns how many orders changed.
create or replace function public.refresh_new_customer_flags(p_keys text[] default null)
returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n integer;
  names text[];
begin
  if p_keys is not null and cardinality(p_keys) = 0 then
    return 0;
  end if;
  -- Tell the orders UPDATE trigger this write is ours, so it doesn't
  -- refresh the same customers a second time.
  perform set_config('td.refreshing_new_customers', 'on', true);

  if p_keys is null then
    with target as (
      select o.id,
             case when f.first_order_id is null then 'Recurring Customer' else 'New Customer' end as flag
      from public.orders o
      left join public.td_first_orders(null) f on f.first_order_id = o.order_id::text
    )
    update public.orders o
       set is_first_order = t.flag
      from target t
     where o.id = t.id
       and o.is_first_order is distinct from t.flag;
  else
    names := p_keys || array(select lower(l.alias) from public.customer_links l where lower(l.primary_name) = any(p_keys));
    with target as (
      select o.id,
             case when f.first_order_id is null then 'Recurring Customer' else 'New Customer' end as flag
      from public.orders o
      left join public.td_first_orders(p_keys) f on f.first_order_id = o.order_id::text
      where lower(o.customer) = any(names)
        and lower(public.td_customer_name(o.customer)) = any(p_keys)
    )
    update public.orders o
       set is_first_order = t.flag
      from target t
     where o.id = t.id
       and o.is_first_order is distinct from t.flag;
  end if;
  get diagnostics n = row_count;

  perform set_config('td.refreshing_new_customers', 'off', true);
  return n;
end;
$$;

-- 3. Trigger functions (statement-level, using transition tables, so a
-- 100-row upload chunk costs one refresh, not 100).
create or replace function public.trg_orders_new_customers_ins()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_new_customer_flags(
    array(select distinct lower(public.td_customer_name(customer)) from new_rows));
  return null;
end;
$$;

create or replace function public.trg_orders_new_customers_del()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_new_customer_flags(
    array(select distinct lower(public.td_customer_name(customer)) from old_rows));
  return null;
end;
$$;

create or replace function public.trg_orders_new_customers_upd()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if current_setting('td.refreshing_new_customers', true) = 'on' then
    return null; -- the refresh's own write
  end if;
  -- Customers whose orders changed in a way that matters. Edits like
  -- city or B2B/B2C don't match, so they cost one join and nothing more.
  -- Both the old and new name, so renaming an order fixes both customers.
  perform public.refresh_new_customer_flags(array(
    select distinct lower(public.td_customer_name(c.customer))
    from (
      select o.customer as old_customer, n.customer as new_customer
      from old_rows o
      join new_rows n on n.id = o.id
      where (o.customer, o.status, o.order_date_iso, o.order_date_str, o.is_first_order)
            is distinct from
            (n.customer, n.status, n.order_date_iso, n.order_date_str, n.is_first_order)
    ) changed
    cross join lateral (values (changed.old_customer), (changed.new_customer)) as c(customer)
  ));
  return null;
end;
$$;

-- Links: only orders named exactly like a changed row's alias can change
-- customer, moving between that alias's own key and its primary's key.
-- So the affected keys are lower(alias) and lower(primary_name) of every
-- changed row, old and new.
create or replace function public.trg_customer_links_new_customers_ins()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_new_customer_flags(array(
    select distinct k from new_rows r cross join lateral (values (lower(r.alias)), (lower(r.primary_name))) v(k)));
  return null;
end;
$$;

create or replace function public.trg_customer_links_new_customers_del()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_new_customer_flags(array(
    select distinct k from old_rows r cross join lateral (values (lower(r.alias)), (lower(r.primary_name))) v(k)));
  return null;
end;
$$;

create or replace function public.trg_customer_links_new_customers_upd()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_new_customer_flags(array(
    select distinct k from (select alias, primary_name from old_rows union all select alias, primary_name from new_rows) r
    cross join lateral (values (lower(r.alias)), (lower(r.primary_name))) v(k)));
  return null;
end;
$$;

create or replace function public.trg_customer_links_new_customers_all()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  perform public.refresh_new_customer_flags();
  return null;
end;
$$;

-- Earlier draft name; remove if present.
drop trigger if exists trg_customer_links_new_customers on public.customer_links;
drop function if exists public.trg_customer_links_new_customers();

-- 4. Triggers
drop trigger if exists trg_orders_new_customers_ins on public.orders;
create trigger trg_orders_new_customers_ins
  after insert on public.orders
  referencing new table as new_rows
  for each statement execute function public.trg_orders_new_customers_ins();

drop trigger if exists trg_orders_new_customers_del on public.orders;
create trigger trg_orders_new_customers_del
  after delete on public.orders
  referencing old table as old_rows
  for each statement execute function public.trg_orders_new_customers_del();

drop trigger if exists trg_orders_new_customers_upd on public.orders;
create trigger trg_orders_new_customers_upd
  after update on public.orders
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.trg_orders_new_customers_upd();

drop trigger if exists trg_customer_links_new_customers_ins on public.customer_links;
create trigger trg_customer_links_new_customers_ins
  after insert on public.customer_links
  referencing new table as new_rows
  for each statement execute function public.trg_customer_links_new_customers_ins();

drop trigger if exists trg_customer_links_new_customers_del on public.customer_links;
create trigger trg_customer_links_new_customers_del
  after delete on public.customer_links
  referencing old table as old_rows
  for each statement execute function public.trg_customer_links_new_customers_del();

drop trigger if exists trg_customer_links_new_customers_upd on public.customer_links;
create trigger trg_customer_links_new_customers_upd
  after update on public.customer_links
  referencing old table as old_rows new table as new_rows
  for each statement execute function public.trg_customer_links_new_customers_upd();

drop trigger if exists trg_customer_links_new_customers_all on public.customer_links;
create trigger trg_customer_links_new_customers_all
  after truncate on public.customer_links
  for each statement execute function public.trg_customer_links_new_customers_all();

-- 5. Only db-gateway (service_role) may call the refresh — via its
-- admin/recalc-new-customers route. Trigger functions are never called
-- directly.
revoke all on public.customer_first_orders from public, anon, authenticated;
revoke all on function public.td_first_orders(text[]) from public, anon, authenticated;
revoke all on function public.refresh_new_customer_flags(text[]) from public, anon, authenticated;
revoke all on function public.trg_orders_new_customers_ins() from public, anon, authenticated;
revoke all on function public.trg_orders_new_customers_del() from public, anon, authenticated;
revoke all on function public.trg_orders_new_customers_upd() from public, anon, authenticated;
revoke all on function public.trg_customer_links_new_customers_ins() from public, anon, authenticated;
revoke all on function public.trg_customer_links_new_customers_del() from public, anon, authenticated;
revoke all on function public.trg_customer_links_new_customers_upd() from public, anon, authenticated;
revoke all on function public.trg_customer_links_new_customers_all() from public, anon, authenticated;
grant select on public.customer_first_orders to service_role;
grant execute on function public.td_first_orders(text[]), public.refresh_new_customer_flags(text[]) to service_role;

-- 6. One-time full refresh (the dry run predicted 184 orders: 131 New →
-- Recurring, 53 Recurring → New).
select public.refresh_new_customer_flags() as orders_changed;

commit;

notify pgrst, 'reload schema';

-- 7. Check (the result the SQL Editor shows). Expected from the dry run:
-- new_orders = 1629, still_wrong = 0, triggers = 7.
select (select count(*) from public.orders where is_first_order = 'New Customer') as new_orders,
       (select count(*) from public.order_new_customer_status where current_flag is distinct from proposed_flag) as still_wrong,
       (select count(*) from pg_trigger
         where tgname in ('trg_orders_new_customers_ins', 'trg_orders_new_customers_del',
                          'trg_orders_new_customers_upd', 'trg_customer_links_new_customers_ins',
                          'trg_customer_links_new_customers_del', 'trg_customer_links_new_customers_upd',
                          'trg_customer_links_new_customers_all')) as triggers;
