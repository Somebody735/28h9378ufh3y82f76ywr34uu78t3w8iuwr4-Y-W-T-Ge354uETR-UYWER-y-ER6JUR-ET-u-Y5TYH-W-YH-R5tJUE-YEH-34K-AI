-- Supabase database schema for AI Chat code access management

create table if not exists device_codes (
  device_code text primary key,
  access_password text,
  active boolean not null default false,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists one_time_passwords (
  code text primary key,
  created_at timestamptz not null default now(),
  redeemed_at timestamptz,
  redeemed_device_code text
);

create index if not exists idx_one_time_passwords_redeemed_at on one_time_passwords (redeemed_at);
