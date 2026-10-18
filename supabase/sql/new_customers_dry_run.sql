-- Read-only dry run for the new-customer fix. Needs part 1
-- (20261019_new_customers_part1.sql). Changes nothing.
--
-- Today's flags are a mix of two problems, so the monthly table splits the
-- change into its two causes:
--   bugfix_any_status  = today's rule (any status counts) recomputed on the
--                        FULL order history — what the flags would be if the
--                        Recalc bug had never happened
--   proposed           = the agreed rule (first delivered/collected/assigned
--                        order)
-- "today_all" is what the dashboard KPI / monthly chart count today;
-- "today_delivered" is what the welcome list, cohorts and repeat rate count.

-- 1. Sanity: duplicates and dates the rule can't use
select count(*) as orders,
       count(distinct order_id) as distinct_order_ids,
       count(*) filter (where public.td_order_date(order_date_iso::text, order_date_str::text) is null) as undated_orders,
       count(*) filter (where coalesce(customer, '') = '') as no_customer_name,
       (select count(*) from public.customer_first_orders) as customers_with_a_new_order,
       (select count(distinct lower(public.td_customer_name(customer))) from public.orders where coalesce(customer, '') <> '') as customers_total
from public.orders;

-- 2. Monthly new-customer numbers: today vs bug fix only vs proposed
with base as (
  select o.order_id, o.year, o.month, lower(coalesce(o.status, '')) as status, o.is_first_order,
         lower(public.td_customer_name(o.customer)) as customer_key,
         public.td_order_date(o.order_date_iso::text, o.order_date_str::text) as order_date
  from public.orders o
),
any_status_first as (
  select distinct order_id from (
    select order_id,
           row_number() over (partition by customer_key order by order_date, order_id) as rn
    from base
    where order_date is not null and customer_key <> ''
  ) r
  where rn = 1
),
proposed_first as (
  select distinct first_order_id as order_id from public.customer_first_orders
)
select b.year, b.month,
       count(*) filter (where b.is_first_order = 'New Customer') as today_all,
       count(*) filter (where b.is_first_order = 'New Customer' and b.status in ('delivered', 'collected', 'assigned')) as today_delivered,
       count(a.order_id) as bugfix_any_status,
       count(p.order_id) as proposed,
       count(p.order_id) - count(*) filter (where b.is_first_order = 'New Customer') as change_vs_today_all
from base b
left join any_status_first a on a.order_id = b.order_id
left join proposed_first p on p.order_id = b.order_id
group by b.year, b.month
order by b.year, b.month;

-- 3. How many orders the refresh would change, by direction
select coalesce(current_flag, '(empty)') as current_flag, proposed_flag, count(*) as orders
from public.order_new_customer_status
where current_flag is distinct from proposed_flag
group by 1, 2
order by 3 desc;

-- 4. Customers the new rule counts in a different month than today's
-- rule would (first order wasn't delivered; a later one was)
with base as (
  select lower(public.td_customer_name(customer)) as customer_key,
         lower(coalesce(status, '')) as status,
         public.td_order_date(order_date_iso::text, order_date_str::text) as order_date
  from public.orders
  where coalesce(customer, '') <> ''
),
firsts as (
  select customer_key,
         min(order_date) as first_any,
         min(order_date) filter (where status in ('delivered', 'collected', 'assigned')) as first_delivered
  from base
  where order_date is not null
  group by customer_key
)
select count(*) filter (where first_delivered is null) as never_delivered_never_new,
       count(*) filter (where first_delivered > first_any
                          and date_trunc('month', first_delivered) <> date_trunc('month', first_any)) as moved_to_a_later_month,
       count(*) filter (where first_delivered > first_any
                          and date_trunc('month', first_delivered) = date_trunc('month', first_any)) as same_month_later_day
from firsts;

-- 5. Sample of orders that would change (customer names included — don't
-- paste this one anywhere public)
select o.order_id, o.customer, s.current_flag, s.proposed_flag, lower(coalesce(o.status, '')) as status,
       public.td_order_date(o.order_date_iso::text, o.order_date_str::text) as order_date, o.year, o.month
from public.order_new_customer_status s
join public.orders o on o.order_id = s.order_id
where s.current_flag is distinct from s.proposed_flag
order by order_date desc nulls last
limit 40;
