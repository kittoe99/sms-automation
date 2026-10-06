-- CRM-owned; requires 20261006053509 and the paired account/service migrations.
-- No schedules or agent prompts are seeded. Initialize from the deployed snapshot.
create table sms_private.voice_agents (
 tenant_id text not null references public.sms_businesses, id text not null,
 deployment_id text not null, agent_name text not null, phone text not null,
 draft jsonb not null, draft_version integer not null default 1,
 published_revision uuid, observed_revision uuid, observed_at timestamptz,
 primary key(tenant_id,id), unique(tenant_id,deployment_id)
);
create table sms_private.voice_configurations (
 tenant_id text not null, agent_id text not null, revision uuid not null default gen_random_uuid(),
 configuration jsonb not null, created_by text not null, created_at timestamptz not null default now(),
 primary key(tenant_id,agent_id,revision),
 foreign key(tenant_id,agent_id) references sms_private.voice_agents(tenant_id,id)
);
create table sms_private.voice_calls (
 tenant_id text not null, id uuid not null default gen_random_uuid(), agent_id text not null,
 job_id text not null, room_id text not null, sip_call_id text, phone text,
 configuration_revision uuid, configuration_source text not null default 'crm',
 status text not null default 'active' check(status in ('active','completed','failed','interrupted')),
 started_at timestamptz not null default now(), ended_at timestamptz, seen_at timestamptz not null default now(),
 duration_seconds integer, summary text not null default '', outcome text not null default 'unknown',
 request jsonb not null default '{}', lead_id uuid,
 transcript jsonb, media_state text not null default 'pending'
 check(media_state in ('pending','uploading','ready','failed','expired')),
 media_path text, media_bytes bigint, expires_at timestamptz not null default now()+interval '90 days',
 deleted_at timestamptz,
 primary key(tenant_id,id), unique(tenant_id,job_id),
 foreign key(tenant_id,agent_id) references sms_private.voice_agents(tenant_id,id),
 foreign key(tenant_id,lead_id) references public.sms_leads(tenant_id,id),
 check(phone is null or phone ~ '^\+[1-9][0-9]{7,14}$')
);
create index voice_calls_recent on sms_private.voice_calls(tenant_id,started_at desc,id);
create index voice_calls_phone on sms_private.voice_calls(tenant_id,phone,started_at desc);
create index voice_calls_lead on sms_private.voice_calls(tenant_id,lead_id) where lead_id is not null;
create index voice_calls_expiry on sms_private.voice_calls(expires_at) where deleted_at is null;
alter table sms_private.voice_agents enable row level security;
alter table sms_private.voice_configurations enable row level security;
alter table sms_private.voice_calls enable row level security;
revoke all on sms_private.voice_agents,sms_private.voice_configurations,sms_private.voice_calls from public,anon,authenticated,service_role;

alter table public.sms_bookings add column voice_agent_id text, add column voice_call_id uuid,
 add column voice_configuration_revision uuid;
alter table public.sms_bookings add foreign key(tenant_id,voice_call_id) references sms_private.voice_calls(tenant_id,id),
 add foreign key(tenant_id,voice_agent_id) references sms_private.voice_agents(tenant_id,id);
create index bookings_voice_call on public.sms_bookings(tenant_id,voice_call_id) where voice_call_id is not null;

create function sms_private.validate_voice_configuration(p jsonb) returns void
language plpgsql immutable set search_path='' as $$
begin
 if jsonb_typeof(p) is distinct from 'object' or exists(select from jsonb_object_keys(p) k where k not in ('name','persona','voice','brain','voiceName'))
 or jsonb_typeof(p->'name') is distinct from 'string' or length(btrim(p->>'name')) not between 1 and 100
 or jsonb_typeof(p->'persona') is distinct from 'string' or length(p->>'persona')>4000
 or jsonb_typeof(p->'voice') is distinct from 'string' or length(btrim(p->>'voice')) not between 1 and 16000
 or jsonb_typeof(p->'brain') is distinct from 'string' or length(btrim(p->>'brain')) not between 1 and 24000
 or coalesce(p->>'voiceName','') not in ('marin','quartz','ripple','vesper','willow','stone','gleam','meridian','bossa','tempo','beacon','delta','cinder')
 then raise exception 'Configuration: provide name, persona, both prompts and a supported voice'; end if;
end $$;

create function sms_private.voice_workspace(u text,t text,action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare a sms_private.voice_agents; c sms_private.voice_calls; rev uuid; cfg jsonb; result jsonb;
 pg integer:=greatest(1,least(coalesce((p->>'page')::integer,1),100000)); total integer;
begin
 perform sms_private.require_admin(u);
 if not sms_private.can_access(t,u) then raise exception 'Business access denied' using errcode='42501'; end if;
 if action='initialize' then
  perform sms_private.voice_read_scope(t);
  perform sms_private.validate_voice_configuration(p->'configuration');
  insert into sms_private.voice_agents(tenant_id,id,deployment_id,agent_name,phone,draft)
   values(t,'opek-phone','CA_H8mbfRdWKWJV','voice-agent-phone','+18777574365',p->'configuration');
  insert into sms_private.voice_configurations(tenant_id,agent_id,configuration,created_by)
   values(t,'opek-phone',p->'configuration',u) returning revision into rev;
  update sms_private.voice_agents set published_revision=rev where tenant_id=t and id='opek-phone';
 elsif action in ('save','publish','rollback') then
  select * into strict a from sms_private.voice_agents where tenant_id=t and id=p->>'agentId' for update;
  if (p->>'version')::integer is distinct from a.draft_version then raise exception 'Configuration changed. Reload before saving or publishing' using errcode='23505'; end if;
  if action='save' then
   perform sms_private.validate_voice_configuration(p->'configuration');
   update sms_private.voice_agents set draft=p->'configuration',draft_version=draft_version+1 where tenant_id=t and id=a.id;
  else
   cfg:=a.draft;
   if action='rollback' then
    select configuration into strict cfg from sms_private.voice_configurations where tenant_id=t and agent_id=a.id and revision=(p->>'revision')::uuid;
   end if;
   perform sms_private.validate_voice_configuration(cfg);
   insert into sms_private.voice_configurations(tenant_id,agent_id,configuration,created_by) values(t,a.id,cfg,u) returning revision into rev;
   update sms_private.voice_agents set published_revision=rev,draft_version=draft_version+1 where tenant_id=t and id=a.id;
  end if;
  insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'voice_configuration_'||action,jsonb_build_object('agentId',a.id,'revision',rev));
 elsif action='calls' then
  select count(*) into total from sms_private.voice_calls x where x.tenant_id=t
   and (coalesce(p->>'phone','')='' or x.phone=p->>'phone')
   and (coalesce(p->>'q','')='' or concat_ws(' ',x.phone,x.summary,x.outcome) ilike '%'||left(p->>'q',100)||'%')
   and (coalesce(p->>'status','')='' or x.status=p->>'status')
   and (coalesce(p->>'from','')='' or x.started_at>=(p->>'from')::date)
   and (coalesce(p->>'to','')='' or x.started_at<(p->>'to')::date+interval '1 day');
  select coalesce(jsonb_agg(to_jsonb(x)-'transcript'-'media_path'-'request'),'[]') into result from (
   select * from sms_private.voice_calls x where x.tenant_id=t
   and (coalesce(p->>'phone','')='' or x.phone=p->>'phone')
   and (coalesce(p->>'q','')='' or concat_ws(' ',x.phone,x.summary,x.outcome) ilike '%'||left(p->>'q',100)||'%')
   and (coalesce(p->>'status','')='' or x.status=p->>'status')
   and (coalesce(p->>'from','')='' or x.started_at>=(p->>'from')::date)
   and (coalesce(p->>'to','')='' or x.started_at<(p->>'to')::date+interval '1 day')
   order by x.started_at desc,x.id limit 25 offset (pg-1)*25) x;
  return jsonb_build_object('calls',result,'total',total,'page',pg,'totalPages',greatest(1,ceil(total/25.0)));
 elsif action in ('call','media') then
  select * into strict c from sms_private.voice_calls where tenant_id=t and id=(p->>'id')::uuid;
  if action='media' then
   if c.media_state<>'ready' or c.expires_at<=now() then raise exception 'Recording is unavailable or expired'; end if;
   insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'voice_recording_access',jsonb_build_object('callId',c.id));
   return jsonb_build_object('path',c.media_path,'expiresIn',300);
  end if;
  return jsonb_build_object('call', (to_jsonb(c)-'media_path')||jsonb_build_object('media_state',case when c.expires_at<=now() then 'expired' else c.media_state end,'transcript',case when c.expires_at>now() then c.transcript else null end),
   'bookings',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'status',b.status,'appointment_at',b.appointment_at)) from public.sms_bookings b where b.tenant_id=t and b.voice_call_id=c.id),'[]'));
 elsif action='leads' then
  select count(*) into total from public.sms_leads l where l.tenant_id=t and exists(select from sms_private.voice_calls x where x.tenant_id=t and x.lead_id=l.id);
  select coalesce(jsonb_agg(to_jsonb(x)),'[]') into result from (
   select l.*,c.phone,c.name,(select jsonb_agg(jsonb_build_object('id',v.id,'agentId',v.agent_id,'startedAt',v.started_at) order by v.started_at desc)
    from sms_private.voice_calls v where v.tenant_id=t and v.lead_id=l.id) calls
   from public.sms_leads l join public.sms_contacts c on c.tenant_id=l.tenant_id and c.id=l.contact_id
   where l.tenant_id=t and exists(select from sms_private.voice_calls v where v.tenant_id=t and v.lead_id=l.id)
   order by l.updated_at desc,l.id limit 25 offset (pg-1)*25) x;
  return jsonb_build_object('leads',result,'total',total,'page',pg,'totalPages',greatest(1,ceil(total/25.0)));
 elsif action<>'overview' then raise exception 'Unsupported voice workspace action'; end if;
 return jsonb_build_object('agents',coalesce((select jsonb_agg(to_jsonb(v)||jsonb_build_object(
  'published',(select configuration from sms_private.voice_configurations r where r.tenant_id=t and r.agent_id=v.id and r.revision=v.published_revision),
  'history',coalesce((select jsonb_agg(to_jsonb(h)) from (select revision,created_at,created_by,configuration->>'name' as name from sms_private.voice_configurations r where r.tenant_id=t and r.agent_id=v.id order by created_at desc limit 30) h),'[]')))
  from sms_private.voice_agents v where v.tenant_id=t),'[]'),
  'totals',jsonb_build_object('calls',(select count(*) from sms_private.voice_calls where tenant_id=t),
   'leads',(select count(distinct lead_id) from sms_private.voice_calls where tenant_id=t),
   'bookings',(select count(*) from public.sms_bookings where tenant_id=t and voice_call_id is not null and status='confirmed')));
end $$;

-- An unconfigured schedule makes no requests. Bootstrap stores only a Vault reference.
create table sms_private.voice_maintenance_settings (
 singleton boolean primary key default true check(singleton), secret_id uuid not null
);
alter table sms_private.voice_maintenance_settings enable row level security;
revoke all on sms_private.voice_maintenance_settings from public,anon,authenticated,service_role;
create function sms_private.voice_maintenance_tick() returns void
language plpgsql security definer set search_path='' as $$
declare sec text;
begin
 select v.decrypted_secret into sec from sms_private.voice_maintenance_settings s join vault.decrypted_secrets v on v.id=s.secret_id;
 if sec is null then return; end if;
 perform net.http_post(url:='https://wxamwhfmelxqahkdtcci.supabase.co/functions/v1/voice-maintenance',
  headers:=jsonb_build_object('Authorization','Bearer '||sec,'Content-Type','application/json'),body:='{}'::jsonb);
end $$;
revoke all on function sms_private.voice_maintenance_tick() from public,anon,authenticated,service_role;
select cron.schedule('voice-crm-maintenance','*/5 * * * *','select sms_private.voice_maintenance_tick()');

create schema voice_runtime_api;
revoke all on schema voice_runtime_api from public;
create role sms_voice_runtime nologin nosuperuser nobypassrls;
grant usage on schema voice_runtime_api to sms_voice_runtime;
create function voice_runtime_api.dispatch(t text,cid text,action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare a sms_private.voice_agents; c sms_private.voice_calls; cfg jsonb; v_contact_id uuid; lid uuid; ph text; k text;
begin
 perform sms_private.voice_read_scope(t);
 if length(cid) not between 8 and 160 or cid is null then raise exception 'Invalid call identity'; end if;
 select * into strict a from sms_private.voice_agents where tenant_id=t and id='opek-phone';
 if action='configuration' then
  select configuration into strict cfg from sms_private.voice_configurations where tenant_id=t and agent_id=a.id and revision=a.published_revision;
  return jsonb_build_object('configuration',cfg,'revision',a.published_revision,'agentId',a.id);
 end if;
 if action='start' then
  if coalesce(p->>'room','') not like 'phone-%' or length(p->>'room')>200 then raise exception 'Production phone room required'; end if;
  if coalesce(p->>'source','') not in ('crm','cached','fallback') then raise exception 'Invalid configuration source'; end if;
  if p->>'source'<>'fallback' and not exists(select from sms_private.voice_configurations where tenant_id=t and agent_id=a.id and revision=(p->>'revision')::uuid) then raise exception 'Unknown configuration revision'; end if;
  ph:=nullif(p->>'phone','');if ph is not null and ph !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Invalid phone'; end if;
  insert into sms_private.voice_calls(tenant_id,agent_id,job_id,room_id,sip_call_id,phone,configuration_revision,configuration_source)
   values(t,a.id,cid,p->>'room',left(p->>'sipCallId',160),ph,case when p->>'source'<>'fallback' then (p->>'revision')::uuid end,p->>'source')
   on conflict(tenant_id,job_id) do nothing;
  select * into strict c from sms_private.voice_calls where tenant_id=t and job_id=cid;
  if c.room_id<>p->>'room' then raise exception 'Call identity conflict'; end if;
  update sms_private.voice_agents set observed_revision=c.configuration_revision,observed_at=now() where tenant_id=t and id=a.id;
  return jsonb_build_object('callId',c.id);
 end if;
 select * into strict c from sms_private.voice_calls where tenant_id=t and job_id=cid for update;
 if action='heartbeat' then
  update sms_private.voice_calls set seen_at=now() where tenant_id=t and id=c.id and status='active';
 elsif action='finish' then
  if coalesce(p->>'status','') not in ('completed','failed') then raise exception 'Invalid completion status'; end if;
  if jsonb_typeof(p->'transcript') is distinct from 'array' or octet_length((p->'transcript')::text)>500000 then raise exception 'Invalid transcript'; end if;
  if exists(select from jsonb_array_elements(p->'transcript') item where jsonb_typeof(item) is distinct from 'object' or coalesce(item->>'role','') not in ('user','assistant') or jsonb_typeof(item->'text') is distinct from 'string' or length(item->>'text')>16000) then raise exception 'Invalid transcript turn'; end if;
  if coalesce((p->>'duration')::integer,-1) not between 0 and 86400 then raise exception 'Invalid duration'; end if;
  update sms_private.voice_calls set status=case when status in ('completed','failed') then status else p->>'status' end,
   ended_at=coalesce(ended_at,now()),seen_at=now(),duration_seconds=coalesce(duration_seconds,(p->>'duration')::integer),
   transcript=case when expires_at>now() then p->'transcript' else null end,
   media_state=case when p->>'audio'='false' and media_state='pending' then 'failed' else media_state end
   where tenant_id=t and id=c.id;
 elsif action='outcome' then
  if coalesce(p->>'outcome','') not in ('general_inquiry','wrong_number','service_request','quote_request','booking_inquiry','callback_request')
   or length(coalesce(p->>'summary','')) not between 1 and 2000 then raise exception 'Invalid call outcome'; end if;
  if c.status<>'active' then raise exception 'Call has ended'; end if;
  ph:=nullif(p->>'phone','');if ph is not null and ph !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Invalid callback number'; end if;
  if exists(select from jsonb_each_text(p) where length(value)>4000) then raise exception 'Lead detail too long'; end if;
  lid:=c.lead_id;
  if p->>'outcome' in ('service_request','quote_request','booking_inquiry','callback_request') and coalesce(ph,c.phone) is not null then
   ph:=coalesce(ph,c.phone);
   insert into public.sms_contacts(tenant_id,phone,name,source) values(t,ph,left(coalesce(p->>'name',''),200),'voice') on conflict(tenant_id,phone) do nothing;
   select id into strict v_contact_id from public.sms_contacts where tenant_id=t and phone=ph;
   perform pg_advisory_xact_lock(hashtextextended(t||':voice-lead:'||v_contact_id::text,992));
   if lid is null then
    select l.id into lid from public.sms_leads l where l.tenant_id=t and l.contact_id=v_contact_id and l.status in ('open','assigned');
    if lid is null then
     insert into public.sms_leads(tenant_id,contact_id,summary,fields) values(t,v_contact_id,p->>'summary',jsonb_build_object('source','voice','service',p->>'service','location',p->>'location','request',p->>'request','phoneVerified',false)) returning id into lid;
    end if;
   end if;
  end if;
  update sms_private.voice_calls set outcome=p->>'outcome',summary=p->>'summary',request=p,lead_id=lid where tenant_id=t and id=c.id;
 elsif action='upload' then
  if c.expires_at<=now() or c.media_state='expired' then raise exception 'Recording expired'; end if;
  if coalesce((p->>'bytes')::bigint,0) not between 1 and 52428800 then raise exception 'Recording must be 50 MB or smaller'; end if;
  if c.media_state='ready' then return jsonb_build_object('ready',true,'path',c.media_path); end if;
  k:=t||'/'||c.id::text||'/audio.ogg';
  update sms_private.voice_calls set media_state='uploading',media_path=k,media_bytes=(p->>'bytes')::bigint where tenant_id=t and id=c.id;
  return jsonb_build_object('path',k,'bytes',(p->>'bytes')::bigint);
 elsif action='uploaded' then
  if c.expires_at<=now() or c.media_state not in ('uploading','ready') then raise exception 'No pending recording'; end if;
  -- Only the trusted Edge handler calls this after checking object size/type.
  update sms_private.voice_calls set media_state='ready' where tenant_id=t and id=c.id;
 else raise exception 'Unsupported runtime action'; end if;
 return jsonb_build_object('callId',c.id,'leadId',lid,'saved',true);
end $$;

-- Confirmation and attribution share the original booking transaction and locks.
create or replace function voice_booking_api.confirm(t text,cid text,hid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result jsonb; c sms_private.voice_calls;
begin
 result:=sms_private.booking_confirm_new(t,cid,hid);
 select * into c from sms_private.voice_calls where tenant_id=t and job_id=cid;
 if c.id is not null then
  update public.sms_bookings set voice_agent_id=c.agent_id,voice_call_id=c.id,voice_configuration_revision=c.configuration_revision
   where tenant_id=t and id=result->>'bookingId' and voice_call_id is null;
 end if;
 return result;
end $$;

create function sms_private.voice_cleanup(p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
begin
 update sms_private.voice_calls set status='interrupted',ended_at=coalesce(ended_at,seen_at),media_state=case when media_state in ('pending','uploading') then 'failed' else media_state end
  where status='active' and seen_at<now()-interval '10 minutes';
 update sms_private.voice_calls set media_state='failed' where status<>'active' and media_state in ('pending','uploading') and seen_at<now()-interval '10 minutes';
 update sms_private.voice_calls set transcript=null,media_state='expired' where expires_at<=now() and media_state<>'expired';
 if p ? 'deleted' then
  update sms_private.voice_calls set deleted_at=now() where expires_at<=now() and media_path in(select jsonb_array_elements_text(p->'deleted'));
 end if;
 return jsonb_build_object('paths',coalesce((select jsonb_agg(media_path) from (select media_path from sms_private.voice_calls where expires_at<=now() and deleted_at is null and media_path is not null limit 100) x),'[]'));
end $$;
create role sms_voice_maintenance nologin nosuperuser nobypassrls;
create schema voice_maintenance_api;
revoke all on schema voice_maintenance_api from public;
grant usage on schema voice_maintenance_api to sms_voice_maintenance;
create function voice_maintenance_api.cleanup(p jsonb) returns jsonb language sql security definer set search_path='' as $$ select sms_private.voice_cleanup(p); $$;
revoke all on all functions in schema voice_runtime_api from public,anon,authenticated,service_role;
revoke all on all functions in schema voice_maintenance_api from public,anon,authenticated,service_role;
grant execute on function voice_runtime_api.dispatch(text,text,text,jsonb) to sms_voice_runtime;
grant execute on function voice_maintenance_api.cleanup(jsonb) to sms_voice_maintenance;
revoke all on function sms_private.validate_voice_configuration(jsonb),sms_private.voice_workspace(text,text,text,jsonb),sms_private.voice_cleanup(jsonb) from public,anon,authenticated,service_role;
grant execute on function sms_private.voice_workspace(text,text,text,jsonb) to sms_api;

-- Storage is managed through its API. The test harness has no Storage schema.
do $$ begin
 if to_regclass('storage.buckets') is not null then
  insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
   values('voice-recordings','voice-recordings',false,52428800,array['audio/ogg']) on conflict(id) do nothing;
 end if;
end $$;
