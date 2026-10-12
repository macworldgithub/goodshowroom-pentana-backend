-- Apply after 0001_standalone_crm.sql. All access decisions use current DB state.
begin;

alter table public.memberships drop constraint memberships_role_check;
update public.memberships set role = case
  when role in ('dealer_admin', 'platform_operator') then 'ADMIN'
  when role in ('service_controller', 'service_advisor') then 'SERVICE'
  else 'SALES' end;
-- Principal/manager/BDC migrate without receiving user-administration rights.
-- Review existing staff grants after migration.
delete from public.memberships where id in (
  select id from (select id, row_number() over (
    partition by organisation_id, site_id, user_id, role order by created_at, id
  ) as position from public.memberships) duplicates where position > 1
);
-- ADMIN is organisation-wide; consolidate legacy site-specific admin grants.
update public.memberships set site_id = null where role = 'ADMIN';
delete from public.memberships where id in (
  select id from (select id, row_number() over (
    partition by organisation_id, site_id, user_id, role order by created_at, id
  ) as position from public.memberships) duplicates where position > 1
);
alter table public.memberships add constraint memberships_role_check check (role in ('ADMIN', 'SALES', 'SERVICE'));
alter table public.memberships add constraint memberships_admin_scope_check check (role <> 'ADMIN' or site_id is null);
alter table public.memberships add column status text not null default 'active' check (status in ('active', 'suspended'));
alter table public.memberships add column extra_permissions text[] not null default '{}'
  check (extra_permissions <@ array['customers.view_team','customers.assign','tasks.view_team','sales.view_team','sales.assign_leads','service.view_team','service.assign_work']::text[]);
create unique index memberships_scope_role_idx on public.memberships(organisation_id, site_id, user_id, role) nulls not distinct;
create index memberships_user_active_idx on public.memberships(user_id, organisation_id) where status = 'active';

create table public.role_permissions (
  role text not null check (role in ('ADMIN','SALES','SERVICE')),
  permission text not null,
  primary key (role, permission)
);
insert into public.role_permissions values
 ('ADMIN','users.manage'), ('ADMIN','customers.read'), ('ADMIN','customers.write'),
 ('ADMIN','customers.view_team'), ('ADMIN','customers.assign'), ('ADMIN','tasks.read'),
 ('ADMIN','tasks.write'), ('ADMIN','tasks.view_team'), ('ADMIN','audit.read'),
 ('ADMIN','sales.view_team'), ('ADMIN','sales.assign_leads'),
 ('ADMIN','service.view_team'), ('ADMIN','service.assign_work'),
 ('SALES','customers.read'), ('SALES','customers.write'), ('SALES','tasks.read'), ('SALES','tasks.write'),
 ('SERVICE','customers.read'), ('SERVICE','customers.write'), ('SERVICE','tasks.read'), ('SERVICE','tasks.write');
alter table public.role_permissions enable row level security;
create policy role_permissions_read on public.role_permissions for select to authenticated using (true);
grant select on public.role_permissions to authenticated;

create or replace function public.is_org_member(target_org uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships where organisation_id = target_org and user_id = auth.uid() and status = 'active');
$$;
create or replace function public.can_access_site(target_org uuid, target_site uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships where organisation_id = target_org and user_id = auth.uid()
    and status = 'active' and (site_id is null or site_id = target_site));
$$;
create function public.has_permission(target_org uuid, target_site uuid, required_permission text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.memberships m where m.organisation_id = target_org
    and m.user_id = auth.uid() and m.status = 'active'
    and (m.site_id is null or m.site_id = target_site)
    and (required_permission = any(m.extra_permissions) or exists (
      select 1 from public.role_permissions p where p.role = m.role and p.permission = required_permission)));
$$;
revoke all on function public.has_permission(uuid, uuid, text) from public, anon;
grant execute on function public.has_permission(uuid, uuid, text) to authenticated;

create or replace function public.bootstrap_first_organisation(p_name text, p_site_name text, p_timezone text, p_user_id uuid)
returns table (organisation_id uuid, site_id uuid)
language plpgsql security definer set search_path = public, auth as $$
declare new_org uuid; new_site uuid;
begin
  if p_user_id is null or not exists (select 1 from auth.users where id = p_user_id and email_confirmed_at is not null) then
    raise exception 'A confirmed user is required'; end if;
  if p_name is null or p_site_name is null or length(trim(p_name)) not between 2 and 120
    or length(trim(p_site_name)) not between 2 and 120 then raise exception 'Invalid names'; end if;
  if not exists (select 1 from pg_timezone_names where name = p_timezone) then raise exception 'Invalid timezone'; end if;
  perform pg_advisory_xact_lock(781246031);
  if exists (select 1 from public.organisations) then raise exception 'Initial setup has already been completed'; end if;
  insert into public.organisations(name) values (trim(p_name)) returning id into new_org;
  insert into public.sites(organisation_id,name,timezone) values (new_org,trim(p_site_name),p_timezone) returning id into new_site;
  insert into public.memberships(organisation_id,user_id,role) values (new_org,p_user_id,'ADMIN');
  insert into public.audit_events(organisation_id,site_id,actor_user_id,action,entity_type,entity_id)
    values (new_org,new_site,p_user_id,'organisation.bootstrapped','organisation',new_org);
  return query select new_org,new_site;
end; $$;

drop policy memberships_read_self on public.memberships;
create policy memberships_read on public.memberships for select to authenticated
  using (user_id = auth.uid() or public.has_permission(organisation_id,null,'users.manage'));
drop policy customers_read_site on public.customers;
create policy customers_read_site on public.customers for select to authenticated
  using (public.has_permission(organisation_id,site_id,'customers.read'));
drop policy tasks_read_site on public.tasks;
create policy tasks_read_site on public.tasks for select to authenticated
  using (public.has_permission(organisation_id,site_id,'tasks.read')
    and (assigned_to = auth.uid() or public.has_permission(organisation_id,site_id,'tasks.view_team')));
drop policy audit_read_org_member on public.audit_events;
create policy audit_read_admin on public.audit_events for select to authenticated
  using (public.has_permission(organisation_id,site_id,'audit.read'));
-- Mutations use checked transactional functions; clients cannot forge audit rows.
revoke insert, update on public.customers, public.tasks from authenticated;
revoke insert on public.audit_events from authenticated;

create or replace function public.create_customer(p_site_id uuid,p_first_name text,p_last_name text,p_email text,p_phone text)
returns setof public.customers language plpgsql security definer set search_path = public as $$
declare target_org uuid; result public.customers;
begin
  select organisation_id into target_org from public.sites where id = p_site_id;
  if not public.has_permission(target_org,p_site_id,'customers.write') then raise insufficient_privilege; end if;
  insert into public.customers(organisation_id,site_id,created_by,assigned_to,first_name,last_name,email,phone)
    values(target_org,p_site_id,auth.uid(),auth.uid(),trim(p_first_name),trim(p_last_name),nullif(trim(p_email),''),nullif(trim(p_phone),'')) returning * into result;
  insert into public.audit_events(organisation_id,site_id,actor_user_id,action,entity_type,entity_id)
    values(target_org,p_site_id,auth.uid(),'customer.created','customer',result.id);
  return next result;
end; $$;
create or replace function public.create_followup(p_site_id uuid,p_customer_id uuid,p_title text,p_details text,p_due_at timestamptz,p_priority text default 'normal')
returns setof public.tasks language plpgsql security definer set search_path = public as $$
declare target_org uuid; result public.tasks;
begin
  select organisation_id into target_org from public.customers where id = p_customer_id and site_id = p_site_id;
  if not public.has_permission(target_org,p_site_id,'tasks.write') then raise insufficient_privilege; end if;
  insert into public.tasks(organisation_id,site_id,customer_id,created_by,assigned_to,title,details,due_at,priority)
    values(target_org,p_site_id,p_customer_id,auth.uid(),auth.uid(),trim(p_title),nullif(trim(p_details),''),p_due_at,p_priority) returning * into result;
  insert into public.audit_events(organisation_id,site_id,actor_user_id,action,entity_type,entity_id)
    values(target_org,p_site_id,auth.uid(),'task.created','task',result.id);
  return next result;
end; $$;
create or replace function public.complete_followup(p_task_id uuid,p_site_id uuid)
returns setof public.tasks language plpgsql security definer set search_path = public as $$
declare result public.tasks;
begin
  select * into result from public.tasks where id = p_task_id and site_id = p_site_id for update;
  if result.id is null or not public.has_permission(result.organisation_id,p_site_id,'tasks.write')
    or (result.assigned_to <> auth.uid() and not public.has_permission(result.organisation_id,p_site_id,'tasks.view_team')) then raise insufficient_privilege; end if;
  if result.completed_at is not null then raise exception 'Task already completed'; end if;
  update public.tasks set completed_at = now() where id = result.id returning * into result;
  insert into public.audit_events(organisation_id,site_id,actor_user_id,action,entity_type,entity_id)
    values(result.organisation_id,p_site_id,auth.uid(),'task.completed','task',result.id);
  return next result;
end; $$;

create table public.staff_invitations (
  id uuid primary key default gen_random_uuid(),
  organisation_id uuid not null references public.organisations(id),
  site_id uuid,
  email text not null check (email = lower(trim(email)) and length(email) between 3 and 254),
  roles text[] not null check (cardinality(roles) between 1 and 3 and roles <@ array['ADMIN','SALES','SERVICE']::text[]),
  status text not null default 'pending' check (status in ('pending','accepted','revoked')),
  delivery_status text not null default 'not_sent' check (delivery_status in ('not_sent','sent','failed')),
  invited_by uuid not null references auth.users(id),
  accepted_by uuid references auth.users(id),
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  foreign key (organisation_id,site_id) references public.sites(organisation_id,id),
  check (not ('ADMIN' = any(roles)) or site_id is null)
);
create unique index staff_invitations_pending_idx on public.staff_invitations(organisation_id,email) where status = 'pending';
alter table public.staff_invitations enable row level security;
create policy staff_invitations_admin_read on public.staff_invitations for select to authenticated
  using (public.has_permission(organisation_id,null,'users.manage'));
grant select on public.staff_invitations to authenticated;
grant select, update on public.staff_invitations to service_role;

create function public.create_staff_invitation(p_organisation_id uuid,p_site_id uuid,p_email text,p_roles text[])
returns setof public.staff_invitations language plpgsql security definer set search_path = public as $$
declare result public.staff_invitations;
begin
  if not public.has_permission(p_organisation_id,null,'users.manage') then raise insufficient_privilege; end if;
  insert into public.staff_invitations(organisation_id,site_id,email,roles,invited_by)
    values(p_organisation_id,p_site_id,lower(trim(p_email)),p_roles,auth.uid()) returning * into result;
  insert into public.audit_events(organisation_id,site_id,actor_user_id,action,entity_type,entity_id,metadata)
    values(p_organisation_id,p_site_id,auth.uid(),'staff.invited','invitation',result.id,jsonb_build_object('roles',p_roles));
  return next result;
end; $$;
create function public.revoke_staff_invitation(p_organisation_id uuid,p_invitation_id uuid)
returns setof public.staff_invitations language plpgsql security definer set search_path = public as $$
declare result public.staff_invitations;
begin
  if not public.has_permission(p_organisation_id,null,'users.manage') then raise insufficient_privilege; end if;
  update public.staff_invitations set status = 'revoked' where id = p_invitation_id and organisation_id = p_organisation_id and status = 'pending' returning * into result;
  if result.id is null then raise exception 'Invitation unavailable'; end if;
  insert into public.audit_events(organisation_id,site_id,actor_user_id,action,entity_type,entity_id)
    values(p_organisation_id,result.site_id,auth.uid(),'staff.invitation_revoked','invitation',result.id);
  return next result;
end; $$;
create function public.my_staff_invitations()
returns setof public.staff_invitations language sql stable security definer set search_path = public, auth as $$
  select i.* from public.staff_invitations i join auth.users u on u.id = auth.uid()
    and lower(u.email) = i.email and u.email_confirmed_at is not null
    where i.status = 'pending' and i.expires_at > now();
$$;
create function public.accept_staff_invitation(p_invitation_id uuid)
returns setof public.memberships language plpgsql security definer set search_path = public, auth as $$
declare invitation public.staff_invitations; requested_role text; result public.memberships;
begin
  select * into invitation from public.staff_invitations where id = p_invitation_id for update;
  if invitation.id is null or not exists (select 1 from auth.users where id = auth.uid()
    and lower(email) = invitation.email and email_confirmed_at is not null) then raise insufficient_privilege; end if;
  perform pg_advisory_xact_lock(hashtextextended(invitation.organisation_id::text,0));
  if invitation.status <> 'pending' or invitation.expires_at <= now() then raise exception 'Invitation unavailable'; end if;
  if exists (select 1 from public.memberships where organisation_id = invitation.organisation_id and user_id = auth.uid() and status = 'suspended') then
    raise exception 'An administrator must restore suspended access'; end if;
  foreach requested_role in array invitation.roles loop
    insert into public.memberships(organisation_id,site_id,user_id,role)
      values(invitation.organisation_id,invitation.site_id,auth.uid(),requested_role) on conflict do nothing;
    select * into result from public.memberships where organisation_id = invitation.organisation_id
      and site_id is not distinct from invitation.site_id and user_id = auth.uid() and role = requested_role;
    return next result;
  end loop;
  update public.staff_invitations set status = 'accepted',accepted_by = auth.uid(),accepted_at = now() where id = invitation.id;
  insert into public.audit_events(organisation_id,site_id,actor_user_id,action,entity_type,entity_id)
    values(invitation.organisation_id,invitation.site_id,auth.uid(),'staff.invitation_accepted','invitation',invitation.id);
end; $$;
create function public.update_membership_access(p_organisation_id uuid,p_membership_id uuid,p_role text,p_status text,p_extra_permissions text[])
returns setof public.memberships language plpgsql security definer set search_path = public as $$
declare previous public.memberships; result public.memberships;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_organisation_id::text,0));
  if not public.has_permission(p_organisation_id,null,'users.manage') then raise insufficient_privilege; end if;
  select * into previous from public.memberships where id = p_membership_id and organisation_id = p_organisation_id for update;
  if previous.id is null then raise exception 'Membership unavailable'; end if;
  if previous.role = 'ADMIN' and previous.status = 'active' and (coalesce(p_role,previous.role) <> 'ADMIN' or coalesce(p_status,previous.status) <> 'active')
    and not exists (select 1 from public.memberships where organisation_id = p_organisation_id and role = 'ADMIN' and status = 'active' and id <> previous.id) then
    raise exception 'Cannot remove the last active administrator'; end if;
  update public.memberships set role = coalesce(p_role,role),status = coalesce(p_status,status),extra_permissions = coalesce(p_extra_permissions,extra_permissions)
    where id = previous.id returning * into result;
  insert into public.audit_events(organisation_id,site_id,actor_user_id,action,entity_type,entity_id,metadata)
    values(p_organisation_id,result.site_id,auth.uid(),'staff.access_updated','membership',result.id,
      jsonb_build_object('before',to_jsonb(previous),'after',to_jsonb(result)));
  return next result;
end; $$;

revoke all on function public.create_staff_invitation(uuid,uuid,text,text[]) from public,anon;
revoke all on function public.revoke_staff_invitation(uuid,uuid) from public,anon;
revoke all on function public.my_staff_invitations() from public,anon;
revoke all on function public.accept_staff_invitation(uuid) from public,anon;
revoke all on function public.update_membership_access(uuid,uuid,text,text,text[]) from public,anon;
grant execute on function public.create_staff_invitation(uuid,uuid,text,text[]) to authenticated;
grant execute on function public.revoke_staff_invitation(uuid,uuid) to authenticated;
grant execute on function public.my_staff_invitations() to authenticated;
grant execute on function public.accept_staff_invitation(uuid) to authenticated;
grant execute on function public.update_membership_access(uuid,uuid,text,text,text[]) to authenticated;
commit;
