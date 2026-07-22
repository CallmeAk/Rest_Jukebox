-- BeatBites V3 Supabase schema: secure table tokens + guest CRM + voting queue.
-- Run in Supabase SQL editor.

create table if not exists public.restaurant_tables (
  id uuid primary key,
  restaurant_id text not null,
  table_number int not null,
  access_token text not null unique,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (restaurant_id, table_number)
);

create table if not exists public.guests (
  id uuid primary key,
  restaurant_id text not null,
  name text not null,
  mobile text not null,
  email text,
  dob date,
  favorite_genre text,
  consent_marketing boolean not null default true,
  visit_count int not null default 1,
  created_at timestamptz not null default now(),
  last_visit_at timestamptz not null default now(),
  unique (restaurant_id, mobile)
);

create table if not exists public.guest_sessions (
  id uuid primary key,
  restaurant_id text not null,
  guest_id uuid references public.guests(id),
  table_id uuid references public.restaurant_tables(id),
  table_number int not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.song_requests (
  id uuid primary key,
  restaurant_id text not null,
  guest_id uuid references public.guests(id),
  session_id uuid references public.guest_sessions(id),
  table_number int not null,
  title text not null,
  artist text not null,
  artwork_url text,
  preview_url text,
  status text not null default 'queued' check (status in ('queued','playing','played','removed','rejected')),
  requested_at timestamptz not null default now(),
  played_at timestamptz
);

create table if not exists public.song_votes (
  id uuid primary key,
  restaurant_id text not null,
  request_id uuid references public.song_requests(id) on delete cascade,
  session_id uuid references public.guest_sessions(id),
  guest_id uuid references public.guests(id),
  created_at timestamptz not null default now(),
  unique (request_id, session_id)
);

create or replace view public.song_requests_view as
select r.*, count(v.id)::int as votes
from public.song_requests r
left join public.song_votes v on v.request_id = r.id
group by r.id;

create index if not exists idx_restaurant_tables_token on public.restaurant_tables(access_token);
create index if not exists idx_song_requests_queue on public.song_requests(restaurant_id,status,requested_at);
create index if not exists idx_song_votes_request on public.song_votes(request_id);

alter table public.restaurant_tables enable row level security;
alter table public.guests enable row level security;
alter table public.guest_sessions enable row level security;
alter table public.song_requests enable row level security;
alter table public.song_votes enable row level security;

-- Demo policies. For paid production, use Supabase Auth roles or server-side APIs for admin/DJ updates.
drop policy if exists "read active tables" on public.restaurant_tables;
create policy "read active tables" on public.restaurant_tables for select using (active = true);

drop policy if exists "guest read create" on public.guests;
create policy "guest read create" on public.guests for select using (true);
create policy "guest insert" on public.guests for insert with check (true);
create policy "guest update" on public.guests for update using (true) with check (true);

drop policy if exists "session insert read" on public.guest_sessions;
create policy "session read" on public.guest_sessions for select using (true);
create policy "session insert" on public.guest_sessions for insert with check (true);

drop policy if exists "request read" on public.song_requests;
create policy "request read" on public.song_requests for select using (true);
create policy "request insert" on public.song_requests for insert with check (status='queued');
create policy "request update demo" on public.song_requests for update using (true) with check (true);

drop policy if exists "vote read insert" on public.song_votes;
create policy "vote read" on public.song_votes for select using (true);
create policy "vote insert" on public.song_votes for insert with check (true);

-- Seed demo tables. Replace access_token values with cryptographically random tokens for production QR print.
insert into public.restaurant_tables (id, restaurant_id, table_number, access_token, active)
select gen_random_uuid(), 'demo-restaurant', n, 'demo-table-' || n, true
from generate_series(1,15) n
on conflict (restaurant_id, table_number) do nothing;
