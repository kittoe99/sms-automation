-- CRM-owned forward migration. Requires CRM 20261120200000_gpt_live_voices.sql.
-- Lets one voice deployment answer for more than one business.
--
-- * A call's business comes from the number that was dialed. The worker sends that
--   number ("dialed", set by the operator's LiveKit dispatch rule, never by the caller)
--   with the runtime "configuration" and "start" actions; the business is the one whose
--   voice agent owns that number. Calls without a dialed number stay on Opek and its
--   'opek-phone' agent exactly as before.
-- * Every later voice action (booking, lookup, SMS) resolves the business from the call
--   record created at "start", so the Edge functions' fixed Opek tenant is only a
--   fallback for calls that have no record.
-- * voice_read_scope keeps Opek's rule and also admits a business whose voice agent is
--   bound to a deployment and a business phone.
-- * Adds the plumbing_service booking service (fixed arrival windows, no pricing).
-- * The $69 late change fee is Opek policy and now applies to Opek bookings only.

create or replace function sms_private.voice_call_tenant(t text, cid text) returns text
language sql stable security definer set search_path='' as $$
 select coalesce((select c.tenant_id from sms_private.voice_calls c where c.job_id=cid
   order by c.started_at desc limit 1), t)
$$;
revoke all on function sms_private.voice_call_tenant(text,text) from public;

create or replace function sms_private.voice_read_scope(t text) returns void
language plpgsql stable security definer set search_path='' as $$
begin
  -- Opek: the registered owner of +18777574365.
  if t='biz-1c0c09ce-819e-4795-86b9-0e457ab92f58'
    and exists(select from public.sms_businesses where tenant_id=t)
    and exists(select from sms_private.providers where tenant_id=t and from_number='+18777574365')
    then return; end if;
  -- Other businesses: a voice agent bound to a deployment and its own business phone.
  if t is not null and t<>'biz-1c0c09ce-819e-4795-86b9-0e457ab92f58'
    and exists(select from public.sms_businesses where tenant_id=t)
    and exists(select from sms_private.voice_agents a where a.tenant_id=t
      and a.deployment_id is not null and nullif(a.phone,'') is not null)
    then return; end if;
  raise exception 'Voice business scope denied' using errcode='42501';
end $$;
revoke all on function sms_private.voice_read_scope(text) from public;

create or replace function voice_runtime_api.dispatch(t text, cid text, action text, p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare a sms_private.voice_agents; c sms_private.voice_calls; cfg jsonb; v_contact_id uuid; lid uuid; ph text; k text;
 aid text:='opek-phone'; dialed text:=nullif(p->>'dialed','');
begin
 if length(cid) not between 8 and 160 or cid is null then raise exception 'Invalid call identity'; end if;
 -- The dialed number chooses the business; an existing call keeps the business it started with.
 if dialed is not null then
  if dialed !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Invalid dialed number'; end if;
  select x.tenant_id,x.id into t,aid from sms_private.voice_agents x where x.phone=dialed
   and x.deployment_id is not null order by x.tenant_id,x.id limit 1;
  if aid is null then raise exception 'No voice agent answers this number'; end if;
 else
  select * into c from sms_private.voice_calls x where x.job_id=cid order by x.started_at desc limit 1;
  if c.id is not null then t:=c.tenant_id; aid:=c.agent_id; end if;
 end if;
 perform sms_private.voice_read_scope(t);
 p:=p-'dialed';
 select * into strict a from sms_private.voice_agents where tenant_id=t and id=aid;
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

-- Business facts for the call's own business (the old entry point has no call identity).
create or replace function voice_lookup_api.voice_read_business_call(t text, cid text, q text) returns jsonb
language sql security definer set search_path='' as $$
  select sms_private.voice_read_business(sms_private.voice_call_tenant(t,cid),q);
$$;
revoke all on function voice_lookup_api.voice_read_business_call(text,text,text) from public;
grant execute on function voice_lookup_api.voice_read_business_call(text,text,text) to sms_voice_lookup;

-- Booking, lookup and SMS entry points resolve the call's business before anything else.
do $$
declare f record; def text; changed text;
begin
 for f in select p.oid, n.nspname, p.proname, l.lanname from pg_proc p
   join pg_namespace n on n.oid=p.pronamespace join pg_language l on l.oid=p.prolang
   where (n.nspname='voice_booking_api' and p.proname in ('availability','prepare','confirm','check_change','apply_change'))
      or (n.nspname='voice_lookup_api' and p.proname in ('voice_find_bookings','voice_identify','voice_read_customer','voice_read_start_otp','voice_read_verify_otp'))
      or (n.nspname='voice_sms_api' and p.proname in ('readiness','send'))
 loop
  def:=pg_get_functiondef(f.oid);
  if f.lanname='plpgsql' then
   changed:=regexp_replace(def,'\mbegin\M','begin t:=sms_private.voice_call_tenant(t,cid);','i');
  else
   changed:=replace(def,'(t,cid','(sms_private.voice_call_tenant(t,cid),cid');
  end if;
  if changed=def then raise exception 'Could not add call tenant resolution to %.%',f.nspname,f.proname; end if;
  execute changed;
 end loop;
end $$;

-- Plumbing service: fixed arrival windows, priced on site only.
alter table public.sms_voice_service_rules drop constraint sms_voice_service_rules_service_check;
alter table public.sms_voice_service_rules add constraint sms_voice_service_rules_service_check
 check (service in ('junk_removal','dumpster_rental','property_cleanout','local_moving','plumbing_service'));

do $$
declare f record; def text; changed text;
begin
 for f in select p.oid, n.nspname, p.proname from pg_proc p join pg_namespace n on n.oid=p.pronamespace
   where (n.nspname='voice_booking_api' and p.proname='availability')
      or (n.nspname='sms_private' and p.proname in ('booking_prepare_shared','validate_voice_schedule','voice_save_rule_before_mcp_booking'))
 loop
  def:=pg_get_functiondef(f.oid);
  changed:=replace(def,'''local_moving'')','''local_moving'',''plumbing_service'')');
  if changed=def then raise exception 'Could not add plumbing_service to %.%',f.nspname,f.proname; end if;
  execute changed;
 end loop;
 -- Opek's $69 late change fee is Opek policy only.
 select p.oid into f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='sms_private' and p.proname='voice_change_booking';
 def:=pg_get_functiondef(f.oid);
 changed:=replace(def,'late:=kind in (''reschedule'',''cancel'')',
  'late:=t=''biz-1c0c09ce-819e-4795-86b9-0e457ab92f58'' and kind in (''reschedule'',''cancel'')');
 if changed=def then raise exception 'Could not scope the late change fee'; end if;
 execute changed;
end $$;

update sms_private.mcp_input_schemas
set schema=replace(schema::text,'"local_moving"]','"local_moving", "plumbing_service"]')::jsonb
where tool in ('crm_create_booking_schedule','crm_update_booking_schedule');

do $$ begin
 if (select count(*) from sms_private.mcp_input_schemas
     where tool in ('crm_create_booking_schedule','crm_update_booking_schedule')
       and schema::text like '%"plumbing_service"%') <> 2
 then raise exception 'Booking schedule schemas were not updated'; end if;
end $$;
