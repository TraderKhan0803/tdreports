-- New-customer status, part 1: the definition only.
-- Creates two functions and two read-only views. Writes no data, changes
-- no existing table, adds no triggers. Safe to run more than once.
--
-- Rule (agreed 2026-10-19):
--   * A customer is identified by their customer_links primary name if
--     their order name is an alias (exact match, as the dashboard does
--     today), lowercased.
--   * Their "New Customer" order is their earliest dated order with status
--     delivered / collected / assigned. Same-day ties go to the lowest
--     order_id. Every other order is "Recurring Customer".
--   * Undated orders and orders with an empty customer name are never
--     "New Customer".
--
-- Part 2 (not in this file) adds the refresh function, the triggers that
-- keep orders.is_first_order in sync, and the one-time full refresh.

-- 1. Display name after customer_links, mirroring applyCustomerLinks() in
-- index.html: groups are checked in primary_name order; the first group
-- that has this name as an alias returns its primary, a group whose
-- primary IS this name returns the name unchanged.
create or replace function public.td_customer_name(p_name text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (select case when l.alias = p_name then l.primary_name else p_name end
       from public.customer_links l
      where l.alias = p_name or l.primary_name = p_name
      order by l.primary_name, (l.alias = p_name) desc
      limit 1),
    coalesce(p_name, ''));
$$;

-- 2. Order date, mirroring parseOrder() in index.html: order_date_iso
-- (Y-M-D) if valid, else "7 Sep 2023"-style text in order_date_str; only
-- years 2020-2030 count.
create or replace function public.td_order_date(p_iso text, p_str text)
returns date
language plpgsql
immutable
set search_path = pg_catalog, pg_temp
as $$
declare
  months constant text[] := array['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  m text[];
  mi int;
  d date;
begin
  if p_iso is not null and p_iso not in ('', 'null') then
    m := regexp_match(p_iso, '^(\d{1,4})-(\d{1,2})-(\d{1,2})$');
    if m is not null then
      begin
        d := make_date(m[1]::int, m[2]::int, m[3]::int);
      exception when others then
        d := null;
      end;
      if d is not null and extract(year from d) between 2020 and 2030 then
        return d;
      end if;
    end if;
  end if;
  if p_str is not null and p_str <> '—' then
    m := regexp_match(p_str, '(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})');
    if m is not null then
      mi := array_position(months, m[2]);
      if mi is not null then
        begin
          d := make_date(m[3]::int, mi, m[1]::int);
        exception when others then
          d := null;
        end;
        if d is not null and extract(year from d) between 2020 and 2030 then
          return d;
        end if;
      end if;
    end if;
  end if;
  return null;
end;
$$;

-- 3. One row per customer: their first delivered/collected/assigned order.
-- Monthly Updates will read this server-side.
create or replace view public.customer_first_orders
with (security_invoker = true)
as
with qualifying as (
  select o.order_id,
         public.td_customer_name(o.customer) as customer_name,
         public.td_order_date(o.order_date_iso::text, o.order_date_str::text) as order_date
  from public.orders o
  where lower(coalesce(o.status, '')) in ('delivered', 'collected', 'assigned')
),
ranked as (
  select q.*,
         lower(q.customer_name) as customer_key,
         row_number() over (partition by lower(q.customer_name) order by q.order_date, q.order_id) as rn
  from qualifying q
  where q.order_date is not null
    and q.customer_name <> ''
)
select customer_key,
       customer_name,
       order_id as first_order_id,
       order_date as first_order_date
from ranked
where rn = 1;

-- 4. The flag every order SHOULD have under the rule above, next to the
-- flag it has now. Part 2's refresh writes proposed_flag into
-- orders.is_first_order; the dry run reads it.
create or replace view public.order_new_customer_status
with (security_invoker = true)
as
select o.order_id,
       o.is_first_order as current_flag,
       case when f.first_order_id is not null then 'New Customer' else 'Recurring Customer' end as proposed_flag
from public.orders o
left join public.customer_first_orders f on f.first_order_id = o.order_id;

-- Supabase grants new objects to anon/authenticated by default. These
-- must only be reachable through db-gateway (service_role), like
-- everything else — otherwise the public anon key could read customer
-- names straight from the views.
revoke all on public.customer_first_orders from public, anon, authenticated;
revoke all on public.order_new_customer_status from public, anon, authenticated;
revoke all on function public.td_customer_name(text) from public, anon, authenticated;
revoke all on function public.td_order_date(text, text) from public, anon, authenticated;
grant select on public.customer_first_orders, public.order_new_customer_status to service_role;
grant execute on function public.td_customer_name(text), public.td_order_date(text, text) to service_role;

notify pgrst, 'reload schema';
