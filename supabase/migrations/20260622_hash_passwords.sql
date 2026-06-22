-- Switches users.password from plaintext to pgcrypto bcrypt hashes.
-- Safe to run more than once: the trigger and the one-time UPDATE both
-- skip values that already look like a bcrypt hash ($2a$/$2b$/$2y$...).

-- 0. Remove any length limit on the column up front, so the 60-char
-- bcrypt hash can never fail to write regardless of the current type.
-- A no-op if it's already text.
alter table public.users alter column password type text;

-- 1. Enable pgcrypto (no-op if it's already enabled, in any schema)
create extension if not exists pgcrypto;

-- 2. Trigger: hash users.password on insert/update, unless it already
-- looks hashed. This means addUser / doChangePassword / doResetPassword
-- need no code changes — Postgres hashes whatever gets written, no
-- matter which part of the app wrote it.
create or replace function hash_password_trigger()
returns trigger
language plpgsql
set search_path = public, extensions, pg_temp
as $$
begin
  if new.password is not null and new.password !~ '^\$2[aby]\$\d{2}\$' then
    new.password := crypt(new.password, gen_salt('bf', 8));
  end if;
  return new;
end;
$$;

drop trigger if exists trg_hash_password on public.users;
create trigger trg_hash_password
before insert or update of password on public.users
for each row
execute function hash_password_trigger();

-- 3. verify_password(username, password): returns the matching row's
-- role/email/must_change_password if the password is correct, zero rows
-- otherwise. The hash itself never leaves Postgres.
create or replace function verify_password(p_username text, p_password text)
returns table(role text, email text, must_change_password boolean)
language plpgsql
security definer
set search_path = public, extensions, pg_temp
as $$
begin
  return query
  select u.role, u.email, u.must_change_password
  from public.users u
  where u.username = p_username
    and u.password = crypt(p_password, u.password);
end;
$$;

-- Lock down who can call it. Postgres grants EXECUTE on new functions to
-- PUBLIC by default — without this revoke, anyone could call this RPC
-- directly over PostgREST (bypassing db-gateway entirely, rate-limiting
-- included) and brute-force it freely. Only the gateway's service_role
-- key should ever be able to run this.
revoke all on function verify_password(text, text) from public;
grant execute on function verify_password(text, text) to service_role;

-- 4. One-time migration: hash every existing plaintext password. Safe to
-- run twice — rows that already look hashed are excluded by the WHERE.
update public.users
set password = crypt(password, gen_salt('bf', 8))
where password is not null
  and password !~ '^\$2[aby]\$\d{2}\$';

-- Make sure PostgREST picks up the new RPC function immediately, rather
-- than waiting for its normal schema-cache refresh.
notify pgrst, 'reload schema';
