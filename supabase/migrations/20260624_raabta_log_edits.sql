-- Raabta CRM Phase 2c: lets a logged interaction be "edited" without
-- mutating the original row. An edit is a normal raabta_log row with
-- is_edit = true and edited_from pointing at the id of the original
-- record being corrected. Both columns are nullable/additive.
alter table public.raabta_log add column if not exists edited_from text;
alter table public.raabta_log add column if not exists is_edit boolean default false;
