-- Local PostgreSQL fixture emulating Supabase's auth context. Never run on production.
create role anon;
create role authenticated;
create role service_role bypassrls;
create schema auth;
create table auth.users(id uuid primary key, email text, email_confirmed_at timestamptz);
create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
grant usage on schema public,auth to authenticated,anon,service_role;
grant execute on function auth.uid() to authenticated,anon,service_role;
\ir ../supabase/migrations/0001_standalone_crm.sql
\ir ../supabase/migrations/0002_three_role_access.sql

insert into auth.users values
 ('00000000-0000-0000-0000-000000000001','admin@example.test',now()),
 ('00000000-0000-0000-0000-000000000002','sales@example.test',now()),
 ('00000000-0000-0000-0000-000000000003','service@example.test',now()),
 ('00000000-0000-0000-0000-000000000004','outsider@example.test',now());
select * from public.bootstrap_first_organisation('Pilot','Site A','Australia/Sydney','00000000-0000-0000-0000-000000000001');
insert into public.sites(organisation_id,name) select id,'Site B' from public.organisations;
insert into public.memberships(organisation_id,site_id,user_id,role)
 select organisation_id,id,'00000000-0000-0000-0000-000000000002','SALES' from public.sites where name = 'Site A';
insert into public.memberships(organisation_id,site_id,user_id,role)
 select organisation_id,id,'00000000-0000-0000-0000-000000000003','SERVICE' from public.sites where name = 'Site A';
insert into public.organisations(name) values('Other dealer');
insert into public.sites(organisation_id,name) select id,'Other site' from public.organisations where name = 'Other dealer';

set role authenticated;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
do $$ declare s public.sites; c public.customers; begin
 if (select count(*) from public.sites) <> 1 then raise exception 'Site scope failed'; end if;
 if (select count(*) from public.organisations) <> 1 then raise exception 'Dealer isolation failed'; end if;
 select * into s from public.sites;
 if public.has_permission(s.organisation_id,null,'users.manage') then raise exception 'Sales privilege escalation'; end if;
 select * into c from public.create_customer(s.id,'Test','Customer','test@example.test','');
 perform public.create_followup(s.id,c.id,'Call customer','',now(),'normal');
 begin perform public.create_staff_invitation(s.organisation_id,s.id,'outsider@example.test',array['ADMIN']);
   raise exception 'Sales invited an admin'; exception when insufficient_privilege then null; end;
 begin insert into public.audit_events(organisation_id,actor_user_id,action,entity_type) values(s.organisation_id,auth.uid(),'forged','membership');
   raise exception 'Audit forgery allowed'; exception when insufficient_privilege then null; end;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false);
do $$ declare s public.sites; begin
 select * into s from public.sites;
 if (select count(*) from public.tasks) <> 0 then raise exception 'Other staff tasks exposed'; end if;
 if (select count(*) from public.customers) <> 1 then raise exception 'Shared customer visibility failed'; end if;
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000001',false);
do $$ declare s public.sites; m public.memberships; i public.staff_invitations; begin
 select * into s from public.sites where name = 'Site A';
 select * into m from public.memberships where user_id = auth.uid();
 begin perform public.update_membership_access(s.organisation_id,m.id,null,'suspended',null);
   raise exception 'Last admin removed'; exception when raise_exception then
     if sqlerrm <> 'Cannot remove the last active administrator' then raise; end if; end;
 select * into m from public.memberships where user_id = '00000000-0000-0000-0000-000000000002';
 perform public.update_membership_access(s.organisation_id,m.id,null,'suspended',null);
 perform public.create_staff_invitation(s.organisation_id,s.id,'outsider@example.test',array['SALES','SERVICE']);
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000002',false);
do $$ begin
 if exists(select 1 from public.sites) or exists(select 1 from public.customers) or exists(select 1 from public.tasks) then raise exception 'Suspension failed'; end if;
end $$;

select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000003',false);
do $$ begin
 if exists(select 1 from public.my_staff_invitations()) then raise exception 'Wrong email can discover invitations'; end if;
end $$;
select set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',false);
do $$ declare i public.staff_invitations; begin
 select * into i from public.my_staff_invitations();
 if i.id is null then raise exception 'Intended recipient cannot discover invitation'; end if;
 perform public.accept_staff_invitation(i.id);
 if (select count(*) from public.memberships where user_id = auth.uid()) <> 2 then raise exception 'Multi-role invitation failed'; end if;
 begin perform public.accept_staff_invitation(i.id); raise exception 'Replay allowed'; exception when raise_exception then
   if sqlerrm <> 'Invitation unavailable' then raise; end if; end;
end $$;
reset role;
do $$ begin
 if not exists(select 1 from public.audit_events where action = 'staff.access_updated') then raise exception 'Access audit missing'; end if;
end $$;
select 'Database access tests passed' as result;
