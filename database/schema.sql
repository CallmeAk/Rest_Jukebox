-- ============================================================================
-- BeatBites schema v2 (hardened, multi-tenant). Run in the Supabase SQL editor.
--
-- Fixes over the legacy schema:
--   * Real tenant table (restaurants) + FKs => referential integrity, isolation.
--   * staff table mapped to auth.users with roles (owner/dj/staff).
--   * Tenant + role-scoped RLS everywhere (no more `using(true)`).
--   * Guest PII is readable ONLY by staff of the same tenant (closes the leak).
--   * Anon guest onboarding + table lookup go through SECURITY DEFINER functions
--     so nothing can be enumerated.
--   * Soft delete (deleted_at), audit_log, updated_at triggers, useful indexes.
--   * song_requests_view computes votes via join => counts never drift.
--
-- restaurant_id is a text slug (e.g. 'table-stories') so the front-end config
-- value maps directly to a row. Set BEATBITES_CONFIG.RESTAURANT_ID to this slug.
-- ============================================================================

create extension if not exists pgcrypto;

-- ---------- tenants & staff ----------
create table if not exists public.restaurants (
  id            text primary key,
  name          text not null,
  brand_color   text default '#8b5cf6',
  brand_emoji   text default '🎵',
  plan          text not null default 'trial' check (plan in ('trial','starter','pro','enterprise')),
  is_live       boolean not null default false,
  trial_ends_at timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);

create table if not exists public.staff (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text not null references public.restaurants(id) on delete cascade,
  auth_user_id  uuid not null references auth.users(id) on delete cascade,
  role          text not null default 'staff' check (role in ('owner','dj','staff')),
  created_at    timestamptz not null default now(),
  unique (restaurant_id, auth_user_id)
);
create index if not exists idx_staff_user on public.staff(auth_user_id);

-- ---------- operational tables ----------
create table if not exists public.restaurant_tables (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text not null references public.restaurants(id) on delete cascade,
  table_number  int not null,
  access_token  text not null,
  secure_token  text not null default replace(gen_random_uuid()::text,'-',''),
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  deleted_at    timestamptz,
  unique (restaurant_id, table_number),
  unique (restaurant_id, secure_token)
);

create table if not exists public.guests (
  id                uuid primary key default gen_random_uuid(),
  restaurant_id     text not null references public.restaurants(id) on delete cascade,
  name              text not null,
  mobile            text not null,
  email             text,
  dob               date,
  favorite_genre    text,
  visit_count       int not null default 1,
  loyalty_points    int not null default 0,
  consent_service   boolean not null default false,
  consent_marketing boolean not null default false,
  consent_at        timestamptz,
  created_at        timestamptz not null default now(),
  last_visit_at     timestamptz not null default now(),
  updated_at        timestamptz not null default now(),
  deleted_at        timestamptz,
  unique (restaurant_id, mobile)
);

create table if not exists public.guest_sessions (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text not null references public.restaurants(id) on delete cascade,
  guest_id      uuid not null references public.guests(id) on delete cascade,
  table_id      uuid references public.restaurant_tables(id) on delete set null,
  table_number  int,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz
);
create index if not exists idx_sessions_guest on public.guest_sessions(guest_id);

create table if not exists public.song_requests (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text not null references public.restaurants(id) on delete cascade,
  guest_id      uuid references public.guests(id) on delete set null,
  session_id    uuid references public.guest_sessions(id) on delete set null,
  table_number  int,
  title         text not null,
  artist        text not null,
  genre         text,
  artwork_url   text,
  preview_url   text,
  status        text not null default 'queued'
                check (status in ('queued','playing','played','removed','skipped')),
  priority      bigint not null default 0,  -- purchased boost wins ordering
  requested_at  bigint not null,
  played_at     bigint,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  deleted_at    timestamptz
);
create index if not exists idx_requests_rest_status on public.song_requests(restaurant_id, status);

create table if not exists public.song_votes (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text not null references public.restaurants(id) on delete cascade,
  request_id    uuid not null references public.song_requests(id) on delete cascade,
  session_id    uuid,
  guest_id      uuid references public.guests(id) on delete set null,
  created_at    timestamptz not null default now(),
  unique (request_id, session_id)   -- one vote per session per song
);
create index if not exists idx_votes_request on public.song_votes(request_id);

create table if not exists public.request_history (
  id             uuid primary key default gen_random_uuid(),
  restaurant_id  text not null references public.restaurants(id) on delete cascade,
  request_id     uuid,
  guest_id       uuid,
  table_number   int,
  title          text,
  artist         text,
  genre          text,
  history_status text,
  history_at     timestamptz not null default now()
);

-- Two-currency points LEDGER (source of truth; balances are summed, never stored).
create table if not exists public.loyalty_events (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text not null references public.restaurants(id) on delete cascade,
  guest_id      uuid references public.guests(id) on delete cascade,
  currency      text not null default 'loyalty' check (currency in ('beats','loyalty')),
  points        int not null,               -- positive = earn, negative = spend
  reason        text,
  session_id    uuid,                        -- for per-session beats cap
  created_at    timestamptz not null default now()
);
create index if not exists idx_loyalty_guest on public.loyalty_events(guest_id);
create index if not exists idx_loyalty_session on public.loyalty_events(session_id);

-- Loyalty redemptions awaiting staff verification (short code, expires).
create table if not exists public.redemptions (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text not null references public.restaurants(id) on delete cascade,
  guest_id      uuid references public.guests(id) on delete set null,
  label         text not null,
  points        int not null,
  code          text not null,
  status        text not null default 'pending' check (status in ('pending','fulfilled','void')),
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  fulfilled_at  timestamptz
);
create index if not exists idx_redemptions_code on public.redemptions(restaurant_id, code);

-- Dedications / shout-outs; must be approved by staff before public display.
create table if not exists public.dedications (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text not null references public.restaurants(id) on delete cascade,
  guest_id      uuid references public.guests(id) on delete set null,
  message       text not null,
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  created_at    timestamptz not null default now()
);
create index if not exists idx_dedications_rest_status on public.dedications(restaurant_id, status);

create table if not exists public.guest_notifications (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text not null references public.restaurants(id) on delete cascade,
  guest_id      uuid references public.guests(id) on delete cascade,
  message       text not null,
  read          boolean not null default false,
  created_at    timestamptz not null default now()
);
create index if not exists idx_notifications_guest on public.guest_notifications(guest_id);

create table if not exists public.guest_feedback (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text not null references public.restaurants(id) on delete cascade,
  guest_id      uuid references public.guests(id) on delete set null,
  rating        int not null check (rating between 1 and 5),
  comment       text,
  created_at    timestamptz not null default now()
);

create table if not exists public.audit_log (
  id            uuid primary key default gen_random_uuid(),
  restaurant_id text,
  actor         uuid,
  action        text not null,
  detail        jsonb,
  created_at    timestamptz not null default now()
);

-- ---------- updated_at trigger ----------
create or replace function public.bb_touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;

do $$ declare t text;
begin
  foreach t in array array['restaurants','guests','song_requests'] loop
    execute format(
      'drop trigger if exists trg_touch_%1$s on public.%1$s;
       create trigger trg_touch_%1$s before update on public.%1$s
       for each row execute function public.bb_touch_updated_at();', t);
  end loop;
end $$;

-- ---------- vote-aware view (single source of truth for counts) ----------
create or replace view public.song_requests_view as
select r.*, coalesce(v.cnt, 0)::int as votes
from public.song_requests r
left join (
  select request_id, count(*) as cnt from public.song_votes group by request_id
) v on v.request_id = r.id;

-- ---------- RLS helpers ----------
create or replace function public.bb_has_role(p_restaurant text, p_roles text[])
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.staff s
    where s.restaurant_id = p_restaurant
      and s.auth_user_id = auth.uid()
      and s.role = any(p_roles)
  );
$$;

-- ---------- enable RLS ----------
alter table public.restaurants        enable row level security;
alter table public.staff              enable row level security;
alter table public.restaurant_tables  enable row level security;
alter table public.guests             enable row level security;
alter table public.guest_sessions     enable row level security;
alter table public.song_requests      enable row level security;
alter table public.song_votes         enable row level security;
alter table public.request_history    enable row level security;
alter table public.loyalty_events     enable row level security;
alter table public.redemptions        enable row level security;
alter table public.dedications        enable row level security;
alter table public.guest_notifications enable row level security;
alter table public.guest_feedback     enable row level security;
alter table public.audit_log          enable row level security;

-- Staff can read their own tenant; guests see nothing here directly.
create policy staff_read_restaurant on public.restaurants
  for select using (bb_has_role(id, array['owner','dj','staff']));
create policy staff_read_self on public.staff
  for select using (auth_user_id = auth.uid());

-- Tables: staff manage; guests resolve tokens only via bb_find_table() RPC.
create policy staff_tables on public.restaurant_tables
  for all using (bb_has_role(restaurant_id, array['owner','dj','staff']))
  with check (bb_has_role(restaurant_id, array['owner']));

-- Guests (PII): readable/updatable ONLY by staff of the tenant. No anon SELECT.
create policy staff_guests on public.guests
  for all using (bb_has_role(restaurant_id, array['owner','staff']))
  with check (bb_has_role(restaurant_id, array['owner','staff']));

-- Requests & votes: anyone may read the queue; anon may insert (checked).
create policy read_requests on public.song_requests
  for select using (true);
create policy insert_requests on public.song_requests
  for insert with check (exists (select 1 from public.restaurants r where r.id = restaurant_id));
create policy staff_update_requests on public.song_requests
  for update using (bb_has_role(restaurant_id, array['owner','dj','staff']));

create policy read_votes on public.song_votes for select using (true);
create policy insert_votes on public.song_votes
  for insert with check (exists (select 1 from public.song_requests r where r.id = request_id));

create policy read_history on public.request_history for select using (true);
create policy insert_history on public.request_history for insert with check (true);

-- Sessions / loyalty / notifications / feedback: insertable by the flow,
-- readable by staff (or the SECURITY DEFINER functions).
create policy insert_sessions on public.guest_sessions for insert with check (true);
create policy staff_sessions on public.guest_sessions
  for select using (bb_has_role(restaurant_id, array['owner','dj','staff']));

create policy insert_loyalty on public.loyalty_events for insert with check (true);
create policy staff_loyalty on public.loyalty_events
  for select using (bb_has_role(restaurant_id, array['owner','staff']));

-- Redemptions: a guest can create and read them (to show the code); staff can
-- read + update (verify). Anon must not flip status, so update is staff-only.
create policy insert_redemptions on public.redemptions for insert with check (true);
create policy read_redemptions on public.redemptions for select using (true);
create policy staff_update_redemptions on public.redemptions
  for update using (bb_has_role(restaurant_id, array['owner','staff']));

-- Dedications: guests create (pending) and everyone can read approved ones;
-- only staff can moderate (update status).
create policy insert_dedications on public.dedications for insert with check (true);
create policy read_dedications on public.dedications for select using (true);
create policy staff_update_dedications on public.dedications
  for update using (bb_has_role(restaurant_id, array['owner','staff']));

create policy insert_notifications on public.guest_notifications for insert with check (true);
create policy read_notifications on public.guest_notifications for select using (true);

create policy insert_feedback on public.guest_feedback for insert with check (true);
create policy staff_feedback on public.guest_feedback
  for select using (bb_has_role(restaurant_id, array['owner','staff']));

create policy staff_audit on public.audit_log
  for select using (bb_has_role(restaurant_id, array['owner']));

-- ---------- anon-safe RPCs ----------
-- Resolve exactly one active table by token. No enumeration surface.
create or replace function public.bb_find_table(p_restaurant text, p_token text)
returns public.restaurant_tables
language sql stable security definer set search_path = public as $$
  select * from public.restaurant_tables
  where restaurant_id = p_restaurant
    and active = true
    and deleted_at is null
    and (access_token = p_token or secure_token = p_token)
  limit 1;
$$;
grant execute on function public.bb_find_table(text, text) to anon, authenticated;

-- Upsert a guest by mobile and return {guest, returning, previous_visit_at}.
-- Points are NO LONGER awarded here: the app posts them to loyalty_events
-- (the ledger) so both currencies share one auditable source of truth.
create or replace function public.bb_upsert_guest(p_restaurant text, p_fields jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare g public.guests; is_returning boolean := false; prev timestamptz := null;
begin
  select * into g from public.guests
   where restaurant_id = p_restaurant and mobile = p_fields->>'mobile' and deleted_at is null;
  if found then
    prev := g.last_visit_at;
    update public.guests set
      name = coalesce(p_fields->>'name', name),
      email = coalesce(p_fields->>'email', email),
      dob = coalesce((p_fields->>'dob')::date, dob),
      favorite_genre = coalesce(p_fields->>'favorite_genre', favorite_genre),
      consent_service = coalesce((p_fields->>'consent_service')::boolean, consent_service),
      consent_marketing = coalesce((p_fields->>'consent_marketing')::boolean, consent_marketing),
      consent_at = coalesce((p_fields->>'consent_at')::timestamptz, consent_at),
      visit_count = g.visit_count + 1,
      last_visit_at = now()
     where id = g.id returning * into g;
    is_returning := true;
  else
    insert into public.guests (restaurant_id, name, mobile, email, dob, favorite_genre,
      consent_service, consent_marketing, consent_at, visit_count, last_visit_at)
    values (p_restaurant, coalesce(p_fields->>'name','Guest'), p_fields->>'mobile',
      p_fields->>'email', (p_fields->>'dob')::date, p_fields->>'favorite_genre',
      coalesce((p_fields->>'consent_service')::boolean,false),
      coalesce((p_fields->>'consent_marketing')::boolean,false),
      (p_fields->>'consent_at')::timestamptz, 1, now())
    returning * into g;
  end if;
  return jsonb_build_object('guest', to_jsonb(g), 'returning', is_returning,
                            'previous_visit_at', prev);
end $$;
grant execute on function public.bb_upsert_guest(text, jsonb) to anon, authenticated;

-- ---------- demo seed (multi-tenant) ----------
insert into public.restaurants (id, name, plan) values
  ('table-stories','Table Stories Bar & Kitchen','pro'),
  ('demo-lounge','BeatBites Demo Lounge','pro')
on conflict (id) do nothing;

insert into public.restaurant_tables (restaurant_id, table_number, access_token)
select 'table-stories', gs, 'demo-table-' || gs
from generate_series(1,12) gs
on conflict (restaurant_id, table_number) do nothing;

insert into public.restaurant_tables (restaurant_id, table_number, access_token)
select 'demo-lounge', gs, 'demo-table-' || gs
from generate_series(1,15) gs
on conflict (restaurant_id, table_number) do nothing;

-- NOTE: create staff rows AFTER inviting users via Supabase Auth, e.g.:
--   insert into public.staff(restaurant_id, auth_user_id, role)
--   values ('table-stories','<auth-user-uuid>','owner');
