-- Raabta CRM Phase 1: adds the two new columns rbLogA() will start writing.
-- Both nullable and additive — existing rows are unaffected. Safe to run
-- more than once (IF NOT EXISTS).
alter table public.raabta_log add column if not exists interaction_type text;
alter table public.raabta_log add column if not exists category text;
