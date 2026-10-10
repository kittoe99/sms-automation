-- CRM-owned. Requires Automation activity (remote 20261010191143) and paired E2 baseline.
-- Existing form run IDs and sender metadata remain compatible.
alter table sms_private.runtime add column direct_automations_enabled boolean not null default true;
alter table public.sms_contacts add column revision bigint not null default 1,
 add column enquiry_blocked boolean not null default false;
create table sms_private.contact_sources (
 tenant_id text not null,contact_id uuid not null,source text not null,first_seen_at timestamptz not null default now(),
 primary key(tenant_id,contact_id,source),foreign key(tenant_id,contact_id) references public.sms_contacts(tenant_id,id));
create table sms_private.direct_templates (
 tenant_id text not null references public.sms_businesses(tenant_id),id uuid not null default gen_random_uuid(),
 name text not null check(length(btrim(name)) between 1 and 100),draft jsonb not null,
 revision integer not null default 1,published_version integer,archived boolean not null default false,
 primary key(tenant_id,id));
create table sms_private.direct_versions (
 tenant_id text not null,template_id uuid not null,version integer not null,sequence jsonb not null,
 created_at timestamptz not null default now(),actor text not null,
 primary key(tenant_id,template_id,version),foreign key(tenant_id,template_id) references sms_private.direct_templates(tenant_id,id));
alter table sms_private.form_runs alter column form_id drop not null,alter column submission_id drop not null,
 add column origin text not null default 'form' check(origin in ('form','direct')),
 add column direct_template_id uuid,add column direct_sequence jsonb,add column actor text,add column enrollment_key text,
 add constraint direct_version_fk foreign key(tenant_id,direct_template_id,version) references sms_private.direct_versions(tenant_id,template_id,version),
 add constraint run_origin_valid check((origin='form' and form_id is not null and submission_id is not null and direct_sequence is null and direct_template_id is null)
 or(origin='direct' and form_id is null and submission_id is null and direct_template_id is not null and version is not null and direct_sequence is not null and appointment_at is null and test_sequence is null and enrollment_key is not null));
create unique index direct_enrollment_idempotency on sms_private.form_runs(tenant_id,enrollment_key) where enrollment_key is not null;
create index direct_runs_template on sms_private.form_runs(tenant_id,direct_template_id,version) where origin='direct';
create table sms_private.direct_operations (
 tenant_id text not null,operation_key text not null,request jsonb not null,result jsonb not null,
 created_at timestamptz not null default now(),primary key(tenant_id,operation_key));

create function sms_private.normalize_contact_phone(raw text) returns text language plpgsql immutable set search_path='' as $$
declare ph text:=btrim(raw);begin
 if ph is null or ph='' or ph !~ '^[+0-9[:space:]().-]+$' then raise exception 'Valid international phone number required';end if;
 ph:=regexp_replace(ph,'[[:space:]().-]','','g');
 if left(ph,2)='00' then ph:='+'||substring(ph from 3);end if;
 if ph ~ '^[0-9]{10}$' then ph:='+1'||ph;elsif ph ~ '^1[0-9]{10}$' then ph:='+'||ph;end if;
 if ph !~ '^[+][1-9][0-9]{7,14}$' then raise exception 'Valid international phone number required';end if;return ph;
end $$;
create function sms_private.contact_integrity() returns trigger language plpgsql security definer set search_path='' as $$
begin
 new.phone:=sms_private.normalize_contact_phone(new.phone);
 if tg_op='INSERT' then insert into sms_private.contact_sources(tenant_id,contact_id,source) select tenant_id,id,new.source from public.sms_contacts where tenant_id=new.tenant_id and phone=new.phone on conflict do nothing;end if;
 if tg_op='UPDATE' then
  if new.id<>old.id or new.tenant_id<>old.tenant_id or new.phone<>old.phone then raise exception 'Contact identity cannot change';end if;
  if coalesce(current_setting('sms.explicit_contact_edit',true),'')<>'yes' then
   new.name:=coalesce(nullif(btrim(new.name),''),old.name);new.email:=coalesce(nullif(btrim(new.email),''),old.email);
   new.metadata:=old.metadata||coalesce(new.metadata,'{}');
  end if;
  new.revision:=old.revision+1;
 end if;
 new.updated_at:=now();return new;
end $$;
create trigger contact_integrity before insert or update on public.sms_contacts for each row execute function sms_private.contact_integrity();
create function sms_private.contact_record_source() returns trigger language plpgsql security definer set search_path='' as $$ begin
 insert into sms_private.contact_sources(tenant_id,contact_id,source) values(new.tenant_id,new.id,new.source) on conflict do nothing;
 update public.sms_thread_contacts set name=new.name where tenant_id=new.tenant_id and phone=new.phone and name is distinct from new.name;
 return new;end $$;
create trigger contact_record_source after insert or update on public.sms_contacts for each row execute function sms_private.contact_record_source();
insert into sms_private.contact_sources(tenant_id,contact_id,source) select tenant_id,id,source from public.sms_contacts;
-- Only proven display-name mismatches are repaired. No identities or consent are inferred.
update public.sms_thread_contacts v set name=c.name from public.sms_contacts c where c.tenant_id=v.tenant_id and c.phone=v.phone and nullif(c.name,'') is not null and v.name is distinct from c.name;

create function sms_private.run_enabled(r sms_private.form_runs) returns boolean language sql stable security definer set search_path='' as $$
 select (r.appointment_at is not null or not coalesce((select enquiry_blocked from public.sms_contacts where tenant_id=r.tenant_id and phone=r.phone),false))
 and case when r.origin='direct' then (select direct_automations_enabled from sms_private.runtime) and exists(select from sms_private.direct_templates where tenant_id=r.tenant_id and id=r.direct_template_id)
 else exists(select from public.sms_web_form_definitions f left join sms_private.form_sequences s on s.tenant_id=f.tenant_id and s.form_id=f.public_id
 where f.tenant_id=r.tenant_id and f.public_id=r.form_id and (r.test_sequence is not null or s.enabled and f.enabled) and not f.archived) end
$$;
create function sms_private.direct_validate(s jsonb) returns void language plpgsql set search_path='' as $$begin
 if s->>'trigger' is distinct from 'submission' or s->>'replyPolicy' not in ('pause','continue','stop') then raise exception 'Invalid direct sequence';end if;
 perform sms_private.validate_form_sequence(s||jsonb_build_object('replyPolicy',case when s->>'replyPolicy'='stop' then 'pause' else s->>'replyPolicy' end),'[]',false);
end $$;
create function sms_private.guard_contact_run() returns trigger language plpgsql security definer set search_path='' as $$begin
 if tg_op='INSERT' then perform sms_private.coordination_lock(new.tenant_id,new.phone);end if;
 if tg_op='UPDATE' and (new.origin<>old.origin or new.direct_sequence is distinct from old.direct_sequence or new.direct_template_id is distinct from old.direct_template_id or new.phone<>old.phone) then raise exception 'Run identity and sequence snapshot cannot change';end if;
 if new.appointment_at is null and new.status='active' and exists(select from public.sms_contacts where tenant_id=new.tenant_id and phone=new.phone and enquiry_blocked) then
  new.status:='stopped';new.reason:='CONTACT_FOLLOWUPS_BLOCKED';new.next_run_at:=null;new.generation:=new.generation+1;
 end if;return new;
end $$;
create trigger guard_contact_run before insert or update on sms_private.form_runs for each row execute function sms_private.guard_contact_run();
create function sms_private.contact_automations(u text,t text,action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare c public.sms_contacts; tpl sms_private.direct_templates; r sms_private.form_runs; cfg jsonb; result jsonb; prior sms_private.direct_operations;
 key text; req jsonb; v_overlaps jsonb; selected uuid; due timestamptz; tz text; ctx jsonb; step jsonb; body text; token text[]; val text; preview jsonb:='[]'; n integer:=0; i integer; manage boolean:=false;
begin
 perform sms_private.require_sms_reader(u,t);
 begin perform sms_private.require_admin(u);manage:=true;exception when insufficient_privilege then manage:=false;end;
 select time_zone into tz from public.sms_businesses where tenant_id=t;
 if action='templates' then return jsonb_build_object('templates',coalesce((select jsonb_agg(to_jsonb(x)||jsonb_build_object('published',(select sequence from sms_private.direct_versions where tenant_id=t and template_id=x.id and version=x.published_version)) order by x.name) from sms_private.direct_templates x where tenant_id=t),'[]'),'canManage',manage);end if;
 if action not in ('read','preview') then
  if not manage then raise exception 'Staff management access required' using errcode='42501';end if;
  key:=nullif(p->>'idempotencyKey','');if key is null or length(key)>200 then raise exception 'Idempotency-Key required';end if;
  perform pg_advisory_xact_lock(hashtextextended(t||':direct-operation:'||key,419));
  req:=jsonb_build_object('actor',u,'action',action,'payload',p-'idempotencyKey');
  select * into prior from sms_private.direct_operations where tenant_id=t and operation_key=key;
  if found then if prior.request<>req then raise exception 'Idempotency key reused with different input';end if;return prior.result;end if;
 end if;
 if action in ('save','publish','archive') then
  if p->>'id' is not null then
   select * into tpl from sms_private.direct_templates where tenant_id=t and id=(p->>'id')::uuid for update;
   if tpl.id is null then raise exception 'Template not found' using errcode='42501';end if;
   if tpl.revision is distinct from (p->>'revision')::integer then raise exception 'Template changed; refresh' using errcode='40001';end if;
  elsif action='archive' then raise exception 'Template required';end if;
  if action='archive' then update sms_private.direct_templates set archived=true,revision=revision+1 where tenant_id=t and id=tpl.id returning * into tpl;
  else
   cfg:=p->'sequence';perform sms_private.direct_validate(cfg);
   if tpl.id is null then insert into sms_private.direct_templates(tenant_id,name,draft) values(t,btrim(p->>'name'),cfg) returning * into tpl;
   else update sms_private.direct_templates set name=btrim(p->>'name'),draft=cfg,revision=revision+1 where tenant_id=t and id=tpl.id returning * into tpl;end if;
   if action='publish' then
    if tpl.archived then raise exception 'Archived template';end if;
    insert into sms_private.direct_versions values(t,tpl.id,coalesce(tpl.published_version,0)+1,cfg,now(),u);
    update sms_private.direct_templates set published_version=coalesce(published_version,0)+1 where tenant_id=t and id=tpl.id returning * into tpl;
   end if;
  end if;result:=jsonb_build_object('template',to_jsonb(tpl));
 else
  select * into c from public.sms_contacts where tenant_id=t and id=(p->>'contactId')::uuid;
  if c.id is null then raise exception 'Contact not found' using errcode='42501';end if;
  if action not in ('read','preview') then
   perform sms_private.coordination_lock(t,c.phone);
   select * into c from public.sms_contacts where tenant_id=t and id=c.id for update;
  end if;
  if action='read' then return jsonb_build_object('contact',to_jsonb(c),'canManage',manage,'timeZone',tz,
   'sources',(select jsonb_agg(source order by source) from sms_private.contact_sources where tenant_id=t and contact_id=c.id),
   'runs',coalesce((select jsonb_agg(to_jsonb(x) order by created_at desc) from (select r.*,coalesce(f.title,d.name) as title from sms_private.form_runs r
    left join public.sms_web_form_definitions f on f.tenant_id=r.tenant_id and f.public_id=r.form_id left join sms_private.direct_templates d on d.tenant_id=r.tenant_id and d.id=r.direct_template_id where r.tenant_id=t and r.phone=c.phone order by created_at desc limit 100)x),'[]'),
   'overlaps',coalesce((select jsonb_agg(jsonb_build_object('id',id,'generation',generation) order by id) from sms_private.form_runs where tenant_id=t and phone=c.phone and appointment_at is null and status in ('active','paused')),'[]'));end if;
  if action in ('preview','enroll') then
   select * into tpl from sms_private.direct_templates where tenant_id=t and id=(p->>'templateId')::uuid for share;
   if tpl.id is null or tpl.archived or tpl.published_version is null then raise exception 'Published active template required';end if;
   if action='enroll' and tpl.revision is distinct from (p->>'templateRevision')::integer then raise exception 'Template changed; preview again' using errcode='40001';end if;
   select sequence into cfg from sms_private.direct_versions where tenant_id=t and template_id=tpl.id and version=tpl.published_version;
   cfg:=coalesce(p->'sequence',cfg);perform sms_private.direct_validate(cfg);
   ctx:=jsonb_build_object('name',c.name,'first_name',split_part(c.name,' ',1),'phone',c.phone,'email',c.email,'business_name',(select name from public.sms_businesses where tenant_id=t),'request',left(coalesce(p->>'context',''),2500));
   due:=greatest(coalesce(nullif(p->>'startAt','')::timestamptz,now()),now());
   for step in select value from jsonb_array_elements(cfg->'steps') loop
    body:=step->>'body';for token in select regexp_matches(body,'\{\{([^{}]+)\}\}','g') loop
     val:=ctx->>token[1];if nullif(btrim(val),'') is null then raise exception 'Contact needs a value for %',token[1];end if;body:=replace(body,'{{'||token[1]||'}}',val);
    end loop;if length(body)>1600 then raise exception 'Personalized message exceeds 1600 characters';end if;
    for i in 1..(step->>'sendCount')::integer loop
     due:=sms_private.form_due(due,(step->>case when i=1 then 'delayCount' else 'intervalCount' end)::integer,step->>case when i=1 then 'delayUnit' else 'intervalUnit' end,tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
     preview:=preview||jsonb_build_array(jsonb_build_object('at',due,'body',body));n:=n+1;exit when n>=50;
    end loop;exit when n>=50;
   end loop;
   if action='preview' then return jsonb_build_object('messages',preview,'limit',50,'timeZone',tz,'templateRevision',tpl.revision,'contactRevision',c.revision);end if;
   if not (select direct_automations_enabled from sms_private.runtime) then raise exception 'Direct automations are disabled';end if;
   if c.opted_out or not c.marketing_consent then raise exception 'Recorded SMS consent required; STOP cannot be overridden';end if;
   if c.enquiry_blocked then raise exception 'Contact enquiry follow-ups are blocked';end if;
   if c.revision is distinct from (p->>'contactRevision')::bigint then raise exception 'Contact changed; refresh' using errcode='40001';end if;
   select coalesce(jsonb_agg(jsonb_build_object('id',id,'generation',generation) order by id),'[]') into v_overlaps from sms_private.form_runs where tenant_id=t and phone=c.phone and appointment_at is null and status in ('active','paused');
   if v_overlaps<>coalesce(p->'overlaps','[]') then raise exception 'Existing automations changed; review overlaps' using errcode='40001';end if;
   if v_overlaps<>'[]' and p->>'overlapChoice' not in ('keep','stop_selected') or v_overlaps<>'[]' and p->>'overlapChoice' is null then raise exception 'Choose what happens to existing automations';end if;
   if p->>'overlapChoice'='stop_selected' then
    for selected in select value::uuid from jsonb_array_elements_text(coalesce(p->'stopRunIds','[]')) loop
     if not exists(select from jsonb_array_elements(v_overlaps) x where x->>'id'=selected::text) then raise exception 'Run outside contact scope' using errcode='42501';end if;
     update sms_private.form_runs set status='stopped',reason='REPLACED_BY_STAFF',generation=generation+1,next_run_at=null where id=selected;
    end loop;
   end if;
   insert into sms_private.form_runs(tenant_id,origin,direct_template_id,version,direct_sequence,phone,context,actor,enrollment_key,next_run_at)
    values(t,'direct',tpl.id,tpl.published_version,cfg,c.phone,ctx,u,key,(preview->0->>'at')::timestamptz) returning * into r;
   result:=jsonb_build_object('run',to_jsonb(r));
  elsif action='run' then
   select * into r from sms_private.form_runs where tenant_id=t and phone=c.phone and id=(p->>'runId')::uuid for update;
   if r.id is null then raise exception 'Run outside contact scope' using errcode='42501';end if;
   if r.generation is distinct from (p->>'generation')::bigint then raise exception 'Run changed; refresh' using errcode='40001';end if;
   if p->>'operation' not in ('pause','resume','stop') or p->>'operation' is null then raise exception 'Choose pause, resume or stop';end if;
   if r.status not in ('active','paused') then raise exception 'Finished runs require a new enrollment';end if;
   if p->>'operation'='resume' then
    if c.opted_out or not c.marketing_consent and r.appointment_at is null or not sms_private.run_enabled(r) then raise exception 'STOP, consent or automation settings prevent resuming';end if;
    if exists(select from sms_private.jobs where tenant_id=t and payload->'request'->>'form_run_id'=r.id::text and status in ('submitting','submission_unknown')) then raise exception 'Previous send requires reconciliation';end if;
   end if;
   update sms_private.form_runs set status=case p->>'operation' when 'resume' then 'active' when 'pause' then 'paused' else 'stopped' end,
    reason=case when p->>'operation'='resume' then null else 'MANUAL_'||upper(p->>'operation') end,generation=generation+1,
    next_run_at=case when p->>'operation'='stop' then null else greatest(now(),next_run_at) end where id=r.id returning * into r;
   result:=jsonb_build_object('run',to_jsonb(r));
  elsif action='block' then
   if c.revision is distinct from (p->>'revision')::bigint then raise exception 'Contact changed; refresh' using errcode='40001';end if;
   if jsonb_typeof(p->'blocked') is distinct from 'boolean' then raise exception 'Choose blocked state';end if;
   update public.sms_contacts set enquiry_blocked=(p->>'blocked')::boolean where tenant_id=t and id=c.id returning * into c;
   if c.enquiry_blocked then update sms_private.form_runs set status='stopped',reason='CONTACT_FOLLOWUPS_BLOCKED',next_run_at=null,generation=generation+1 where tenant_id=t and phone=c.phone and appointment_at is null and status in ('active','paused');end if;
   result:=jsonb_build_object('contact',to_jsonb(c));
  elsif action='edit' then
   if c.revision is distinct from (p->>'revision')::bigint then raise exception 'Contact changed; refresh' using errcode='40001';end if;
   perform set_config('sms.explicit_contact_edit','yes',true);
   update public.sms_contacts set name=case when p ? 'name' then left(btrim(coalesce(p->>'name','')),200) else name end,email=case when p ? 'email' then nullif(btrim(p->>'email'),'') else email end where tenant_id=t and id=c.id returning * into c;
   perform set_config('sms.explicit_contact_edit','',true);result:=jsonb_build_object('contact',to_jsonb(c));
  else raise exception 'Unknown contact automation operation';end if;
 end if;
 insert into sms_private.direct_operations values(t,key,req,result,now());
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'contact_automation_'||action,jsonb_build_object('contactId',c.id,'runId',r.id,'templateId',tpl.id,'operationKey',key));
 if r.id is not null then perform sms_private.activity_event(t,r.id,'direct-operation:'||key,'staff_action',clock_timestamp(),jsonb_build_object('actor',u,'action',action,'operation',p->>'operation'));end if;
 return result;
end $$;
create function sms_private.run_quiet_until(r sms_private.form_runs) returns timestamptz language plpgsql security definer set search_path='' as $$
declare due timestamptz;begin
 if r.origin<>'direct' then return sms_private.enquiry_quiet_until(r.tenant_id,r.phone);end if;
 select max(case when direction='inbound' then created_at else provider_accepted_at end)+interval '30 minutes' into due
 from public.sms_messages where tenant_id=r.tenant_id and contact_phone=r.phone and (direction='inbound' or provider_accepted_at is not null and meta->>'agent_version'='sms-agent-v1');
 return greatest(due,sms_private.enquiry_quiet_until(r.tenant_id,r.phone));end $$;
CREATE OR REPLACE FUNCTION sms_private.form_run_sequence(r sms_private.form_runs)
 RETURNS jsonb
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
 select coalesce(r.direct_sequence,r.test_sequence,(select v.sequence from sms_private.form_sequence_versions v
  where v.tenant_id=r.tenant_id and v.form_id=r.form_id and v.version=r.version))
$function$
;

CREATE OR REPLACE FUNCTION sms_private.begin_submission_before_inbound_agent(jid uuid, token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j sms_private.jobs; p jsonb; r sms_private.form_runs; cfg jsonb; tz text; due timestamptz; begin
  j:=sms_private.lease(jid,token); p:=j.payload->'request';
  if p ? 'enrollment_id' or p ? 'ai_run_id' or j.dedupe_key like 'ai:%'
    or p ? 'conversation_generation' and not p ? 'form_run_id' then
    perform sms_private.finish(jid,token,'cancelled','SMS_AI_DISABLED'); return null;
  end if;
  if p ? 'form_run_id' then
    select * into r from sms_private.form_runs where tenant_id=j.tenant_id and id=(p->>'form_run_id')::uuid for update;
    if r.id is null or r.status<>'active' or r.generation<>(p->>'run_generation')::bigint or r.send_index<>(p->>'send_index')::integer
      or r.appointment_at<=now() or not sms_private.run_enabled(r) then
      perform sms_private.finish(jid,token,'cancelled','STALE_FORM_RUN'); return null;
    end if;
    cfg:=sms_private.form_run_sequence(r);
    select time_zone into tz from public.sms_businesses where tenant_id=r.tenant_id;
    due:=sms_private.form_due(now(),0,'minute',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
    if due>now() then
      update sms_private.jobs set attempts=attempts-1 where id=jid;
      perform sms_private.finish(jid,token,'retry','OUTSIDE_WINDOW',least(3600,ceil(extract(epoch from due-now()))::integer)); return null;
    end if;
  end if;
  return sms_private.begin_submission_before_form_sequences(jid,token);
end $function$
;

CREATE OR REPLACE FUNCTION sms_private.enqueue_due_automations()
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r record; n integer:=0; begin
  for r in select e.* from sms_private.form_runs e join public.sms_businesses b on b.tenant_id=e.tenant_id
    left join sms_private.form_sequences s on s.tenant_id=e.tenant_id and s.form_id=e.form_id
    left join public.sms_web_form_definitions f on f.tenant_id=e.tenant_id and f.public_id=e.form_id
    where (e.appointment_at is not null or sms_private.form_run_sequence(e)->>'replyPolicy'<>'continue' or coalesce(sms_private.run_quiet_until(e),now())<=now()) and e.status='active' and e.next_run_at<=now() and b.sending_enabled and b.status='active'
      and sms_private.run_enabled(e)
      and not exists(select from sms_private.jobs j where j.tenant_id=e.tenant_id and j.queue='automation_jobs'
        and j.dedupe_key='form:'||e.id||':'||e.generation||':'||e.send_index)
    order by e.next_run_at,e.id limit (select scheduler_batch_size from sms_private.runtime)
  loop
    perform sms_private.enqueue(r.tenant_id,'automation_jobs','form:'||r.id||':'||r.generation||':'||r.send_index,
      jsonb_build_object('form_run_id',r.id,'generation',r.generation,'send_index',r.send_index)); n:=n+1;
  end loop;
  return n;
end $function$
;

CREATE OR REPLACE FUNCTION sms_private.process_form_automation_before_coordination(jid uuid, token uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j sms_private.jobs; r sms_private.form_runs; cfg jsonb; step jsonb; body text; key text[]; val text;
  tz text; due timestamptz; result jsonb;
begin
  j:=sms_private.lease(jid,token);
  if j.queue<>'automation_jobs' then raise exception 'Wrong queue'; end if;
  select * into r from sms_private.form_runs where tenant_id=j.tenant_id and id=(j.payload->>'form_run_id')::uuid for update;
  if r.id is null or not sms_private.run_enabled(r) or r.status<>'active' or r.generation<>(j.payload->>'generation')::bigint or r.send_index<>(j.payload->>'send_index')::integer then
    perform sms_private.finish(jid,token,'cancelled','STALE_FORM_RUN'); return null; end if;
  cfg:=sms_private.form_run_sequence(r);
  step:=cfg->'steps'->r.message_index;
  if step is null or r.appointment_at<=now() then
    update sms_private.form_runs set status='completed',next_run_at=null where id=r.id;
    perform sms_private.finish(jid,token,'completed'); return null; end if;
  if exists(select from sms_private.jobs where tenant_id=r.tenant_id and queue='sms_send_jobs'
    and payload->'request'->>'form_run_id'=r.id::text and (payload->'request'->>'send_index')::integer=r.send_index
    and (status in ('submitting','submission_unknown') or status in ('queued','retry','processing') and (payload->'request'->>'run_generation')::bigint=r.generation)) then
    perform sms_private.finish(jid,token,'completed'); return null; end if;
  select time_zone into tz from public.sms_businesses where tenant_id=r.tenant_id;
  due:=sms_private.form_due(greatest(r.next_run_at,now()),0,'minute',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
  if due>now() then
    update sms_private.form_runs set next_run_at=due,generation=generation+1 where id=r.id;
    perform sms_private.finish(jid,token,'completed'); return null; end if;
  body:=step->>'body';
  for key in select regexp_matches(body,'\{\{([^{}]+)\}\}','g') loop
    val:=case when key[1]='appointment_at' then to_char(r.appointment_at at time zone tz,'Mon DD, YYYY HH24:MI')||' ('||tz||')'
      when key[1] like 'field.%' then r.context->'fields'->>substring(key[1] from 7) else r.context->>key[1] end;
    if nullif(btrim(val),'') is null then
      update sms_private.form_runs set status='paused',reason='MISSING_FIELD:'||key[1],generation=generation+1 where id=r.id;
      perform sms_private.finish(jid,token,'completed'); return null;
    end if;
    body:=replace(body,'{{'||key[1]||'}}',val);
  end loop;
  if length(body)>1600 or position('{{' in body)>0 then
    update sms_private.form_runs set status='paused',reason='MESSAGE_TOO_LONG_OR_INVALID',generation=generation+1 where id=r.id;
    perform sms_private.finish(jid,token,'completed'); return null;
  end if;
  result:=sms_private.outbox(r.tenant_id,'form:'||r.id||':'||r.generation||':'||r.send_index,
    jsonb_build_object('phone',r.phone,'body',body,'purpose',case when r.appointment_at is null then 'marketing' else 'transactional' end,
      'form_run_id',r.id,'form_id',r.form_id,'run_generation',r.generation,'send_index',r.send_index,
      'start_hour',(cfg->>'startHour')::integer,'end_hour',(cfg->>'endHour')::integer));
  update public.sms_messages set meta=meta||jsonb_build_object('form_id',r.form_id,'form_run_id',r.id,'sequence_version',r.version,'test_run',r.test_sequence is not null,
    'origin',r.origin,'direct_template_id',r.direct_template_id,'message_number',r.message_index+1,'repeat_number',r.repeat_index+1) where tenant_id=r.tenant_id and id=(result->>'messageId')::uuid;
  perform sms_private.finish(jid,token,'completed'); return result;
end $function$
;

CREATE OR REPLACE FUNCTION sms_private.defer_enquiry_job(j sms_private.jobs, token uuid, rid uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ declare r sms_private.form_runs; due timestamptz; begin
 select * into r from sms_private.form_runs where tenant_id=j.tenant_id and id=rid for update;
 if r.id is null or r.status<>'active' or r.appointment_at is not null
  or sms_private.form_run_sequence(r)->>'trigger'<>'submission' or sms_private.form_run_sequence(r)->>'replyPolicy'<>'continue' then return false; end if;
 if r.generation<>coalesce((j.payload->>'generation')::bigint,(j.payload->'request'->>'run_generation')::bigint)
  or r.send_index<>coalesce((j.payload->>'send_index')::integer,(j.payload->'request'->>'send_index')::integer) then return false; end if;
 due:=sms_private.run_quiet_until(r);
 if due is null or due<=now() then return false; end if;
 update sms_private.jobs set attempts=greatest(0,attempts-1) where id=j.id;
 perform sms_private.finish(j.id,token,'retry','AI_QUIET_WINDOW',greatest(1,ceil(extract(epoch from due-now()))::integer));
 return true;
end $function$
;

CREATE OR REPLACE FUNCTION sms_private.inbound_automation_context(j sms_private.jobs)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare candidates jsonb; last_out jsonb; associated uuid; previous uuid; n integer; begin
 if not exists(select from sms_private.inbound_ai_settings where tenant_id=j.tenant_id and coordination_enabled and mode in ('live','shadow')) then return '{}'; end if;
 select jsonb_build_object('id',id,'body',left(body,1600),'acceptedAt',provider_accepted_at,'requestRef',coalesce(meta->>'form_run_id',meta->>'enquiry_run_id')) into last_out
 from public.sms_messages where tenant_id=j.tenant_id and contact_phone=j.payload->>'phone' and direction='outbound'
  and provider_accepted_at is not null and provider_accepted_at<=(select created_at from public.sms_messages where tenant_id=j.tenant_id and id=(j.payload->>'message_id')::uuid)
 order by provider_accepted_at desc,created_at desc,id desc limit 1;
 select coalesce(jsonb_agg(x order by x."requestRef"),'[]'),count(*) into candidates,n from (
  select r.id as "requestRef",r.form_id as "formId",coalesce(f.title,d.name) as title,r.origin,r.submission_id as "submissionId",r.version,
   r.status,r.reason,r.message_index+1 as "messageNumber",r.next_run_at as "nextRunAt",
   sms_private.form_run_sequence(r)->>'replyPolicy' as "replyPolicy",left(r.context::text,2500) as "customerContext",
   (select jsonb_build_object('body',left(m.body,1600),'acceptedAt',m.provider_accepted_at) from public.sms_messages m
     where m.tenant_id=r.tenant_id and m.contact_phone=r.phone and m.meta->>'form_run_id'=r.id::text and m.provider_accepted_at is not null
     order by m.provider_accepted_at desc limit 1) as "lastAutomationMessage"
  from sms_private.form_runs r left join public.sms_web_form_definitions f on f.tenant_id=r.tenant_id and f.public_id=r.form_id left join sms_private.direct_templates d on d.tenant_id=r.tenant_id and d.id=r.direct_template_id
  where r.tenant_id=j.tenant_id and r.phone=j.payload->>'phone' and r.appointment_at is null
   and sms_private.form_run_sequence(r)->>'trigger'='submission' and (r.status in ('active','paused') or r.origin='direct' and r.reason='CUSTOMER_REPLY_STOP')
  order by r.id limit 11
 )x;
 select enquiry_run_id into previous from sms_private.inbound_ai_sessions where tenant_id=j.tenant_id and conversation_id=(j.payload->>'conversation_id')::uuid;
 if exists(select from jsonb_array_elements(candidates) x where x->>'requestRef'=previous::text) then associated:=previous; end if;
 if last_out->>'requestRef' is not null and exists(select from jsonb_array_elements(candidates) x where x->>'requestRef'=last_out->>'requestRef') then
  if associated is null or associated::text=last_out->>'requestRef' then associated:=(last_out->>'requestRef')::uuid; else associated:=null; end if;
 elsif associated is null and n=1 then associated:=(candidates->0->>'requestRef')::uuid; end if;
 if n>10 then associated:=null; end if;
 return jsonb_build_object('candidates',candidates,'associatedRequestRef',associated,'needsClarification',associated is null and n>1,
  'lastAcceptedOutbound',last_out,'quietUntil',sms_private.enquiry_quiet_until(j.tenant_id,j.payload->>'phone',true),'shadow',
  exists(select from sms_private.inbound_ai_settings where tenant_id=j.tenant_id and mode='shadow'));
end $function$
;

CREATE OR REPLACE FUNCTION sms_private.inbound_ai_settings_api(u text, t text, p jsonb DEFAULT NULL::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$ declare result jsonb; begin
 result:=sms_private.inbound_ai_settings_api_before_coordination(u,t,p);
 return result||jsonb_build_object('coordinationEnabled',(select coordination_enabled from sms_private.inbound_ai_settings where tenant_id=t),
  'coordination',coalesce((select jsonb_agg(x) from (
   select r.id as "requestRef",coalesce(f.title,d.name) as title,r.status,r.reason,sms_private.enquiry_quiet_until(t,r.phone,true) as "quietUntil",
    exists(select from sms_private.inbound_ai_sessions s where s.tenant_id=t and s.enquiry_run_id=r.id) as associated
   from sms_private.form_runs r left join public.sms_web_form_definitions f on f.tenant_id=r.tenant_id and f.public_id=r.form_id left join sms_private.direct_templates d on d.tenant_id=r.tenant_id and d.id=r.direct_template_id
   where r.tenant_id=t and r.appointment_at is null and r.status in ('active','paused')
    and sms_private.form_run_sequence(r)->>'trigger'='submission'
   order by r.created_at desc limit 30)x),'[]'));
end $function$
;

create or replace view sms_private.activity_enquiries as
 select r.id,r.tenant_id,r.form_id,r.version,r.submission_id,r.intake_id,r.phone,r.context,r.appointment_at,r.status,r.reason,r.message_index,r.repeat_index,r.send_index,r.generation,r.next_run_at,r.last_sent_at,r.created_at,r.test_sequence,r.test_actor,r.test_request,coalesce(f.title,d.name) as form_title,coalesce(nullif(r.context->>'name',''),c.name,'Unknown') as customer,
 c.opted_out,cv.id as conversation_id,coalesce(cv.ai_paused,false) as ai_paused,
 case when r.test_sequence is not null then 'test' when r.appointment_at is not null or sms_private.form_run_sequence(r)->>'trigger'='appointment' then 'appointment' when r.origin='direct' then 'direct' else 'enquiry' end as scope,
 case when r.appointment_at is null and sms_private.form_run_sequence(r)->>'replyPolicy'='continue' then sms_private.run_quiet_until(r) end as quiet_until,
 (select min(m.provider_accepted_at) from public.sms_messages m where m.tenant_id=r.tenant_id and m.meta->>'form_run_id'=r.id::text and m.provider_accepted_at is not null) as first_contact_at,
 (select count(*) from sms_private.activity_responses a where a.tenant_id=r.tenant_id and a.run_id=r.id) as response_count,
 (select left(m.body,200) from sms_private.activity_responses a join public.sms_messages m on m.tenant_id=a.tenant_id and m.id=a.message_id where a.tenant_id=r.tenant_id and a.run_id=r.id order by m.created_at desc limit 1) as latest_response,
 (select count(*) from sms_private.activity_bookings a where a.tenant_id=r.tenant_id and a.run_id=r.id) as linked_bookings,
 (select count(*) from sms_private.activity_bookings a join public.sms_bookings b on b.tenant_id=a.tenant_id and b.id=a.booking_id where a.tenant_id=r.tenant_id and a.run_id=r.id and b.status='confirmed') as confirmed_bookings,
 (select count(*) from sms_private.activity_bookings a join public.sms_bookings b on b.tenant_id=a.tenant_id and b.id=a.booking_id where a.tenant_id=r.tenant_id and a.run_id=r.id and b.status='cancelled') as cancelled_bookings,
 (select count(*) from sms_private.activity_handoffs a join public.sms_handoffs h on h.tenant_id=a.tenant_id and h.id=a.handoff_id where a.tenant_id=r.tenant_id and a.run_id=r.id) as handoffs,
 (select count(*) from sms_private.activity_handoffs a join public.sms_handoffs h on h.tenant_id=a.tenant_id and h.id=a.handoff_id where a.tenant_id=r.tenant_id and a.run_id=r.id and h.status in ('open','assigned')) as unresolved_handoffs,
 coalesce((select jsonb_agg(jsonb_build_object('id',t.id,'name',t.name) order by t.name) from sms_private.activity_run_tags a join sms_private.activity_tags t on t.tenant_id=a.tenant_id and t.id=a.tag_id where a.tenant_id=r.tenant_id and a.run_id=r.id and not t.archived),'[]') as tags,r.origin,r.direct_template_id,r.direct_sequence,r.actor,r.enrollment_key
 from sms_private.form_runs r left join public.sms_web_form_definitions f on f.tenant_id=r.tenant_id and f.public_id=r.form_id left join sms_private.direct_templates d on d.tenant_id=r.tenant_id and d.id=r.direct_template_id
 left join public.sms_contacts c on c.tenant_id=r.tenant_id and c.phone=r.phone
 left join public.sms_conversations cv on cv.tenant_id=r.tenant_id and cv.phone=r.phone and cv.group_id is null;


CREATE OR REPLACE FUNCTION sms_private.automation_activity(u text, t text, action text, p jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare report_at timestamptz:=statement_timestamp(); tz text; from_at timestamptz; until_at timestamptz; result jsonb;
 r sms_private.form_runs; v_booking public.sms_bookings; v_message public.sms_messages; tag sms_private.activity_tags;
 rid uuid; old_rid uuid; rev integer; manage boolean:=false; pg integer:=greatest(1,coalesce((p->>'page')::integer,1));
 page_size integer:=least(100,greatest(1,coalesce((p->>'pageSize')::integer,25))); from_day date; end_day date;
begin
 perform sms_private.require_sms_reader(u,t);
 begin perform sms_private.require_admin(u); manage:=true; exception when insufficient_privilege then manage:=false; end;
 select time_zone into tz from public.sms_businesses where tenant_id=t; tz:=coalesce(tz,'UTC');
 from_day:=coalesce(nullif(p->>'from','')::date,(report_at at time zone tz)::date-29);
 end_day:=coalesce(nullif(p->>'to','')::date,(report_at at time zone tz)::date);
 if end_day<from_day or end_day-from_day>366 then raise exception 'Choose a date range of up to 367 days'; end if;
 from_at:=from_day::timestamp at time zone tz; until_at:=(end_day+1)::timestamp at time zone tz;
 if action in ('tag','tag_assignment','booking_link','response_link','activity_link','sequence') then
  if not manage then raise exception 'Staff management access required' using errcode='42501'; end if;
  if action='tag' then
   if nullif(p->>'id','') is null then
    insert into sms_private.activity_tags(tenant_id,name) values(t,trim(p->>'name')) returning * into tag;
   else
    select * into tag from sms_private.activity_tags where tenant_id=t and id=(p->>'id')::uuid for update;
    if tag.id is null then raise exception 'Tag not found' using errcode='42501'; end if;
    if tag.revision is distinct from (p->>'revision')::integer then raise exception 'Tag changed; refresh before editing' using errcode='40001'; end if;
    update sms_private.activity_tags set name=coalesce(trim(p->>'name'),name),archived=coalesce((p->>'archived')::boolean,archived),revision=revision+1 where tenant_id=t and id=tag.id returning * into tag;
   end if;
   perform sms_private.activity_event(t,null,'tag:'||tag.id||':'||tag.revision,'staff_tag',clock_timestamp(),jsonb_build_object('actor',u,'tagId',tag.id,'name',tag.name,'archived',tag.archived));
   return jsonb_build_object('tag',to_jsonb(tag),'reportingAt',report_at);
  end if;
  select * into r from sms_private.form_runs where tenant_id=t and id=(p->>'runId')::uuid;
  if r.id is null then raise exception 'Enquiry not found' using errcode='42501'; end if;
  perform sms_private.coordination_lock(t,r.phone);
  select * into r from sms_private.form_runs where tenant_id=t and id=r.id for update;
  if action='sequence' then
   if p->>'operation' not in ('pause','resume','stop') then raise exception 'Choose pause, resume or stop'; end if;
   if r.generation is distinct from (p->>'generation')::bigint then raise exception 'Sequence changed; refresh before editing' using errcode='40001'; end if;
   if p->>'operation'='resume' and exists(select from public.sms_contacts where tenant_id=t and phone=r.phone and opted_out) then raise exception 'STOP suppression prevents resuming'; end if;
   perform sms_private.contact_automations(u,t,'run',p||jsonb_build_object('contactId',(select id from public.sms_contacts where tenant_id=t and phone=r.phone),'idempotencyKey',coalesce(p->>'idempotencyKey','activity:'||r.id||':'||r.generation||':'||(p->>'operation'))));
  elsif action='tag_assignment' then
   select * into tag from sms_private.activity_tags where tenant_id=t and id=(p->>'tagId')::uuid for share;
   if tag.id is null or tag.archived then raise exception 'Active business tag required' using errcode='42501'; end if;
   if (p->>'present')::boolean then insert into sms_private.activity_run_tags values(t,r.id,tag.id) on conflict do nothing;
   else delete from sms_private.activity_run_tags where tenant_id=t and run_id=r.id and tag_id=tag.id; end if;
  elsif action='booking_link' then
   if r.test_sequence is not null or r.appointment_at is not null then raise exception 'Choose a real enquiry'; end if;
   select * into v_booking from public.sms_bookings where tenant_id=t and id=p->>'bookingId' for update;
   if v_booking.id is null or coalesce(v_booking.customer_phone,(select phone from public.sms_contacts where tenant_id=t and id=v_booking.contact_id)) is distinct from r.phone then raise exception 'Same-business, same-customer booking required' using errcode='42501'; end if;
   select run_id,revision into old_rid,rev from sms_private.activity_bookings where tenant_id=t and booking_id=v_booking.id;
   if coalesce(rev,0) is distinct from (p->>'revision')::integer then raise exception 'Booking attribution changed; refresh before editing' using errcode='40001'; end if;
   insert into sms_private.activity_bookings(tenant_id,booking_id,run_id,basis,actor) values(t,v_booking.id,r.id,'staff_explicit',u)
    on conflict(tenant_id,booking_id) do update set run_id=excluded.run_id,basis=excluded.basis,actor=u,revision=activity_bookings.revision+1,linked_at=clock_timestamp();
   if old_rid is not null and old_rid<>r.id then perform sms_private.activity_event(t,old_rid,'booking-unlink:'||v_booking.id||':'||rev,'booking_attribution_removed',clock_timestamp(),jsonb_build_object('actor',u,'bookingId',v_booking.id,'newRunId',r.id)); end if;
   if r.origin='direct' and v_booking.status='confirmed' and r.status in ('active','paused') then update sms_private.form_runs set status='stopped',reason='LINKED_BOOKING_CONFIRMED',next_run_at=null,generation=generation+1 where id=r.id;end if;
  elsif action='activity_link' then
   if not exists(select from sms_private.activity_events e left join public.sms_conversations cv on cv.tenant_id=e.tenant_id and cv.id::text=e.details->>'conversationId'
    where e.tenant_id=t and e.id=(p->>'eventId')::bigint and e.kind in ('ai_action','ai_run','ai_sent') and coalesce(e.details->>'phone',cv.phone)=r.phone) then raise exception 'Same-customer AI activity required' using errcode='42501'; end if;
   update sms_private.activity_events set run_id=r.id,revision=revision+1 where tenant_id=t and id=(p->>'eventId')::bigint and revision=(p->>'revision')::integer;
   if not found then raise exception 'Activity attribution changed; refresh before editing' using errcode='40001'; end if;
  elsif action='response_link' then
   select * into v_message from public.sms_messages where tenant_id=t and id=(p->>'messageId')::uuid and direction='inbound' for update;
   if v_message.id is null or v_message.contact_phone<>r.phone then raise exception 'Same-customer response required' using errcode='42501'; end if;
   select run_id,revision into old_rid,rev from sms_private.activity_responses where tenant_id=t and message_id=v_message.id;
   if coalesce(rev,0) is distinct from (p->>'revision')::integer then raise exception 'Response attribution changed; refresh before editing' using errcode='40001'; end if;
   insert into sms_private.activity_responses(tenant_id,message_id,run_id,basis,actor) values(t,v_message.id,r.id,'staff_explicit',u)
    on conflict(tenant_id,message_id) do update set run_id=excluded.run_id,basis=excluded.basis,actor=u,revision=activity_responses.revision+1;
   update sms_private.activity_events set run_id=r.id where tenant_id=t and event_key='reply:'||v_message.id;
   if old_rid is not null and old_rid<>r.id then perform sms_private.activity_event(t,old_rid,'response-unlink:'||v_message.id||':'||rev,'response_attribution_removed',clock_timestamp(),jsonb_build_object('actor',u,'messageId',v_message.id,'newRunId',r.id)); end if;
  end if;
  perform sms_private.activity_event(t,r.id,'staff:'||gen_random_uuid(),'staff_'||action,clock_timestamp(),p||jsonb_build_object('actor',u));
  return jsonb_build_object('ok',true,'reportingAt',report_at);
 end if;
 if action='timeline' then
  select * into r from sms_private.form_runs where tenant_id=t and id=(p->>'runId')::uuid;
  if r.id is null then raise exception 'Enquiry not found' using errcode='42501'; end if;
  return jsonb_build_object('reportingAt',report_at,'timeZone',tz,'canManage',manage,
   'enquiry',(select to_jsonb(x) from sms_private.activity_enquiries x where tenant_id=t and id=r.id),
   'events',coalesce((select jsonb_agg(to_jsonb(e) order by e.recorded_at,e.id) from sms_private.activity_events e where tenant_id=t and run_id=r.id),'[]'),
   'bookings',coalesce((select jsonb_agg(jsonb_build_object('id',b.id,'status',b.status,'appointmentAt',b.appointment_at,'channel',coalesce(b.source,'Unknown'),'creator',coalesce(b.metadata->>'actor','Unknown'),'linkedRunId',a.run_id,'revision',coalesce(a.revision,0))) from public.sms_bookings b left join sms_private.activity_bookings a on a.tenant_id=b.tenant_id and a.booking_id=b.id left join public.sms_contacts c on c.tenant_id=b.tenant_id and c.id=b.contact_id where b.tenant_id=t and coalesce(b.customer_phone,c.phone)=r.phone),'[]'),
   'handoffs',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'status',h.status,'reason',h.reason)) from sms_private.activity_handoffs a join public.sms_handoffs h on h.tenant_id=a.tenant_id and h.id=a.handoff_id where a.tenant_id=t and a.run_id=r.id),'[]'));
 end if;
 if action='unlinked' then
  with items as (
   select e.*,coalesce((select jsonb_agg(jsonb_build_object('id',fr.id,'title',coalesce(f.title,d.name))) from sms_private.form_runs fr left join public.sms_web_form_definitions f on f.tenant_id=fr.tenant_id and f.public_id=fr.form_id left join sms_private.direct_templates d on d.tenant_id=fr.tenant_id and d.id=fr.direct_template_id where fr.tenant_id=t and fr.phone=e.details->>'phone' and fr.test_sequence is null and fr.appointment_at is null),'[]') as candidates from sms_private.activity_events e where tenant_id=t and (case when p->>'shadow'='true' then simulated else run_id is null and not simulated end) and kind in ('customer_response','ai_action','ai_sent','ai_run')
    and coalesce(occurred_at,recorded_at)>=from_at and coalesce(occurred_at,recorded_at)<until_at
    and (coalesce(p->>'search','')='' or details::text ilike '%'||(p->>'search')||'%')
  ) select jsonb_build_object('reportingAt',report_at,'timeZone',tz,'total',(select count(*) from items),'page',pg,
   'rows',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from items order by recorded_at desc,id desc limit page_size offset (pg-1)*page_size)x),'[]')) into result;
  return result;
 end if;
 if action not in ('report','summary','enquiries') then raise exception 'Unknown activity operation'; end if;
 with base as materialized (
  select * from sms_private.activity_enquiries x where tenant_id=t
   and (scope=coalesce(nullif(p->>'scope',''),'all') or coalesce(nullif(p->>'scope',''),'all')='all' and scope in ('enquiry','direct'))
   and (coalesce(p->>'template','')='' or direct_template_id::text=p->>'template') and (coalesce(p->>'form','')='' or form_id::text=p->>'form')
   and (coalesce(p->>'status','')='' or status=p->>'status')
   and (coalesce(p->>'response','')='' or (response_count>0)=(p->>'response'='responded'))
   and (coalesce(p->>'booking','')='' or case p->>'booking' when 'booked' then confirmed_bookings>0 when 'cancelled' then cancelled_bookings>0 else confirmed_bookings=0 end)
   and (coalesce(p->>'handoff','')='' or case p->>'handoff' when 'unresolved' then unresolved_handoffs>0 when 'any' then handoffs>0 else handoffs=0 end)
   and (coalesce(p->>'search','')='' or customer ilike '%'||(p->>'search')||'%' or phone ilike '%'||(p->>'search')||'%')
   and (coalesce(p->>'tags','')='' or exists(select from jsonb_array_elements(tags) selected_tag where selected_tag->>'id'=any(string_to_array(p->>'tags',','))))
   and (coalesce(p->>'quick','')='' or case p->>'quick' when 'attention' then status='paused' or ai_paused or unresolved_handoffs>0 when 'paused' then status='paused' or ai_paused when 'responded' then response_count>0 when 'booked' then confirmed_bookings>0 else true end)
 ), cohort as materialized (select * from base where first_contact_at>=from_at and first_contact_at<until_at and first_contact_at<=report_at),
 listed as materialized (select * from base where coalesce(first_contact_at,created_at)>=from_at and coalesce(first_contact_at,created_at)<until_at),
 totals as (select count(*) as contacted,count(*) filter(where response_count>0) as responded,count(*) filter(where confirmed_bookings>0) as booked,count(*) filter(where cancelled_bookings>0) as cancelled from cohort where scope='enquiry'),
 activity as (select e.* from sms_private.activity_events e join base b on b.id=e.run_id where e.tenant_id=t and not e.simulated and e.occurred_at>=from_at and e.occurred_at<until_at and e.occurred_at<=report_at)
 select jsonb_build_object('reportingAt',report_at,'timeZone',tz,'from',from_day,'to',end_day,'canManage',manage,'page',pg,'pageSize',page_size,
  'definitions',jsonb_build_object('cohort','First provider-accepted automation message in the selected business-local dates. Subsequent attributed outcomes through reporting time.','conversion','Distinct contacted enquiries with a currently confirmed primary-linked booking. Cancelled, shadow, test and appointment runs excluded.','activity','Actual events in the selected dates; accepted is not delivered. Historical delivery snapshots without a known time are excluded.','workload','Current workload across all dates, using the other selected filters.'),
  'directFunnel',(select jsonb_build_object('contacted',count(*),'responded',count(*) filter(where response_count>0),'booked',count(*) filter(where confirmed_bookings>0),'cancelled',count(*) filter(where cancelled_bookings>0),'responseRate',round(100.0*count(*) filter(where response_count>0)/nullif(count(*),0),1),'conversionRate',round(100.0*count(*) filter(where confirmed_bookings>0)/nullif(count(*),0),1)) from cohort where scope='direct'),'templates',coalesce((select jsonb_agg(jsonb_build_object('id',id,'title',name) order by name) from sms_private.direct_templates where tenant_id=t),'[]'),'funnel',(select to_jsonb(totals)||jsonb_build_object('responseRate',round(100.0*responded/nullif(contacted,0),1),'conversionRate',round(100.0*booked/nullif(contacted,0),1)) from totals),
  'activity',(select jsonb_build_object('accepted',count(*) filter(where kind='automation_accepted'),'delivered',count(*) filter(where kind='message_delivered' and details->>'automation'='true'),'responses',count(*) filter(where kind='customer_response'),'aiSent',count(*) filter(where kind='ai_sent')) from activity),
  'outcomes',jsonb_build_object('linkedBookings',(select coalesce(sum(linked_bookings),0) from cohort),'handoffs',(select coalesce(sum(handoffs),0) from cohort)),
  'workload',(select jsonb_build_object('active',count(*) filter(where status='active'),'quiet',count(*) filter(where status='active' and quiet_until>report_at),'paused',count(*) filter(where status='paused'),'aiPaused',(select count(*) from public.sms_conversations cv where cv.tenant_id=t and cv.ai_paused and (exists(select from base bx where bx.conversation_id=cv.id) or (not exists(select from sms_private.form_runs fr where fr.tenant_id=t and fr.phone=cv.phone) and coalesce(p->>'form','')='' and coalesce(p->>'tags','')='' and coalesce(p->>'status','')='' and coalesce(p->>'search','')=''))),'unresolvedHandoffs',coalesce(sum(unresolved_handoffs),0)+(select count(*) from public.sms_handoffs h where h.tenant_id=t and h.status in ('open','assigned') and not exists(select from sms_private.activity_handoffs ah where ah.tenant_id=t and ah.handoff_id=h.id) and coalesce(p->>'form','')='' and coalesce(p->>'tags','')='' and coalesce(p->>'status','')='' and coalesce(p->>'search','')='')) from base),
  'total',(select count(*) from listed),'rows',coalesce((select jsonb_agg(to_jsonb(x)) from (select * from listed order by coalesce(first_contact_at,created_at) desc,id limit page_size offset (pg-1)*page_size)x),'[]'),
  'forms',coalesce((select jsonb_agg(jsonb_build_object('id',public_id,'title',title) order by title) from public.sms_web_form_definitions where tenant_id=t),'[]'),
  'tags',coalesce((select jsonb_agg(to_jsonb(tag_row) order by name) from sms_private.activity_tags tag_row where tenant_id=t),'[]')) into result;
 return result;
end $function$
;alter function sms_private.record_webhook(text,text,jsonb) rename to record_webhook_before_direct;
create function sms_private.record_webhook(t text,event text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
declare result jsonb;seen boolean;ph text;begin
 if event='inbound' then
  ph:=sms_private.normalize_contact_phone(p->>'From');p:=p||jsonb_build_object('From',ph);
  perform sms_private.coordination_lock(t,ph);
  select exists(select from public.sms_messages where tenant_id=t and sid=p->>'MessageSid') into seen;
 end if;
 result:=sms_private.record_webhook_before_direct(t,event,p);
 if event='inbound' and not seen then
  update sms_private.form_runs set status=case when direct_sequence->>'replyPolicy'='stop' then 'stopped' else 'paused' end,
   reason=case when direct_sequence->>'replyPolicy'='stop' then 'CUSTOMER_REPLY_STOP' else 'CUSTOMER_REPLY_PAUSE' end,
   generation=generation+1,next_run_at=case when direct_sequence->>'replyPolicy'='stop' then null else next_run_at end
  where tenant_id=t and phone=ph and origin='direct' and status='active' and direct_sequence->>'replyPolicy' in ('pause','stop');
 end if;return result;end $$;

-- Normalize public submission input before the existing validation/intake chain.
alter function sms_private.submit_web_form(uuid,jsonb) rename to submit_web_form_before_direct;
create function sms_private.submit_web_form(fid uuid,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$ begin
 if p ? 'phone' then p:=p||jsonb_build_object('phone',sms_private.normalize_contact_phone(p->>'phone'));end if;
 perform sms_private.coordination_lock((select tenant_id from public.sms_web_form_definitions where public_id=fid),p->>'phone');
 return sms_private.submit_web_form_before_direct(fid,p);end $$;

-- Take the phone lock before the form workspace acquires a run row lock.
alter function sms_private.form_workspace(text,text,text,uuid,jsonb) rename to form_workspace_before_direct;
create function sms_private.form_workspace(u text,t text,action text,fid uuid default null,p jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare r sms_private.form_runs;begin
 if action in ('pause','resume','stop') then
  perform sms_private.require_sms_reader(u,t);perform sms_private.require_admin(u);
  select * into r from sms_private.form_runs where tenant_id=t and form_id=fid and id=(p->>'runId')::uuid;
  perform sms_private.coordination_lock(t,r.phone);
  if action='resume' and exists(select from public.sms_contacts where tenant_id=t and phone=r.phone and (enquiry_blocked and r.appointment_at is null or opted_out)) then raise exception 'Contact follow-ups blocked or STOP suppressed';end if;
 end if;return sms_private.form_workspace_before_direct(u,t,action,fid,p);end $$;

-- Restrict all new storage and helpers. Existing wrapper grants are re-established explicitly.
do $$declare tab text;f record;begin
 foreach tab in array array['contact_sources','direct_templates','direct_versions','direct_operations'] loop
 execute format('alter table sms_private.%I enable row level security',tab);
 execute format('revoke all on sms_private.%I from public,anon,authenticated,sms_api,sms_ai,sms_sender,sms_webhook,sms_automation',tab);end loop;
 for f in select p.oid::regprocedure signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='sms_private' and
 (p.proname in ('normalize_contact_phone','contact_integrity','contact_record_source','run_enabled','direct_validate','guard_contact_run','contact_automations','run_quiet_until','record_webhook','submit_web_form','form_workspace') or p.proname like '%_before_direct') loop
 execute format('revoke all on function %s from public,anon,authenticated,sms_api,sms_ai,sms_sender,sms_webhook,sms_automation,sms_form_public',f.signature);end loop;
end $$;
grant execute on function sms_private.contact_automations(text,text,text,jsonb),sms_private.form_workspace(text,text,text,uuid,jsonb) to sms_api;
grant execute on function sms_private.record_webhook(text,text,jsonb) to sms_webhook;
grant execute on function sms_private.submit_web_form(uuid,jsonb) to sms_form_public;

CREATE OR REPLACE FUNCTION sms_private.start_form_run(fid uuid, sid uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare f public.sms_web_form_definitions; result jsonb:=jsonb_build_object('submissionId',sid); row_data jsonb; s sms_private.form_sequences;
  cfg jsonb; step jsonb; due timestamptz; tz text; ctx jsonb; appt timestamptz; p jsonb;
begin
  select * into f from public.sms_web_form_definitions where public_id=fid and enabled and not archived for share;
  if f.public_id is null then raise exception 'Enable the form first'; end if;
  execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and form_public_id=$2 and id=$3',sms_private.web_form_table(f.preset)) into row_data using f.tenant_id,fid,sid;
  if row_data is null then raise exception 'Submission not found'; end if;
  if not coalesce((row_data->>'sms_opt_in')::boolean,false) then return result; end if;
  if exists(select from sms_private.form_runs where tenant_id=f.tenant_id and form_id=fid and submission_id=sid) then return result; end if;
  p:=jsonb_build_object('phone',row_data->>'phone');
  perform sms_private.coordination_lock(f.tenant_id,p->>'phone');

  select * into s from sms_private.form_sequences where tenant_id=f.tenant_id and form_id=fid and enabled;
  if s.published_version is null then return result; end if;
  if exists(select from public.sms_contacts where tenant_id=f.tenant_id and phone=p->>'phone' and (opted_out or not marketing_consent)) then return result; end if;
  select sequence into cfg from sms_private.form_sequence_versions where tenant_id=f.tenant_id and form_id=fid and version=s.published_version;
  if cfg->>'trigger'='submission' and exists(select from public.sms_contacts where tenant_id=f.tenant_id and phone=p->>'phone' and enquiry_blocked) then return result||jsonb_build_object('skipReason','CONTACT_FOLLOWUPS_BLOCKED');end if;
  execute format('select to_jsonb(x) from public.%I x where tenant_id=$1 and id=$2',sms_private.web_form_table(f.preset)) into row_data using f.tenant_id,(result->>'submissionId')::uuid;
  appt:=case when cfg->>'trigger'='appointment' then (row_data->>'appointment_at')::timestamptz end;
  perform pg_advisory_xact_lock(hashtextextended(f.tenant_id||':'||fid||':'||(p->>'phone'),418));
  if exists(select from sms_private.form_runs where tenant_id=f.tenant_id and form_id=fid and phone=p->>'phone'
    and test_sequence is null and status in ('active','paused') and appointment_at is not distinct from appt) then return result; end if;
  select time_zone into tz from public.sms_businesses where tenant_id=f.tenant_id;
  step:=cfg->'steps'->0;
  due:=sms_private.form_due(case when appt is not null then appt-make_interval(hours=>(cfg->>'leadHours')::integer) else now() end,
    (step->>'delayCount')::integer,step->>'delayUnit',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
  ctx:=jsonb_build_object('name',row_data->>'name','first_name',split_part(row_data->>'name',' ',1),'phone',row_data->>'phone','email',row_data->>'email',
    'business_name',(select name from public.sms_businesses where tenant_id=f.tenant_id),'fields',row_data->'details');
  insert into sms_private.form_runs(tenant_id,form_id,version,submission_id,intake_id,phone,context,appointment_at,next_run_at)
    values(f.tenant_id,fid,s.published_version,(result->>'submissionId')::uuid,(row_data->>'automation_intake_id')::uuid,p->>'phone',ctx,appt,due);
  return result;
end $function$
;
CREATE OR REPLACE FUNCTION sms_private.route_automation_intake()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
#variable_conflict use_column
declare typ text; c public.sms_contacts; g public.sms_automation_groups;
  tz text; due_at timestamptz; appointment timestamptz; new_enrollment uuid;
begin
  typ:=case tg_table_name
    when 'sms_automation_contacts' then 'contacts'
    when 'sms_automation_quote_requests' then 'quote_requests'
    when 'sms_automation_bookings' then 'bookings'
    when 'sms_automation_reviews' then 'reviews' end;
  if typ is null then raise exception 'Unknown SMS intake table'; end if;
  if tg_op='UPDATE' and (new.tenant_id<>old.tenant_id or new.id<>old.id) then
    raise exception 'Intake identity cannot change';
  end if;
  if tg_op='UPDATE' and typ='bookings' then
    if new.name is not distinct from old.name and new.phone is not distinct from old.phone
       and new.details is not distinct from old.details and new.status is not distinct from old.status
       and new.appointment_at is not distinct from old.appointment_at then return new; end if;
  end if;
  if tg_op='UPDATE' and old.enrollment_id is not null then
    update public.sms_automation_enrollments set status='cancelled',generation=generation+1,next_run_at=null
      where tenant_id=old.tenant_id and id=old.enrollment_id and status in ('active','paused');
  end if;
  new.enrollment_id:=null; new.skip_reason:=null; new.updated_at:=now();
  begin new.phone:=sms_private.normalize_contact_phone(new.phone);exception when others then new.intake_state:='skipped';new.skip_reason:='INVALID_PHONE';return new;end;
  if tg_op='INSERT' then perform sms_private.coordination_lock(new.tenant_id,new.phone);end if;
  if new.phone is null or new.phone !~ '^[+][1-9][0-9]{7,14}$' then
    new.intake_state:='skipped'; new.skip_reason:='INVALID_PHONE'; return new;
  end if;
  insert into public.sms_contacts(tenant_id,phone,name,email,source)
    values(new.tenant_id,new.phone,coalesce(new.name,''),new.email,'automation_intake')
    on conflict(tenant_id,phone) do update set
      name=case when excluded.name<>'' then excluded.name else sms_contacts.name end,
      email=coalesce(excluded.email,sms_contacts.email),updated_at=now();
  select * into strict c from public.sms_contacts where tenant_id=new.tenant_id and phone=new.phone for update;
  if new.source='web_form' and typ in ('contacts','quote_requests') and new.sms_opt_in is not true then
    new.intake_state:='skipped'; new.skip_reason:='CONSENT_REQUIRED'; return new;
  end if;
  select * into g from public.sms_automation_groups
    where tenant_id=new.tenant_id and fixed_type=typ for update;
  if g.id is not null then
    update public.sms_automation_enrollments set status='cancelled',generation=generation+1,next_run_at=null
      where tenant_id=new.tenant_id and contact_id=c.id and category_id=g.id and status in ('active','paused');
  end if;
  if typ='quote_requests' then
    update public.sms_automation_enrollments e set status='cancelled',generation=generation+1,next_run_at=null
      where e.tenant_id=new.tenant_id and e.contact_id=c.id and e.status in ('active','paused')
        and exists(select 1 from public.sms_automation_groups x where x.tenant_id=e.tenant_id and x.id=e.category_id and x.fixed_type='contacts');
  elsif typ='bookings' then
    if new.status='confirmed' then
      update public.sms_automation_enrollments e set status='cancelled',generation=generation+1,next_run_at=null
        where e.tenant_id=new.tenant_id and e.contact_id=c.id and e.status in ('active','paused')
          and exists(select 1 from public.sms_automation_groups x where x.tenant_id=e.tenant_id and x.id=e.category_id and x.fixed_type in ('contacts','quote_requests'));
    end if;
  elsif typ='reviews' then
    update public.sms_automation_enrollments e set status='cancelled',generation=generation+1,next_run_at=null
      where e.tenant_id=new.tenant_id and e.contact_id=c.id and e.status in ('active','paused')
        and exists(select 1 from public.sms_automation_groups x where x.tenant_id=e.tenant_id and x.id=e.category_id and x.fixed_type='bookings');
  end if;
  if typ='bookings' then
    if new.status='cancelled' then new.intake_state:='cancelled'; return new; end if;
    if new.status='requested' then new.intake_state:='waiting_confirmation'; return new; end if;
    appointment:=new.appointment_at;
    if appointment is null or appointment<=now() then
      new.intake_state:='skipped'; new.skip_reason:='FUTURE_APPOINTMENT_REQUIRED'; return new;
    end if;
  end if;
  if new.source='voice' or (typ='bookings' and new.source='sms_bookings' and exists(select 1 from public.sms_bookings vb where vb.tenant_id=new.tenant_id and vb.id=new.source_record_id and vb.source='voice')) then
    new.intake_state:='skipped'; new.skip_reason:='VOICE_EXPLICIT_SMS_ONLY'; return new;
  end if;
  if c.opted_out then new.intake_state:='skipped'; new.skip_reason:='OPTED_OUT'; return new; end if;
  if typ<>'bookings' and not c.marketing_consent then
    new.intake_state:='skipped'; new.skip_reason:='CONSENT_REQUIRED'; return new;
  end if;
  if g.id is null or not g.active or not exists(select 1 from public.sms_automation_intents i
    where i.tenant_id=new.tenant_id and i.group_id=g.id and btrim(i.intent)<>'') then
    new.intake_state:='skipped'; new.skip_reason:='RULE_UNAVAILABLE'; return new;
  end if;
  select time_zone into tz from public.sms_businesses where tenant_id=new.tenant_id;
  due_at:=sms_private.automation_due(case when typ='bookings' then appointment else now() end,g.rule,tz,true);
  insert into public.sms_automation_enrollments
    (tenant_id,contact_id,category_id,appointment_at,next_run_at,metadata,source_type,source_id)
    values(new.tenant_id,c.id,g.id,appointment,due_at,
      jsonb_build_object('intake_type',typ,'intake_id',new.id,'source',new.source)
      || case when typ='bookings' and new.source_record_id is not null
        then jsonb_build_object('booking_id',new.source_record_id) else '{}'::jsonb end,
      typ,new.id) returning id into new_enrollment;
  new.enrollment_id:=new_enrollment; new.intake_state:='enrolled';
  return new;
end $function$
;

-- Late provider acceptance records delivery without scheduling a stopped run.
CREATE OR REPLACE FUNCTION sms_private.accept_attempt(aid uuid, s text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare j sms_private.jobs; r sms_private.form_runs; p jsonb; cfg jsonb; step jsonb; mi integer; ri integer; due timestamptz; tz text;
begin
  select job.* into strict j from sms_private.attempts a join sms_private.jobs job on job.id=a.job_id where a.id=aid for update of job;
  if j.status='completed' then return; end if;
  perform sms_private.accept_attempt_before_form_sequences(aid,s);
  p:=j.payload->'request';
  if not p ? 'form_run_id' then return; end if;
  select * into r from sms_private.form_runs where tenant_id=j.tenant_id and id=(p->>'form_run_id')::uuid for update;
  if r.id is null or r.send_index<>(p->>'send_index')::integer then return; end if;
  cfg:=sms_private.form_run_sequence(r);
  select time_zone into tz from public.sms_businesses where tenant_id=r.tenant_id;
  mi:=r.message_index; ri:=r.repeat_index+1; step:=cfg->'steps'->mi;
  if ri>=(step->>'sendCount')::integer then
    mi:=mi+1; ri:=0; step:=cfg->'steps'->mi;
    if step is not null then due:=sms_private.form_due(now(),(step->>'delayCount')::integer,step->>'delayUnit',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer); end if;
  else due:=sms_private.form_due(now(),(step->>'intervalCount')::integer,step->>'intervalUnit',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer); end if;
  if due>=r.appointment_at then due:=null; end if;
  update sms_private.form_runs set message_index=mi,repeat_index=ri,send_index=send_index+1,last_sent_at=now(),next_run_at=case when status='stopped' then null else due end,
    generation=generation+1,status=case when status='stopped' then 'stopped' when due is null then 'completed' else status end where id=r.id;
end $function$
;
