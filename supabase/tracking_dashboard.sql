create table if not exists public.tracking_dashboard (
  row_id text primary key,
  order_number text not null,
  order_sort integer,
  supliful_order text,
  item text,
  customer_name text,
  phone text,
  order_date date,
  date_shipped date,
  tracking_number text,
  usps_url text,
  delivery_date date,
  status text,
  status_source text,
  business_days_open integer not null default 0,
  is_overdue boolean not null default false,
  observation text,
  raw_data jsonb not null default '{}'::jsonb,
  source_updated_at timestamptz,
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists tracking_dashboard_order_number_idx
  on public.tracking_dashboard (order_number);

create index if not exists tracking_dashboard_tracking_number_idx
  on public.tracking_dashboard (tracking_number);

create index if not exists tracking_dashboard_status_idx
  on public.tracking_dashboard (status);

create index if not exists tracking_dashboard_is_overdue_idx
  on public.tracking_dashboard (is_overdue);

create or replace function public.set_tracking_dashboard_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists set_tracking_dashboard_updated_at on public.tracking_dashboard;

create trigger set_tracking_dashboard_updated_at
before update on public.tracking_dashboard
for each row
execute function public.set_tracking_dashboard_updated_at();

alter table public.tracking_dashboard enable row level security;

drop policy if exists "tracking dashboard anon read" on public.tracking_dashboard;
create policy "tracking dashboard anon read"
on public.tracking_dashboard
for select
to anon
using (true);

drop policy if exists "tracking dashboard anon insert" on public.tracking_dashboard;
create policy "tracking dashboard anon insert"
on public.tracking_dashboard
for insert
to anon
with check (true);

drop policy if exists "tracking dashboard anon update" on public.tracking_dashboard;
create policy "tracking dashboard anon update"
on public.tracking_dashboard
for update
to anon
using (true)
with check (true);

grant usage on schema public to anon;
grant select, insert, update on public.tracking_dashboard to anon;
