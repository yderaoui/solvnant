-- AI Grand Prix: Phase 1 schema. Paste into Supabase → SQL Editor → Run.
-- The browser only ever uses the public (anon/publishable) key: read-only, enforced by RLS below.
-- The scheduler writes with the service-role (secret) key, which bypasses RLS. Never ship that key to the browser.

create extension if not exists pgcrypto;

-- Driver code written by models (plus the fallback and house bots). Deduplicated by code_hash.
create table if not exists public.drivers (
  id          uuid primary key default gen_random_uuid(),
  model       text not null,
  code        text not null,
  code_hash   text not null unique,
  source      text not null check (source in ('llm', 'fallback', 'house')),
  valid       boolean not null default false,
  error       text,
  created_at  timestamptz not null default now()
);
create index if not exists drivers_model_created_idx on public.drivers (model, created_at desc);

-- One race per 5-minute slot. seed + the entries' driver code fully determine the race.
create table if not exists public.races (
  id           bigint generated always as identity primary key,
  slot         bigint not null unique,
  seed         text not null,
  laps         int not null,
  start_at     timestamptz not null,
  ends_at      timestamptz not null,
  sim_version  text not null,
  created_at   timestamptz not null default now()
);
create index if not exists races_start_idx on public.races (start_at desc);

create table if not exists public.race_entries (
  race_id    bigint not null references public.races (id) on delete cascade,
  car        int not null,
  model      text not null,
  name       text not null,
  color      text not null,
  source     text not null check (source in ('llm', 'fallback', 'house')),
  driver_id  uuid references public.drivers (id),
  primary key (race_id, car)
);

create table if not exists public.race_results (
  race_id       bigint not null,
  car           int not null,
  position      int not null,
  finished      boolean not null,
  finish_time   real,
  best_lap      real,
  laps_done     int not null default 0,
  crashed       boolean not null default false,
  crash_reason  text,
  contacts      int not null default 0,
  primary key (race_id, car),
  foreign key (race_id, car) references public.race_entries (race_id, car) on delete cascade
);

-- ---------------------------------------------------------------- Row Level Security
alter table public.drivers      enable row level security;
alter table public.races        enable row level security;
alter table public.race_entries enable row level security;
alter table public.race_results enable row level security;

drop policy if exists "public read" on public.drivers;
drop policy if exists "public read" on public.races;
drop policy if exists "public read" on public.race_entries;
drop policy if exists "read after the race" on public.race_results;

create policy "public read" on public.drivers      for select using (true);
create policy "public read" on public.races        for select using (true);
create policy "public read" on public.race_entries for select using (true);
-- Results are computed ahead of time; hide them until the race has actually been run (no spoilers).
create policy "read after the race" on public.race_results for select using (
  exists (select 1 from public.races r where r.id = race_id and r.ends_at <= now())
);

grant usage on schema public to anon, authenticated;
grant select on public.drivers, public.races, public.race_entries, public.race_results to anon, authenticated;

-- ---------------------------------------------------------------- Leaderboard
-- Only races a model drove with its own code count (fallback-driven races are excluded).
-- House bots are included as a baseline: can the models beat a hand-written driver?
create or replace view public.model_leaderboard with (security_invoker = true) as
select
  e.model,
  count(*)::int                                             as races,
  count(*) filter (where rr.position = 1)::int              as wins,
  count(*) filter (where rr.position <= 3)::int             as podiums,
  round(avg(rr.position)::numeric, 2)                       as avg_position,
  count(*) filter (where rr.crashed)::int                   as crashes,
  round(min(rr.best_lap)::numeric, 2)                       as best_lap
from public.race_results rr
join public.race_entries e on e.race_id = rr.race_id and e.car = rr.car
join public.races r on r.id = rr.race_id
where r.ends_at <= now() and e.source in ('llm', 'house')
group by e.model
order by wins desc, podiums desc, avg_position asc;

grant select on public.model_leaderboard to anon, authenticated;
