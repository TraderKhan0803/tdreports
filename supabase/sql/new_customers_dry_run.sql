-- Read-only dry run for the new-customer fix. Needs part 1
-- (20261019_new_customers_part1.sql). Changes nothing. One statement, one
-- result table (section / item / value), so the SQL Editor shows it all.
--
-- The monthly rows split the change into its two causes:
--   today      = orders flagged New today, any status (dashboard KPI and
--                monthly chart)
--   today_dlv  = of those, delivered/collected/assigned (welcome list,
--                cohorts, repeat rate)
--   bugfix     = today's rule (any status) recomputed on FULL history, i.e.
--                what the flags would be without the Recalc bug
--   proposed   = the agreed rule: first delivered/collected/assigned order
--   change     = proposed - today
with base as (
  select o.order_id, o.year, o.month, o.customer, o.is_first_order,
         lower(coalesce(o.status, '')) as status,
         lower(public.td_customer_name(o.customer)) as customer_key,
         public.td_order_date(o.order_date_iso::text, o.order_date_str::text) as order_date
  from public.orders o
),
any_status_first as (
  select order_id from (
    select order_id, row_number() over (partition by customer_key order by order_date, order_id) as rn
    from base
    where order_date is not null and customer_key <> ''
  ) r
  where rn = 1
),
proposed_first as (
  select first_order_id as order_id from public.customer_first_orders
),
flags as (
  select b.*,
         b.is_first_order = 'New Customer' as is_today,
         b.is_first_order = 'New Customer' and b.status in ('delivered', 'collected', 'assigned') as is_today_dlv,
         a.order_id is not null as is_bugfix,
         p.order_id is not null as is_proposed
  from base b
  left join any_status_first a on a.order_id = b.order_id
  left join proposed_first p on p.order_id = b.order_id
),
monthly as (
  select year, month,
         count(*) filter (where is_today) as today,
         count(*) filter (where is_today_dlv) as today_dlv,
         count(*) filter (where is_bugfix) as bugfix,
         count(*) filter (where is_proposed) as proposed
  from flags
  group by year, month
),
firsts as (
  select customer_key,
         min(order_date) as first_any,
         min(order_date) filter (where status in ('delivered', 'collected', 'assigned')) as first_dlv
  from base
  where order_date is not null and customer_key <> ''
  group by customer_key
)
select section, item, value
from (
  -- 1. Sanity
  select 1 as s, 1 as n, 'sanity' as section, 'orders / distinct order_id' as item,
         count(*) || ' / ' || count(distinct order_id) as value
  from base
  union all
  select 1, 2, 'sanity', 'undated orders (never New)', count(*)::text from base where order_date is null
  union all
  select 1, 3, 'sanity', 'orders with no customer name (never New)', count(*)::text from base where customer_key = ''
  union all
  select 1, 4, 'sanity', 'customers total / with a New order under proposed rule',
         (select count(distinct customer_key) from base where customer_key <> '') || ' / ' ||
         (select count(*) from public.customer_first_orders)

  -- 2. Totals across all months
  union all
  select 2, 1, 'totals', 'all months',
         'today ' || sum(today) || ' · today_dlv ' || sum(today_dlv) || ' · bugfix ' || sum(bugfix) ||
         ' · proposed ' || sum(proposed) || ' · change ' || (sum(proposed) - sum(today))
  from monthly

  -- 3. How many orders the refresh would change, by direction
  union all
  select 3, 1, 'flips', 'New → Recurring', count(*)::text from flags where is_today and not is_proposed
  union all
  select 3, 2, 'flips', 'Recurring → New', count(*)::text from flags where not is_today and is_proposed

  -- 4. Customers the new rule dates differently from today's rule
  union all
  select 4, 1, 'rule effect', 'customers never delivered (never New)',
         count(*) filter (where first_dlv is null)::text from firsts
  union all
  select 4, 2, 'rule effect', 'first order not delivered → counted in a later month',
         count(*) filter (where first_dlv > first_any
                            and date_trunc('month', first_dlv) <> date_trunc('month', first_any))::text from firsts
  union all
  select 4, 3, 'rule effect', 'first order not delivered → later day, same month',
         count(*) filter (where first_dlv > first_any
                            and date_trunc('month', first_dlv) = date_trunc('month', first_any))::text from firsts

  -- 5. Month by month
  union all
  select 5, coalesce(year * 100 + month, 999999), 'month',
         coalesce(year || '-' || lpad(month::text, 2, '0'), '(no year/month)'),
         'today ' || today || ' · today_dlv ' || today_dlv || ' · bugfix ' || bugfix ||
         ' · proposed ' || proposed || ' · change ' || (proposed - today)
  from monthly
) r
order by s, n;

-- Optional, separate (contains customer names — keep private): a sample of
-- orders whose flag would change.
--
-- select o.order_id, o.customer, s.current_flag, s.proposed_flag, o.status,
--        public.td_order_date(o.order_date_iso::text, o.order_date_str::text) as order_date
-- from public.order_new_customer_status s
-- join public.orders o on o.order_id = s.order_id
-- where s.current_flag is distinct from s.proposed_flag
-- order by order_date desc nulls last
-- limit 40;
