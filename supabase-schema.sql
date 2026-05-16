-- Supabase database schema for AI Chat code access management

create table if not exists device_codes (
  device_code text primary key,
  name text,
  access_password text,
  active boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists one_time_passwords (
  code text primary key,
  created_at timestamptz not null default now(),
  redeemed_at timestamptz,
  redeemed_device_code text
);

create table if not exists unauthorized_visits (
  id bigserial primary key,
  device_code text not null,
  visited_at timestamptz not null default now()
);

create table if not exists settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create index if not exists idx_one_time_passwords_redeemed_at on one_time_passwords (redeemed_at);
create index if not exists idx_unauthorized_visits_device_code on unauthorized_visits (device_code);
create index if not exists idx_unauthorized_visits_visited_at on unauthorized_visits (visited_at);
