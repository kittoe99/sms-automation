-- CRM-owned. Apply after staff_voice_overview and the paired E2 customer Voice release.
-- A CRM draft is deliberately not a cloud deployment, phone connection or customer release.
alter table sms_private.voice_agents alter column deployment_id drop not null;
alter table sms_private.voice_agents alter column agent_name drop not null;
alter table sms_private.voice_agents alter column phone drop not null;

create function sms_private.voice_setup(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid:=sms_private.platform_actor(u); result jsonb;
begin
 if not sms_private.platform_staff(aid) then raise exception 'Staff access required' using errcode='42501'; end if;
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Business not found'; end if;
 result:=sms_private.voice_workspace(u,t,'overview','{}');
 return jsonb_build_object('business',result->'business','agents',result->'agents','service',result->'customerService',
  'ownerReady',sms_private.login_account(sms_private.platform_owner(t),'customer'),
  'ready',sms_private.customer_voice_ready(t),
  'deployments',coalesce((select jsonb_agg(jsonb_build_object('id',a.id,'deploymentId',a.deployment_id,
   'name',coalesce(v.configuration->>'name',a.agent_name,a.id),'phone',a.phone,
   'businessId',a.tenant_id,'businessName',b.name,'attached',a.tenant_id=t,
   'published',a.published_revision is not null) order by b.name,a.id)
   from sms_private.voice_agents a join public.sms_businesses b on b.tenant_id=a.tenant_id
   left join sms_private.voice_configurations v on (v.tenant_id,v.agent_id,v.revision)=(a.tenant_id,a.id,a.published_revision)
   where a.deployment_id is not null),'[]'));
end $$;
revoke all on function sms_private.voice_setup(text,text) from public,anon,authenticated,service_role;
grant execute on function sms_private.voice_setup(text,text) to sms_api;

alter function sms_private.voice_workspace(text,text,text,jsonb) rename to voice_workspace_before_creation;
create function sms_private.voice_workspace(u text,t text,action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare agent_id text; inserted integer;
begin
 perform sms_private.require_admin(u);
 if not sms_private.can_access(t,u) then raise exception 'Business access denied' using errcode='42501'; end if;
 if action='create' then
  perform sms_private.validate_voice_configuration(p->'configuration');
  if p->>'requestId' is null then raise exception 'Creation request ID required'; end if;
  agent_id:='agent-'||(p->>'requestId')::uuid::text;
  insert into sms_private.voice_agents(tenant_id,id,draft) values(t,agent_id,p->'configuration') on conflict(tenant_id,id) do nothing;
  get diagnostics inserted=row_count;
  if inserted=1 then
   insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'voice_agent_created',jsonb_build_object('agentId',agent_id));
  end if;
  return jsonb_build_object('agentId',agent_id,'state','draft');
 elsif action in ('publish','rollback') then
  perform 1 from sms_private.voice_agents a where a.tenant_id=t and a.id=p->>'agentId' and a.deployment_id is not null and nullif(a.phone,'') is not null;
  if not found then raise exception 'Connect a verified deployment and business phone before publishing. Your draft is saved.'; end if;
 end if;
 return sms_private.voice_workspace_before_creation(u,t,action,p);
end $$;
revoke all on function sms_private.voice_workspace(text,text,text,jsonb),sms_private.voice_workspace_before_creation(text,text,text,jsonb) from public,anon,authenticated,service_role,sms_api;
grant execute on function sms_private.voice_workspace(text,text,text,jsonb) to sms_api;
