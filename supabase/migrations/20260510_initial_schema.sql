create extension if not exists pgcrypto;

create table if not exists public.organizations (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  domain text unique,
  linkedin_url text,
  description text,
  industry text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text,
  full_name text,
  role text not null default 'member',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.people (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  external_id text,
  full_name text not null,
  email text,
  title text,
  linkedin_url text,
  company_domain text,
  company_name text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, email),
  unique (organization_id, external_id)
);

create table if not exists public.meetings (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  owner_user_id uuid references public.profiles(id) on delete set null,
  external_id text,
  title text not null,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  source text not null default 'calendar',
  organizer_email text,
  join_url text,
  notes text,
  context jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, external_id)
);

create table if not exists public.meeting_attendees (
  id uuid primary key default gen_random_uuid(),
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  person_id uuid references public.people(id) on delete set null,
  full_name text not null,
  email text,
  title text,
  linkedin_url text,
  role text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.research_jobs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  meeting_id uuid not null references public.meetings(id) on delete cascade,
  person_id uuid references public.people(id) on delete set null,
  status text not null,
  source text not null,
  lookup_key text not null,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.research_snapshots (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  research_job_id uuid not null unique references public.research_jobs(id) on delete cascade,
  person_summary text,
  organization_summary text,
  recent_signals jsonb not null default '[]'::jsonb,
  linkedin_url text,
  source_links jsonb not null default '[]'::jsonb,
  raw_payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.coaching_profiles (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  scope text not null,
  label text not null,
  guidance text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.meeting_context_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  title text not null,
  context jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists organizations_set_updated_at on public.organizations;
create trigger organizations_set_updated_at before update on public.organizations for each row execute function public.set_updated_at();
drop trigger if exists profiles_set_updated_at on public.profiles;
create trigger profiles_set_updated_at before update on public.profiles for each row execute function public.set_updated_at();
drop trigger if exists people_set_updated_at on public.people;
create trigger people_set_updated_at before update on public.people for each row execute function public.set_updated_at();
drop trigger if exists meetings_set_updated_at on public.meetings;
create trigger meetings_set_updated_at before update on public.meetings for each row execute function public.set_updated_at();
drop trigger if exists research_jobs_set_updated_at on public.research_jobs;
create trigger research_jobs_set_updated_at before update on public.research_jobs for each row execute function public.set_updated_at();
drop trigger if exists research_snapshots_set_updated_at on public.research_snapshots;
create trigger research_snapshots_set_updated_at before update on public.research_snapshots for each row execute function public.set_updated_at();
drop trigger if exists coaching_profiles_set_updated_at on public.coaching_profiles;
create trigger coaching_profiles_set_updated_at before update on public.coaching_profiles for each row execute function public.set_updated_at();
drop trigger if exists meeting_context_templates_set_updated_at on public.meeting_context_templates;
create trigger meeting_context_templates_set_updated_at before update on public.meeting_context_templates for each row execute function public.set_updated_at();

alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.people enable row level security;
alter table public.meetings enable row level security;
alter table public.meeting_attendees enable row level security;
alter table public.research_jobs enable row level security;
alter table public.research_snapshots enable row level security;
alter table public.coaching_profiles enable row level security;
alter table public.meeting_context_templates enable row level security;

create or replace function public.current_organization_id()
returns uuid
language sql
stable
as $$
  select organization_id from public.profiles where id = auth.uid()
$$;

drop policy if exists organizations_select_same_org on public.organizations;
create policy organizations_select_same_org on public.organizations
  for select using (id = public.current_organization_id());

drop policy if exists profiles_select_same_org on public.profiles;
create policy profiles_select_same_org on public.profiles
  for select using (organization_id = public.current_organization_id());

drop policy if exists profiles_update_self on public.profiles;
create policy profiles_update_self on public.profiles
  for update using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists people_same_org on public.people;
create policy people_same_org on public.people
  for all using (organization_id = public.current_organization_id()) with check (organization_id = public.current_organization_id());

drop policy if exists meetings_same_org on public.meetings;
create policy meetings_same_org on public.meetings
  for all using (organization_id = public.current_organization_id()) with check (organization_id = public.current_organization_id());

drop policy if exists attendees_same_org on public.meeting_attendees;
create policy attendees_same_org on public.meeting_attendees
  for all using (
    exists (
      select 1 from public.meetings
      where public.meetings.id = meeting_attendees.meeting_id
        and public.meetings.organization_id = public.current_organization_id()
    )
  ) with check (
    exists (
      select 1 from public.meetings
      where public.meetings.id = meeting_attendees.meeting_id
        and public.meetings.organization_id = public.current_organization_id()
    )
  );

drop policy if exists research_jobs_same_org on public.research_jobs;
create policy research_jobs_same_org on public.research_jobs
  for all using (organization_id = public.current_organization_id()) with check (organization_id = public.current_organization_id());

drop policy if exists research_snapshots_same_org on public.research_snapshots;
create policy research_snapshots_same_org on public.research_snapshots
  for all using (organization_id = public.current_organization_id()) with check (organization_id = public.current_organization_id());

drop policy if exists coaching_profiles_same_org on public.coaching_profiles;
create policy coaching_profiles_same_org on public.coaching_profiles
  for select using (organization_id = public.current_organization_id());

drop policy if exists coaching_profiles_org_admin_write on public.coaching_profiles;
create policy coaching_profiles_org_admin_write on public.coaching_profiles
  for all using (
    exists (
      select 1 from public.profiles
      where public.profiles.id = auth.uid()
        and public.profiles.organization_id = coaching_profiles.organization_id
        and public.profiles.role = 'admin'
    )
    or user_id = auth.uid()
  ) with check (
    exists (
      select 1 from public.profiles
      where public.profiles.id = auth.uid()
        and public.profiles.organization_id = coaching_profiles.organization_id
        and public.profiles.role = 'admin'
    )
    or user_id = auth.uid()
  );

drop policy if exists meeting_context_templates_same_org on public.meeting_context_templates;
create policy meeting_context_templates_same_org on public.meeting_context_templates
  for select using (organization_id = public.current_organization_id());

drop policy if exists meeting_context_templates_org_admin_write on public.meeting_context_templates;
create policy meeting_context_templates_org_admin_write on public.meeting_context_templates
  for all using (
    exists (
      select 1 from public.profiles
      where public.profiles.id = auth.uid()
        and public.profiles.organization_id = meeting_context_templates.organization_id
        and public.profiles.role = 'admin'
    )
    or user_id = auth.uid()
  ) with check (
    exists (
      select 1 from public.profiles
      where public.profiles.id = auth.uid()
        and public.profiles.organization_id = meeting_context_templates.organization_id
        and public.profiles.role = 'admin'
    )
    or user_id = auth.uid()
  );