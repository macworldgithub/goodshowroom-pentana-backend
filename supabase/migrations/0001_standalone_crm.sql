create extension if not exists pgcrypto;

create table public.organisations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) between 2 and 120),
  created_at timestamptz not null default now()
);

create table public.sites (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  name text not null check (length(trim(name)) between 2 and 120),
  timezone text not null default 'Australia/Sydney',
  created_at timestamptz not null default now(),
  unique (organisation_id, id),
  unique (organisation_id, name)
);

create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  site_id uuid,
  user_id uuid not null references auth.users(id) on delete cascade,
  role text not null check (role in (
    'dealer_principal', 'dealer_admin', 'sales_manager', 'sales_consultant',
    'service_controller', 'service_advisor', 'bdc_aftersales', 'platform_operator'
  )),
  created_at timestamptz not null default now(),
  foreign key (organisation_id, site_id) references public.sites(organisation_id, id) on delete cascade,
  unique (organisation_id, site_id, user_id, role)
);

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  site_id uuid not null,
  created_by uuid not null references auth.users(id),
  assigned_to uuid references auth.users(id),
  first_name text not null check (length(trim(first_name)) between 1 and 100),
  last_name text not null check (length(trim(last_name)) between 1 and 100),
  email text,
  phone text,
  source text not null default 'manual',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organisation_id, id),
  foreign key (organisation_id, site_id) references public.sites(organisation_id, id)
);

create table public.tasks (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  site_id uuid not null,
  customer_id uuid not null,
  created_by uuid not null references auth.users(id),
  assigned_to uuid not null references auth.users(id),
  title text not null check (length(trim(title)) between 2 and 180),
  details text,
  due_at timestamptz not null,
  priority text not null default 'normal' check (priority in ('low', 'normal', 'high')),
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (organisation_id, site_id) references public.sites(organisation_id, id),
  foreign key (organisation_id, customer_id) references public.customers(organisation_id, id)
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id) on delete cascade,
  site_id uuid,
  actor_user_id uuid references auth.users(id) on delete set null,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  foreign key (organisation_id, site_id) references public.sites(organisation_id, id)
);

create index customers_site_updated_idx on public.customers(site_id, updated_at desc);
create index customers_site_name_idx on public.customers(site_id, lower(last_name), lower(first_name));
create index tasks_site_assignee_due_idx on public.tasks(site_id, assigned_to, due_at) where completed_at is null;
create index audit_events_org_created_idx on public.audit_events(organisation_id, created_at desc);

create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = public as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger customers_touch_updated_at before update on public.customers
for each row execute function public.touch_updated_at();
create trigger tasks_touch_updated_at before update on public.tasks
for each row execute function public.touch_updated_at();

create or replace function public.is_org_member(target_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.organisation_id = target_org and m.user_id = auth.uid()
  );
$$;

create or replace function public.can_access_site(target_org uuid, target_site uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.memberships m
    where m.organisation_id = target_org and m.user_id = auth.uid()
      and (m.site_id is null or m.site_id = target_site)
  );
$$;

create or replace function public.is_initial_setup_available()
returns boolean language sql stable security definer set search_path = public as $$
  select auth.uid() is not null and not exists (select 1 from public.organisations);
$$;

create or replace function public.bootstrap_first_organisation(p_name text, p_site_name text, p_timezone text, p_user_id uuid)
returns table (organisation_id uuid, site_id uuid)
language plpgsql security definer set search_path = public, auth as $$
declare
  new_org uuid;
  new_site uuid;
begin
  if p_user_id is null or not exists (select 1 from auth.users u where u.id = p_user_id) then raise exception 'A valid invited user is required'; end if;
  if length(trim(p_name)) not between 2 and 120 or length(trim(p_site_name)) not between 2 and 120 then
    raise exception 'Organisation and site names must be between 2 and 120 characters';
  end if;
  perform pg_advisory_xact_lock(781246031);
  if exists (select 1 from public.organisations) then raise exception 'Initial setup has already been completed'; end if;
  insert into public.organisations(name) values (trim(p_name)) returning id into new_org;
  insert into public.sites(organisation_id, name, timezone)
    values (new_org, trim(p_site_name), coalesce(nullif(trim(p_timezone), ''), 'Australia/Sydney')) returning id into new_site;
  insert into public.memberships(organisation_id, site_id, user_id, role)
    values (new_org, null, p_user_id, 'dealer_admin');
  return query select new_org, new_site;
end;
$$;

revoke all on function public.is_org_member(uuid) from public, anon;
revoke all on function public.can_access_site(uuid, uuid) from public, anon;
revoke all on function public.is_initial_setup_available() from public, anon;
revoke all on function public.bootstrap_first_organisation(text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.is_org_member(uuid) to authenticated;
grant execute on function public.can_access_site(uuid, uuid) to authenticated;
grant execute on function public.is_initial_setup_available() to authenticated;
grant execute on function public.bootstrap_first_organisation(text, text, text, uuid) to service_role;

alter table public.organisations enable row level security;
alter table public.sites enable row level security;
alter table public.memberships enable row level security;
alter table public.customers enable row level security;
alter table public.tasks enable row level security;
alter table public.audit_events enable row level security;

create policy organisations_read_member on public.organisations for select to authenticated
  using (public.is_org_member(id));
create policy sites_read_member on public.sites for select to authenticated
  using (public.can_access_site(organisation_id, id));
create policy memberships_read_self on public.memberships for select to authenticated
  using (user_id = auth.uid());

create policy customers_read_site on public.customers for select to authenticated
  using (public.can_access_site(organisation_id, site_id));
create policy customers_insert_site on public.customers for insert to authenticated
  with check (public.can_access_site(organisation_id, site_id) and created_by = auth.uid());
create policy customers_update_site on public.customers for update to authenticated
  using (public.can_access_site(organisation_id, site_id))
  with check (public.can_access_site(organisation_id, site_id));

create policy tasks_read_site on public.tasks for select to authenticated
  using (public.can_access_site(organisation_id, site_id));
create policy tasks_insert_site on public.tasks for insert to authenticated
  with check (public.can_access_site(organisation_id, site_id) and created_by = auth.uid());
create policy tasks_update_site on public.tasks for update to authenticated
  using (public.can_access_site(organisation_id, site_id))
  with check (public.can_access_site(organisation_id, site_id));

create policy audit_read_org_member on public.audit_events for select to authenticated
  using (public.is_org_member(organisation_id));
create policy audit_insert_actor on public.audit_events for insert to authenticated
  with check (public.can_access_site(organisation_id, site_id) and actor_user_id = auth.uid());

grant select on public.organisations, public.sites, public.memberships to authenticated;
grant select, insert, update on public.customers, public.tasks to authenticated;
grant select, insert on public.audit_events to authenticated;

create or replace function public.create_customer(
  p_site_id uuid, p_first_name text, p_last_name text, p_email text, p_phone text
) returns setof public.customers
language plpgsql security invoker set search_path = public as $$
declare
  target_org uuid;
  created_customer public.customers;
begin
  select s.organisation_id into target_org from public.sites s where s.id = p_site_id;
  if target_org is null then raise exception 'Site is not available'; end if;
  insert into public.customers(organisation_id, site_id, created_by, assigned_to, first_name, last_name, email, phone)
    values (target_org, p_site_id, auth.uid(), auth.uid(), trim(p_first_name), trim(p_last_name), nullif(trim(p_email), ''), nullif(trim(p_phone), ''))
    returning * into created_customer;
  insert into public.audit_events(organisation_id, site_id, actor_user_id, action, entity_type, entity_id)
    values (target_org, p_site_id, auth.uid(), 'customer.created', 'customer', created_customer.id);
  return next created_customer;
end;
$$;

create or replace function public.create_followup(
  p_site_id uuid, p_customer_id uuid, p_title text, p_details text, p_due_at timestamptz, p_priority text default 'normal'
) returns setof public.tasks
language plpgsql security invoker set search_path = public as $$
declare
  target_org uuid;
  created_task public.tasks;
begin
  select c.organisation_id into target_org from public.customers c
    where c.id = p_customer_id and c.site_id = p_site_id;
  if target_org is null then raise exception 'Customer is not available at this site'; end if;
  insert into public.tasks(organisation_id, site_id, customer_id, created_by, assigned_to, title, details, due_at, priority)
    values (target_org, p_site_id, p_customer_id, auth.uid(), auth.uid(), trim(p_title), nullif(trim(p_details), ''), p_due_at, p_priority)
    returning * into created_task;
  insert into public.audit_events(organisation_id, site_id, actor_user_id, action, entity_type, entity_id)
    values (target_org, p_site_id, auth.uid(), 'task.created', 'task', created_task.id);
  return next created_task;
end;
$$;

create or replace function public.complete_followup(p_task_id uuid, p_site_id uuid)
returns setof public.tasks
language plpgsql security invoker set search_path = public as $$
declare
  completed_task public.tasks;
begin
  update public.tasks set completed_at = now()
    where id = p_task_id and site_id = p_site_id and completed_at is null
    returning * into completed_task;
  if completed_task.id is null then raise exception 'Task was already completed or is not available'; end if;
  insert into public.audit_events(organisation_id, site_id, actor_user_id, action, entity_type, entity_id)
    values (completed_task.organisation_id, p_site_id, auth.uid(), 'task.completed', 'task', completed_task.id);
  return next completed_task;
end;
$$;

revoke all on function public.create_customer(uuid, text, text, text, text) from public, anon;
revoke all on function public.create_followup(uuid, uuid, text, text, timestamptz, text) from public, anon;
revoke all on function public.complete_followup(uuid, uuid) from public, anon;
grant execute on function public.create_customer(uuid, text, text, text, text) to authenticated;
grant execute on function public.create_followup(uuid, uuid, text, text, timestamptz, text) to authenticated;
grant execute on function public.complete_followup(uuid, uuid) to authenticated;
