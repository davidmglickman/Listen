alter table public.profiles
  add column if not exists status text not null default 'active';

alter table public.profiles
  alter column role set default 'member';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_role_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_role_check
      check (role in ('owner', 'admin', 'member'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'profiles_status_check'
      and conrelid = 'public.profiles'::regclass
  ) then
    alter table public.profiles
      add constraint profiles_status_check
      check (status in ('invited', 'active', 'disabled'));
  end if;
end
$$;

create table if not exists public.user_invitations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  email text not null,
  role text not null default 'member',
  status text not null default 'pending',
  invite_token_hash text not null unique,
  invited_by uuid references public.profiles(id) on delete set null,
  accepted_user_id uuid references public.profiles(id) on delete set null,
  expires_at timestamptz not null,
  last_sent_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, email)
);

create table if not exists public.connected_accounts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  provider text not null,
  provider_subject text not null,
  provider_email text,
  scopes text[] not null default '{}',
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (provider, provider_subject),
  unique (profile_id, provider)
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_invitations_role_check'
      and conrelid = 'public.user_invitations'::regclass
  ) then
    alter table public.user_invitations
      add constraint user_invitations_role_check
      check (role in ('owner', 'admin', 'member'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'user_invitations_status_check'
      and conrelid = 'public.user_invitations'::regclass
  ) then
    alter table public.user_invitations
      add constraint user_invitations_status_check
      check (status in ('pending', 'accepted', 'revoked', 'expired'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'connected_accounts_provider_check'
      and conrelid = 'public.connected_accounts'::regclass
  ) then
    alter table public.connected_accounts
      add constraint connected_accounts_provider_check
      check (provider in ('google', 'email'));
  end if;
end
$$;

drop trigger if exists user_invitations_set_updated_at on public.user_invitations;
create trigger user_invitations_set_updated_at before update on public.user_invitations for each row execute function public.set_updated_at();

drop trigger if exists connected_accounts_set_updated_at on public.connected_accounts;
create trigger connected_accounts_set_updated_at before update on public.connected_accounts for each row execute function public.set_updated_at();

alter table public.user_invitations enable row level security;
alter table public.connected_accounts enable row level security;

drop policy if exists profiles_select_same_org on public.profiles;
create policy profiles_select_same_org on public.profiles
  for select using (organization_id = public.current_organization_id());

drop policy if exists profiles_update_same_org_admin_or_self on public.profiles;
create policy profiles_update_same_org_admin_or_self on public.profiles
  for update using (
    id = auth.uid()
    or exists (
      select 1 from public.profiles viewer
      where viewer.id = auth.uid()
        and viewer.organization_id = profiles.organization_id
        and viewer.role in ('owner', 'admin')
        and viewer.status = 'active'
    )
  ) with check (
    id = auth.uid()
    or exists (
      select 1 from public.profiles viewer
      where viewer.id = auth.uid()
        and viewer.organization_id = profiles.organization_id
        and viewer.role in ('owner', 'admin')
        and viewer.status = 'active'
    )
  );

drop policy if exists user_invitations_same_org_admin_manage on public.user_invitations;
create policy user_invitations_same_org_admin_manage on public.user_invitations
  for all using (
    exists (
      select 1 from public.profiles viewer
      where viewer.id = auth.uid()
        and viewer.organization_id = user_invitations.organization_id
        and viewer.role in ('owner', 'admin')
        and viewer.status = 'active'
    )
  ) with check (
    exists (
      select 1 from public.profiles viewer
      where viewer.id = auth.uid()
        and viewer.organization_id = user_invitations.organization_id
        and viewer.role in ('owner', 'admin')
        and viewer.status = 'active'
    )
  );

drop policy if exists connected_accounts_same_user_or_org_admin on public.connected_accounts;
create policy connected_accounts_same_user_or_org_admin on public.connected_accounts
  for all using (
    profile_id = auth.uid()
    or exists (
      select 1
      from public.profiles owner_profile
      join public.profiles viewer on viewer.organization_id = owner_profile.organization_id
      where owner_profile.id = connected_accounts.profile_id
        and viewer.id = auth.uid()
        and viewer.role in ('owner', 'admin')
        and viewer.status = 'active'
    )
  ) with check (
    profile_id = auth.uid()
    or exists (
      select 1
      from public.profiles owner_profile
      join public.profiles viewer on viewer.organization_id = owner_profile.organization_id
      where owner_profile.id = connected_accounts.profile_id
        and viewer.id = auth.uid()
        and viewer.role in ('owner', 'admin')
        and viewer.status = 'active'
    )
  );