-- BeatBites V5 Supabase schema: V4 + V5 features.
-- Run in Supabase SQL editor. Policies are demo-oriented; production should use Auth roles/server APIs.

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
  loyalty_points int not null default 0,
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
  genre text,
  artwork_url text,
  preview_url text,
  status text not null default 'queued' check (status in ('queued','playing','played','removed','rejected','skipped')),
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

create table if not exists public.request_history (
  id uuid primary key,
  restaurant_id text not null,
  request_id uuid,
  guest_id uuid,
  table_number int,
  title text,
  artist text,
  genre text,
  history_status text not null,
  history_at timestamptz not null default now()
);

create table if not exists public.loyalty_events (
  id uuid primary key,
  restaurant_id text not null,
  guest_id uuid references public.guests(id),
  points int not null,
  reason text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.guest_notifications (
  id uuid primary key,
  restaurant_id text not null,
  guest_id uuid references public.guests(id),
  message text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create or replace view public.song_requests_view as
select r.*, count(v.id)::int as votes
from public.song_requests r
left join public.song_votes v on v.request_id = r.id
group by r.id;

create index if not exists idx_tables_token on public.restaurant_tables(access_token);
create index if not exists idx_requests_queue on public.song_requests(restaurant_id,status,requested_at);
create index if not exists idx_votes_request on public.song_votes(request_id);
create index if not exists idx_guests_mobile on public.guests(restaurant_id,mobile);
create index if not exists idx_history_restaurant on public.request_history(restaurant_id,history_at);

alter table public.restaurant_tables enable row level security;
alter table public.guests enable row level security;
alter table public.guest_sessions enable row level security;
alter table public.song_requests enable row level security;
alter table public.song_votes enable row level security;
alter table public.request_history enable row level security;
alter table public.loyalty_events enable row level security;
alter table public.guest_notifications enable row level security;

-- Demo policies. For paid production, replace with secure Auth role policies or server APIs.
create policy "read active tables" on public.restaurant_tables for select using (active = true);
create policy "guest read" on public.guests for select using (true);
create policy "guest insert" on public.guests for insert with check (true);
create policy "guest update" on public.guests for update using (true) with check (true);
create policy "session read" on public.guest_sessions for select using (true);
create policy "session insert" on public.guest_sessions for insert with check (true);
create policy "request read" on public.song_requests for select using (true);
create policy "request insert" on public.song_requests for insert with check (status='queued');
create policy "request update demo" on public.song_requests for update using (true) with check (true);
create policy "vote read" on public.song_votes for select using (true);
create policy "vote insert" on public.song_votes for insert with check (true);
create policy "history read" on public.request_history for select using (true);
create policy "history insert" on public.request_history for insert with check (true);
create policy "loyalty read" on public.loyalty_events for select using (true);
create policy "loyalty insert" on public.loyalty_events for insert with check (true);
create policy "notifications read" on public.guest_notifications for select using (true);
create policy "notifications insert" on public.guest_notifications for insert with check (true);

insert into public.restaurant_tables (id, restaurant_id, table_number, access_token, active)
select gen_random_uuid(), 'demo-restaurant', n, 'demo-table-' || n, true
from generate_series(1,15) n
on conflict (restaurant_id, table_number) do nothing;
