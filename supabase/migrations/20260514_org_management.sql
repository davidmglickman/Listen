alter table public.organizations
  add column if not exists status text not null default 'active';

alter table public.organizations
  add column if not exists max_users integer;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'organizations_status_check'
      and conrelid = 'public.organizations'::regclass
  ) then
    alter table public.organizations
      add constraint organizations_status_check
      check (status in ('active', 'disabled'));
  end if;
end
$$;

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'organizations_max_users_check'
      and conrelid = 'public.organizations'::regclass
  ) then
    alter table public.organizations
      add constraint organizations_max_users_check
      check (max_users is null or max_users > 0);
  end if;
end
$$;