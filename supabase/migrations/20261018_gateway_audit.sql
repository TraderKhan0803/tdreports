-- Records what db-gateway refused, or (in log-only mode) would have
-- refused, narrowed or filtered. Plain allowed requests are not logged.
-- Only the gateway writes here (service_role key), so RLS stays
-- default-deny and the gateway hard-blocks the table from the browser.
create table if not exists public.gateway_audit (
  id bigint generated always as identity primary key,
  at timestamptz not null default now(),
  username text,
  role text,
  method text not null,
  path text not null,
  query text,
  decision text not null, -- block | would_block | would_narrow | would_filter
  reason text
);

create index if not exists gateway_audit_at_idx on public.gateway_audit (at desc);

alter table public.gateway_audit enable row level security;

-- Review during the log-only window:
--   select decision, role, method, path, reason, count(*), max(at)
--   from gateway_audit
--   where decision <> 'block' or at > now() - interval '1 day'
--   group by 1,2,3,4,5 order by count(*) desc;
--
-- Clean-up (run occasionally): delete from gateway_audit where at < now() - interval '30 days';
