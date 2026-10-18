-- Read-only. One result table: every customer-link event in the activity
-- log, plus Postgres's own insert/delete counters for customer_links, to
-- see whether anything removed links besides the logged "Removed" actions.
-- Contains customer names — keep the output private.
select kind, at, who, detail
from (
  select 1 as s,
         case when message like 'Created%' then 'created' else 'removed' end as kind,
         "timestamp"::text as at,
         username as who,
         message as detail
  from public.activity_log
  where message like 'Created customer link%' or message like 'Removed customer link%'

  union all
  select 2, 'table counters', null, null,
         'inserted ' || n_tup_ins || ', updated ' || n_tup_upd || ', deleted ' || n_tup_del ||
         ', live rows ' || n_live_tup ||
         coalesce(', last vacuum ' || greatest(last_vacuum, last_autovacuum)::text, '')
  from pg_stat_user_tables
  where schemaname = 'public' and relname = 'customer_links'

  union all
  select 3, 'counters since', null, null, coalesce(stats_reset::text, 'database creation')
  from pg_stat_database
  where datname = current_database()

  -- Anything else that mentions links or deletes in bulk around that time
  union all
  select 4, 'other admin action', "timestamp"::text, username, message
  from public.activity_log
  where "timestamp"::timestamptz between '2026-04-01' and '2026-06-30'
    and (message ilike '%link%' or message ilike '%remove all%' or message ilike '%cleared%' or message ilike '%deleted all%')
    and message not like 'Created customer link%'
    and message not like 'Removed customer link%'
) h
order by s, at;
