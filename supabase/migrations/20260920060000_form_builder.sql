-- Form Builder: all public-schema tables are private to service functions.
do $$ begin
 if not exists(select from pg_roles where rolname='sms_forms') then create role sms_forms nologin; end if;
end $$;
grant usage on schema sms_private to sms_forms;
create table sms_private.form_features(tenant_id text primary key references public.sms_businesses, enabled boolean not null default false);
create table public.sms_forms(
 tenant_id text not null references public.sms_businesses, id uuid not null default gen_random_uuid(),
 public_id uuid not null default gen_random_uuid() unique, name text not null,
 draft jsonb not null, draft_groups jsonb not null default '[]', revision integer not null default 1,
 published_version uuid, created_by text not null, updated_at timestamptz not null default now(),
 primary key(tenant_id,id)
);
create table public.sms_form_versions(
 tenant_id text not null, id uuid not null default gen_random_uuid(), form_id uuid not null,
 definition jsonb not null, published_by text not null, created_at timestamptz not null default now(),
 primary key(tenant_id,id), unique(tenant_id,form_id,id), foreign key(tenant_id,form_id) references public.sms_forms
);
alter table public.sms_forms add foreign key(tenant_id,id,published_version) references public.sms_form_versions(tenant_id,form_id,id);
create table public.sms_form_submissions(
 tenant_id text not null, id uuid not null default gen_random_uuid(), form_id uuid not null, version_id uuid not null,
 idempotency_key text not null check(length(idempotency_key) between 8 and 100), answers jsonb not null, mapped jsonb not null,
 group_id text not null, consent_disclosure text not null, source_origin text,
 status text not null default 'queued' check(status in ('queued','retry','enrolled','already_enrolled','blocked','failed')),
 reason text, enrollment_id uuid, attempts integer not null default 0, available_at timestamptz not null default now(),
 created_at timestamptz not null default now(), processed_at timestamptz,
 primary key(tenant_id,id), unique(tenant_id,form_id,idempotency_key),
 foreign key(tenant_id,form_id,version_id) references public.sms_form_versions(tenant_id,form_id,id)
);
create index sms_form_submissions_due on public.sms_form_submissions(available_at) where status in ('queued','retry');
create table public.sms_form_agent_sessions(
 tenant_id text not null, id uuid not null default gen_random_uuid(), form_id uuid not null, user_id text not null,
 remote_id text, status text not null default 'idle', turn_count integer not null default 0, tool_count integer not null default 0,
 authorized_until timestamptz, token_expires_at timestamptz not null default now()+interval '1 day',
 usage jsonb not null default '{}', updated_at timestamptz not null default now(),
 primary key(tenant_id,id), unique(tenant_id,form_id,user_id), foreign key(tenant_id,form_id) references public.sms_forms
);
create table public.sms_form_audit(
 tenant_id text not null, id bigint generated always as identity, form_id uuid not null, actor text not null,
 event text not null, detail jsonb not null default '{}', created_at timestamptz not null default now(),
 primary key(tenant_id,id), foreign key(tenant_id,form_id) references public.sms_forms
);
create table sms_private.form_rate_buckets(bucket text primary key, count integer not null, expires_at timestamptz not null);
do $$ declare t text; begin
 foreach t in array array['sms_forms','sms_form_versions','sms_form_submissions','sms_form_agent_sessions','sms_form_audit'] loop
  execute format('alter table public.%I enable row level security',t);
  execute format('revoke all on public.%I from public,anon,authenticated',t);
 end loop;
end $$;

create function sms_private.form_access(u text,t text) returns void language plpgsql security definer set search_path='' as $$
begin
 if not (exists(select from sms_private.admins where clerk_user_id=u) or exists(select from public.sms_business_memberships where tenant_id=t and clerk_user_id=u and role='admin')) then
  raise exception 'Form administrator access required' using errcode='42501';
 end if;
 if not exists(select from sms_private.form_features where tenant_id=t and enabled) then raise exception 'Form Builder is not enabled for this business' using errcode='42501'; end if;
end $$;

create function sms_private.forms_admin(u text,t text,op text,p jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.sms_forms; v uuid; g jsonb; step jsonb; n integer; gid text; actual bigint; definition jsonb; sess public.sms_form_agent_sessions; result jsonb;
begin
 perform sms_private.form_access(u,t);
 if op='list' then
  return jsonb_build_object('forms',coalesce((select jsonb_agg(to_jsonb(x) order by x.updated_at desc) from
   (select a.id,a.public_id,a.name,a.revision,a.published_version,a.updated_at,(select count(*) from public.sms_form_submissions s where s.tenant_id=t and s.form_id=a.id) as submission_count from public.sms_forms a where a.tenant_id=t) x),'[]'));
 elsif op='catalog' then
  return jsonb_build_object('business',(select jsonb_build_object('id',tenant_id,'name',name,'timeZone',time_zone,'profile',profile) from public.sms_businesses where tenant_id=t),
   'groups',coalesce((select jsonb_agg(to_jsonb(a) order by a.name) from public.sms_automation_groups a where a.tenant_id=t),'[]'));
 elsif op='create' then
  insert into public.sms_forms(tenant_id,name,draft,created_by) values(t,p->'definition'->>'title',p->'definition',u) returning * into f;
 else
  select * into f from public.sms_forms where tenant_id=t and id=(p->>'id')::uuid for update;
  if not found then raise exception 'Form not found' using errcode='P0002'; end if;
  if op='get' then return to_jsonb(f);
  elsif op='submissions' then
   return jsonb_build_object('submissions',coalesce((select jsonb_agg(to_jsonb(s)) from (select * from public.sms_form_submissions where tenant_id=t and form_id=f.id order by created_at desc limit 100) s),'[]'),
    'metrics',(select jsonb_build_object('pending',count(*) filter(where status in ('queued','retry')),'failed',count(*) filter(where status='failed'),'blocked',count(*) filter(where status='blocked'),'oldestPendingAt',min(created_at) filter(where status in ('queued','retry'))) from public.sms_form_submissions where tenant_id=t and form_id=f.id));
  elsif op='audit' then
   return jsonb_build_object('events',coalesce((select jsonb_agg(to_jsonb(a) order by a.id) from (select * from public.sms_form_audit where tenant_id=t and form_id=f.id and id>coalesce((p->>'after')::bigint,0) order by id limit 100) a),'[]'));
  elsif op='retry' then
   update public.sms_form_submissions set status='queued',reason=null,attempts=0,available_at=now() where tenant_id=t and form_id=f.id and id=(p->>'submissionId')::uuid and status='failed';
   if not found then raise exception 'Only failed submissions can be retried'; end if;
  elsif op='session' then
   insert into public.sms_form_agent_sessions(tenant_id,form_id,user_id) values(t,f.id,u) on conflict(tenant_id,form_id,user_id) do nothing;
   select * into sess from public.sms_form_agent_sessions where tenant_id=t and form_id=f.id and user_id=u;
   return to_jsonb(sess);
  elsif op='begin_turn' then
   select * into strict sess from public.sms_form_agent_sessions where tenant_id=t and form_id=f.id and user_id=u for update;
   if sess.authorized_until>now() then raise exception 'An agent turn is already running' using errcode='23505'; end if;
   if sess.turn_count>=50 then raise exception 'This editing session has reached its 50-turn limit'; end if;
   if sess.token_expires_at<=now() then
    update public.sms_form_agent_sessions set remote_id=null,token_expires_at=now()+interval '1 day' where tenant_id=t and id=sess.id;
   end if;
   update public.sms_form_agent_sessions set status='running',turn_count=turn_count+1,tool_count=0,authorized_until=now()+interval '3 minutes',updated_at=now() where tenant_id=t and id=sess.id returning * into sess;
   insert into public.sms_form_audit(tenant_id,form_id,actor,event,detail) values(t,f.id,u,'user_message',jsonb_build_object('text',left(p->>'message',6000)));
   return to_jsonb(sess);
  elsif op='remote_session' then
   update public.sms_form_agent_sessions set remote_id=p->>'remoteId' where tenant_id=t and form_id=f.id and user_id=u;
   return jsonb_build_object('ok',true);
  elsif op='agent_event' then
   insert into public.sms_form_audit(tenant_id,form_id,actor,event,detail) values(t,f.id,u,p->>'event',coalesce(p->'detail','{}'));
   if p->>'event' in ('agent_completed','agent_failed') then
    update public.sms_form_agent_sessions set status=case when p->>'event'='agent_completed' then 'idle' else 'failed' end,authorized_until=null,usage=coalesce(p->'detail'->'usage',usage),updated_at=now() where tenant_id=t and form_id=f.id and user_id=u;
   end if;
   return jsonb_build_object('ok',true);
  else
   if (p->>'revision')::integer is distinct from f.revision then raise exception 'Draft changed. Reload before saving or publishing.' using errcode='23505'; end if;
   if op='save' then
    update public.sms_forms set draft=p->'definition',name=p->'definition'->>'title',draft_groups=coalesce(p->'draftGroups',f.draft_groups),revision=revision+1,updated_at=now() where tenant_id=t and id=f.id returning * into f;
   elsif op='publish' then
    definition=f.draft;
    for g in select value from jsonb_array_elements(f.draft_groups) loop
     if exists(select from public.sms_automation_groups where tenant_id=t and id=g->>'id') then raise exception 'Draft group ID already exists' using errcode='23505'; end if;
     insert into public.sms_automation_groups(tenant_id,id,name,description,kind,rule) values(t,g->>'id',g->>'name',coalesce(g->>'description',''),'custom',g->'rule');
     n:=0;
     for step in select value from jsonb_array_elements(g->'rule'->'steps') loop
      insert into public.sms_automation_steps values(t,g->>'id',n,step->>'template',(step->>'delayCount')::integer,step->>'delayUnit');n:=n+1;
     end loop;
     definition=jsonb_set(definition,array['routing','reviewedVersions',g->>'id'],'1');
    end loop;
    for gid in select definition->'routing'->>'defaultGroupId' union select value->>'groupId' from jsonb_array_elements(definition->'routing'->'rules') loop
     select version into actual from public.sms_automation_groups where tenant_id=t and id=gid and active and kind<>'reminder' for share;
     if not found then raise exception 'Routing requires an active lead or quote automation'; end if;
     if actual is distinct from (definition->'routing'->'reviewedVersions'->>gid)::bigint then raise exception 'Automation changed. Review its latest version before publishing.' using errcode='23505'; end if;
    end loop;
    insert into public.sms_form_versions(tenant_id,form_id,definition,published_by) values(t,f.id,definition,u) returning id into v;
    update public.sms_forms set published_version=v,draft=definition,draft_groups='[]',revision=revision+1,updated_at=now() where tenant_id=t and id=f.id returning * into f;
   elsif op='unpublish' then
    update public.sms_forms set published_version=null,revision=revision+1,updated_at=now() where tenant_id=t and id=f.id returning * into f;
   else raise exception 'Unknown form operation'; end if;
  end if;
 end if;
 insert into public.sms_form_audit(tenant_id,form_id,actor,event,detail) values(t,f.id,u,op,jsonb_build_object('revision',f.revision));
 return to_jsonb(f);
end $$;

create function sms_private.forms_agent(t text,u text,fid uuid,sid uuid,op text,p jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.sms_form_agent_sessions; begin
 perform sms_private.form_access(u,t);
 select * into s from public.sms_form_agent_sessions where tenant_id=t and id=sid and form_id=fid and user_id=u for update;
 if not found or s.authorized_until is null or s.authorized_until<=now() or s.token_expires_at<=now() then raise exception 'Agent authorization expired' using errcode='42501'; end if;
 if op='authorize' then return jsonb_build_object('ok',true); end if;
 if op='result' then
  insert into public.sms_form_audit(tenant_id,form_id,actor,event,detail) values(t,fid,u,'tool_result',p);
  return jsonb_build_object('ok',true);
 end if;
 if op<>'tool' or s.tool_count>=30 then raise exception 'Agent tool budget exhausted' using errcode='42501'; end if;
 update public.sms_form_agent_sessions set tool_count=tool_count+1 where tenant_id=t and id=sid;
 insert into public.sms_form_audit(tenant_id,form_id,actor,event,detail) values(t,fid,u,'tool',jsonb_build_object('name',p->>'name'));
 return jsonb_build_object('ok',true);
end $$;

create function sms_private.forms_rate(k text,maximum integer,seconds integer) returns boolean language plpgsql security definer set search_path='' as $$
declare used integer; begin
 delete from sms_private.form_rate_buckets where expires_at<now()-interval '1 minute';
 insert into sms_private.form_rate_buckets values(k,1,now()+make_interval(secs=>seconds))
 on conflict(bucket) do update set count=case when form_rate_buckets.expires_at<=now() then 1 else form_rate_buckets.count+1 end,
 expires_at=case when form_rate_buckets.expires_at<=now() then now()+make_interval(secs=>seconds) else form_rate_buckets.expires_at end returning count into used;
 return used<=maximum;
end $$;

create function sms_private.forms_public(pid uuid,op text,p jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
declare f public.sms_forms; v public.sms_form_versions; s public.sms_form_submissions; begin
 select a.* into f from public.sms_forms a join sms_private.form_features b using(tenant_id) where public_id=pid and published_version is not null and b.enabled for share of a;
 if not found then raise exception 'Form unavailable' using errcode='P0002'; end if;
 select * into strict v from public.sms_form_versions where tenant_id=f.tenant_id and id=f.published_version;
 if op='get' then return jsonb_build_object('tenantId',f.tenant_id,'formId',f.id,'versionId',v.id,'definition',v.definition); end if;
 if op<>'submit' then raise exception 'Unknown public form operation'; end if;
 select * into s from public.sms_form_submissions where tenant_id=f.tenant_id and form_id=f.id and idempotency_key=p->>'idempotencyKey';
 if found then
  if s.answers<>p->'answers' or s.version_id<>(p->>'versionId')::uuid then raise exception 'Idempotency key conflicts with another submission' using errcode='23505'; end if;
  return jsonb_build_object('id',s.id,'accepted',true);
 end if;
 if v.id<>(p->>'versionId')::uuid then raise exception 'Form changed. Reload and submit again.' using errcode='23505'; end if;
 if not (p->>'groupId'=v.definition->'routing'->>'defaultGroupId' or exists(select from jsonb_array_elements(v.definition->'routing'->'rules') r where r->>'groupId'=p->>'groupId')) then raise exception 'Invalid routing target'; end if;
 insert into public.sms_form_submissions(tenant_id,form_id,version_id,idempotency_key,answers,mapped,group_id,consent_disclosure,source_origin)
 values(f.tenant_id,f.id,v.id,p->>'idempotencyKey',p->'answers',p->'mapped',p->>'groupId',p->>'disclosure',p->>'origin') on conflict do nothing returning * into s;
 if not found then
  select * into strict s from public.sms_form_submissions where tenant_id=f.tenant_id and form_id=f.id and idempotency_key=p->>'idempotencyKey';
  if s.answers<>p->'answers' or s.version_id<>v.id then raise exception 'Idempotency key conflicts' using errcode='23505'; end if;
 end if;
 return jsonb_build_object('id',s.id,'accepted',true);
end $$;

-- One job is processed entirely in a transaction. A crash rolls back contact,
-- consent and enrollment changes together; multiple service instances can poll.
create function sms_private.forms_process() returns jsonb language plpgsql security definer set search_path='' as $$
declare s public.sms_form_submissions; c public.sms_contacts; g public.sms_automation_groups; v public.sms_form_versions; eid uuid; blocked text; err text; initial_body text; kv record; automation_due timestamptz;
begin
 select * into s from public.sms_form_submissions where status in ('queued','retry') and available_at<=now() order by available_at for update skip locked limit 1;
 if not found then return null; end if;
 begin
  insert into public.sms_contacts(tenant_id,phone,name,email,source,metadata) values(s.tenant_id,s.mapped->>'phone',coalesce(s.mapped->>'name',''),s.mapped->>'email','web_form',jsonb_build_object('form_id',s.form_id))
  on conflict(tenant_id,phone) do update set name=case when sms_contacts.name='' then excluded.name else sms_contacts.name end,email=coalesce(sms_contacts.email,excluded.email),updated_at=now();
  select * into strict c from public.sms_contacts where tenant_id=s.tenant_id and phone=s.mapped->>'phone' for update;
  if s.mapped->'consent'='true'::jsonb then
   insert into public.sms_consent_events(tenant_id,contact_id,consent,source,evidence) values(s.tenant_id,c.id,true,'web_form',jsonb_build_object('submissionId',s.id,'formId',s.form_id,'versionId',s.version_id,'disclosure',s.consent_disclosure,'origin',s.source_origin,'recordedAt',s.created_at)::text);
   if not c.opted_out then update public.sms_contacts set marketing_consent=true where tenant_id=s.tenant_id and id=c.id; end if;
  end if;
  select * into g from public.sms_automation_groups where tenant_id=s.tenant_id and id=s.group_id for share;
  blocked:=case when c.opted_out then 'STOP_SUPPRESSED' when s.mapped->'consent' is distinct from 'true'::jsonb then 'CONSENT_REQUIRED' when g.id is null or not g.active then 'AUTOMATION_UNAVAILABLE' when g.kind='reminder' then 'BOOKING_REQUIRED' end;
  if blocked is not null then
   update public.sms_form_submissions set status='blocked',reason=blocked,processed_at=now() where tenant_id=s.tenant_id and id=s.id;
  else
   select id into eid from public.sms_automation_enrollments where tenant_id=s.tenant_id and contact_id=c.id and category_id=g.id and status in ('active','paused') limit 1;
   if found then
   update public.sms_form_submissions set status='already_enrolled',enrollment_id=eid,processed_at=now() where tenant_id=s.tenant_id and id=s.id;
   else
    automation_due:=now();
    select * into strict v from public.sms_form_versions where tenant_id=s.tenant_id and id=s.version_id;
    if coalesce((v.definition->'instantSms'->>'enabled')::boolean,false) then
     initial_body:=v.definition->'instantSms'->>'body';
     for kv in select key,value from jsonb_each_text(s.mapped) loop
      initial_body:=replace(initial_body,'{{'||kv.key||'}}',kv.value);
     end loop;
     perform sms_private.outbox(s.tenant_id,'form-instant:'||s.id,jsonb_build_object('phone',c.phone,'body',initial_body,'purpose','marketing','category_id',g.id,'form_submission_id',s.id));
     automation_due:=now()+interval '1 minute';
    end if;
    insert into public.sms_automation_enrollments(tenant_id,contact_id,category_id,next_run_at,metadata)
    values(s.tenant_id,c.id,g.id,automation_due,(s.mapped-'consent'-'phone'-'email')||jsonb_build_object('source','web_form','form_id',s.form_id,'form_version_id',s.version_id,'submission_id',s.id,'form_answers',s.answers,'instant_sms',coalesce((v.definition->'instantSms'->>'enabled')::boolean,false))) returning id into eid;
    update public.sms_form_submissions set status='enrolled',enrollment_id=eid,processed_at=now() where tenant_id=s.tenant_id and id=s.id;
   end if;
  end if;
 exception when others then
  get stacked diagnostics err=returned_sqlstate;
  update public.sms_form_submissions set attempts=attempts+1,status=case when attempts>=4 then 'failed' else 'retry' end,reason='PROCESSING_'||err,available_at=now()+make_interval(secs=>least(300,5*(s.attempts+1)*(s.attempts+1))) where tenant_id=s.tenant_id and id=s.id;
 end;
 return (select jsonb_build_object('id',id,'status',status,'reason',reason,'delaySeconds',extract(epoch from now()-created_at)) from public.sms_form_submissions where tenant_id=s.tenant_id and id=s.id);
end $$;

revoke all on function sms_private.form_access(text,text),sms_private.forms_admin(text,text,text,jsonb),sms_private.forms_agent(text,text,uuid,uuid,text,jsonb),sms_private.forms_rate(text,integer,integer),sms_private.forms_public(uuid,text,jsonb),sms_private.forms_process() from public,anon,authenticated;
grant execute on function sms_private.forms_admin(text,text,text,jsonb),sms_private.forms_agent(text,text,uuid,uuid,text,jsonb),sms_private.forms_rate(text,integer,integer),sms_private.forms_public(uuid,text,jsonb),sms_private.forms_process() to sms_forms;
