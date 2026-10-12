-- CRM-owned forward change. Customer release remains owned by E2 Local.
-- Existing paired customer_voice_projection/customer_voice_service releases precede this.
alter function sms_private.voice_workspace(text,text,text,jsonb) rename to voice_workspace_before_staff_overview;
create function sms_private.voice_workspace(u text,t text,action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; facts jsonb; service jsonb; tz text; c sms_private.voice_calls;
 pg integer:=greatest(1,least(coalesce((p->>'page')::integer,1),100000)); total integer;
begin
 perform sms_private.require_admin(u);
 if not sms_private.can_access(t,u) then raise exception 'Business access denied' using errcode='42501'; end if;
 select time_zone into tz from public.sms_businesses where tenant_id=t;
 tz:=coalesce(tz,'UTC');
 if action='overview' then
  result:=sms_private.voice_workspace_before_staff_overview(u,t,action,p);
  -- Standalone CRM bootstrap can precede E2's setup tables; never substitute draft facts.
  if to_regclass('public.platform_business_setup') is not null then
   select v.facts into facts from public.platform_business_setup s
    join public.sms_business_profile_versions v on v.tenant_id=s.tenant_id and v.id=s.reviewed_profile_id where s.tenant_id=t;
   select jsonb_build_object('id',s.id,'visibility',s.visibility,'revision',s.revision) into service
    from public.platform_business_services s where s.tenant_id=t and s.kind='voice';
  end if;
  return result||jsonb_build_object('business',jsonb_build_object('id',t,'name',facts->>'businessName',
   'description',facts->>'summary','contactEmail',facts->>'contactEmail','contactPhone',facts->>'contactPhone',
   'services',coalesce(facts->'services','[]'),'serviceAreas',coalesce(facts->'locations','[]'),
   'timeZone',tz,'reviewed',facts is not null),'customerService',service);
 elsif action='calls' then
  if coalesce(p->>'status','') not in ('','active','completed','failed','interrupted') or length(coalesce(p->>'q',''))>100
   then raise exception 'Invalid call filters'; end if;
  with matching as materialized (
   select x.id,x.started_at from sms_private.voice_calls x where x.tenant_id=t
    and (coalesce(p->>'agent','')='' or x.agent_id=p->>'agent')
    and (coalesce(p->>'phone','')='' or x.phone=p->>'phone')
    and (coalesce(p->>'q','')='' or concat_ws(' ',x.phone,x.summary,x.outcome) ilike '%'||(p->>'q')||'%')
    and (coalesce(p->>'status','')='' or x.status=p->>'status')
    and (coalesce(p->>'from','')='' or x.started_at>=((p->>'from')::date::timestamp at time zone tz))
    and (coalesce(p->>'to','')='' or x.started_at<(((p->>'to')::date+1)::timestamp at time zone tz))
  ), page as (select * from matching order by started_at desc,id limit 25 offset (pg-1)*25)
  select (select count(*) from matching),coalesce(jsonb_agg((to_jsonb(x)-'transcript'-'media_path'-'request')||
   jsonb_build_object('media_state',case when x.expires_at<=now() or x.deleted_at is not null then 'expired' else x.media_state end)
   order by x.started_at desc,x.id),'[]') into total,result
   from page join sms_private.voice_calls x on x.tenant_id=t and x.id=page.id;
  return jsonb_build_object('calls',result,'total',total,'page',pg,'totalPages',greatest(1,ceil(total/25.0)),'timeZone',tz);
 elsif action='media' then
  select * into strict c from sms_private.voice_calls where tenant_id=t and id=(p->>'id')::uuid;
  if c.media_state<>'ready' or c.deleted_at is not null or nullif(c.media_path,'') is null or c.expires_at<=now()+interval '1 second'
   then raise exception 'Recording is unavailable or expired'; end if;
  insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'voice_recording_access',jsonb_build_object('callId',c.id));
  return jsonb_build_object('path',c.media_path,'expiresIn',least(300,floor(extract(epoch from c.expires_at-now()))::integer));
 elsif action='call' then
  result:=sms_private.voice_workspace_before_staff_overview(u,t,action,p);
  if result->'call'->>'deleted_at' is not null then
   result:=jsonb_set(result,'{call,media_state}','"expired"');
   result:=jsonb_set(result,'{call,transcript}','null');
  end if;
  return result;
 end if;
 return sms_private.voice_workspace_before_staff_overview(u,t,action,p);
end $$;
revoke all on function sms_private.voice_workspace(text,text,text,jsonb),sms_private.voice_workspace_before_staff_overview(text,text,text,jsonb) from public,anon,authenticated,service_role,sms_api;
grant execute on function sms_private.voice_workspace(text,text,text,jsonb) to sms_api;
