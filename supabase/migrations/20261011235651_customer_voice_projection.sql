-- CRM-owned prerequisite for E2 customer_voice_service. No customer release is seeded.
create function sms_private.customer_voice_ready(t text) returns boolean
language sql stable set search_path='' as $$
 select exists(select from sms_private.voice_agents a join sms_private.voice_configurations v
 on (v.tenant_id,v.agent_id,v.revision)=(a.tenant_id,a.id,a.published_revision)
 where a.tenant_id=t and nullif(btrim(a.phone),'') is not null)
$$;

-- Only the paired, authorized customer reader may call these private projections.
create function sms_private.customer_voice_agents(t text) returns jsonb
language sql stable set search_path='' as $$
 select coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',v.configuration->>'name','phone',a.phone) order by a.id),'[]')
 from sms_private.voice_agents a join sms_private.voice_configurations v
 on (v.tenant_id,v.agent_id,v.revision)=(a.tenant_id,a.id,a.published_revision)
 where a.tenant_id=t and nullif(btrim(a.phone),'') is not null
$$;

create function sms_private.customer_voice_call(c sms_private.voice_calls, detail boolean default false) returns jsonb
language sql stable set search_path='' as $$
 select jsonb_build_object('id',c.id,'businessId',c.tenant_id,'agentId',c.agent_id,
 'caller',c.phone,'startedAt',c.started_at,'endedAt',c.ended_at,'durationSeconds',c.duration_seconds,
 'status',c.status,'outcome',c.outcome,'summary',c.summary,'expiresAt',c.expires_at,
 'recordingState',case when c.expires_at<=now() or c.deleted_at is not null then 'expired'
 when c.media_state='ready' and c.media_path is null then 'failed' else c.media_state end)
 || case when detail then jsonb_build_object('transcript',case when c.expires_at>now() and c.deleted_at is null then
 (select coalesce(jsonb_agg(jsonb_build_object('role',x->>'role','text',x->>'text')),'[]')
 from jsonb_array_elements(case when jsonb_typeof(c.transcript)='array' then c.transcript else '[]' end) x) else null end) else '{}'::jsonb end
$$;

create function sms_private.customer_voice_calls(t text,p jsonb,tz text) returns jsonb
language sql stable set search_path='' as $$
 with filtered as materialized (
 select c.id,c.started_at from sms_private.voice_calls c where c.tenant_id=t
 and (coalesce(p->>'agent','')='' or c.agent_id=p->>'agent')
 and (coalesce(p->>'status','')='' or c.status=p->>'status')
 and (coalesce(p->>'q','')='' or strpos(lower(concat_ws(' ',c.phone,c.summary)),lower(p->>'q'))>0)
 and (nullif(p->>'from','') is null or c.started_at>=((p->>'from')::date::timestamp at time zone tz))
 and (nullif(p->>'to','') is null or c.started_at<(((p->>'to')::date+1)::timestamp at time zone tz))
 ) , selected as (select id,started_at from filtered order by started_at desc,id desc limit 25 offset (coalesce((p->>'page')::integer,1)-1)*25),
 page as (select c from selected f join sms_private.voice_calls c on c.tenant_id=t and c.id=f.id)
 select jsonb_build_object('businessId',t,'rows',(select coalesce(jsonb_agg(sms_private.customer_voice_call(c) order by (c).started_at desc,(c).id desc),'[]') from page),
 'total',(select count(*) from filtered),'page',coalesce((p->>'page')::integer,1),'pageSize',25)
$$;

create function sms_private.customer_voice_media(aid uuid,t text,cid uuid) returns jsonb
language plpgsql set search_path='' as $$
declare c sms_private.voice_calls; seconds integer;
begin
 select * into c from sms_private.voice_calls where tenant_id=t and id=cid;
 if c.id is null or c.media_state<>'ready' or c.media_path is null or c.deleted_at is not null then return null; end if;
 seconds:=least(300,floor(extract(epoch from c.expires_at-clock_timestamp())))::integer;
 if seconds<1 then return null; end if;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,aid::text,'customer_voice_recording_access',jsonb_build_object('callId',cid));
 return jsonb_build_object('path',c.media_path,'expiresIn',seconds,'expiresAt',c.expires_at);
end $$;
revoke all on function sms_private.customer_voice_ready(text),sms_private.customer_voice_agents(text),
 sms_private.customer_voice_call(sms_private.voice_calls,boolean),sms_private.customer_voice_calls(text,jsonb,text),
 sms_private.customer_voice_media(uuid,text,uuid) from public,anon,authenticated,service_role,sms_api;
