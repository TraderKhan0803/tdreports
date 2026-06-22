-- Tracks failed login attempts per username so db-gateway's /auth/login
-- route can lock out further tries for a short cooldown. Only ever
-- touched by the gateway (service_role key), so RLS stays default-deny.
create table if not exists public.login_attempts (
  username text primary key,
  failed_count integer not null default 0,
  locked_until timestamptz
);

alter table public.login_attempts enable row level security;
