-- Final lockdown step: remove every permissive policy on the 11 tables
-- the app uses, then enable RLS with nothing re-added. The db-gateway
-- Edge Function keeps working regardless, since it always uses the
-- service_role key, which bypasses RLS by design. Anything still using
-- the old exposed anon key directly gets zero rows / zero access.

-- 1. Drop the specific permissive policies identified in the original audit
drop policy if exists allow_all on public.activity_log;
drop policy if exists allow_all on public.admin_config;
drop policy if exists allow_all on public.ai_conversations;
drop policy if exists allow_all on public.ai_usage;
drop policy if exists allow_all on public.ai_user_limits;
drop policy if exists allow_all on public.alerts;
drop policy if exists allow_all on public.orders;
drop policy if exists allow_all on public.products;
drop policy if exists allow_all on public.raabta_log;
drop policy if exists allow_all on public.sessions;
drop policy if exists allow_all on public.users;
drop policy if exists allow_anon_read_orders on public.orders;

-- 2. Safety net: drop any other policy left on these tables, whatever
-- it happens to be named, in case something wasn't caught above.
do $$
declare
  pol record;
begin
  for pol in
    select schemaname, tablename, policyname
    from pg_policies
    where schemaname = 'public'
      and tablename in (
        'activity_log','admin_config','ai_conversations','ai_usage',
        'ai_user_limits','alerts','orders','products','raabta_log',
        'sessions','users'
      )
  loop
    execute format('drop policy if exists %I on %I.%I', pol.policyname, pol.schemaname, pol.tablename);
  end loop;
end $$;

-- 3. Enable RLS on all 11 tables. Zero policies remain, so this is
-- default-deny for the anon and authenticated roles.
alter table public.activity_log enable row level security;
alter table public.admin_config enable row level security;
alter table public.ai_conversations enable row level security;
alter table public.ai_usage enable row level security;
alter table public.ai_user_limits enable row level security;
alter table public.alerts enable row level security;
alter table public.orders enable row level security;
alter table public.products enable row level security;
alter table public.raabta_log enable row level security;
alter table public.sessions enable row level security;
alter table public.users enable row level security;
