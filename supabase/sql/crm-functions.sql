-- Included in the generated migration by scripts/assemble-migration.js.
create function sms_private.api_action(u text,t text,action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare c public.sms_contacts; g public.sms_automation_groups; eid uuid; r jsonb; n int; v bigint; begin
 perform sms_private.require_admin(u);
 if (select count(*) from sms_private.audit where actor=u and created_at>now()-interval '1 minute')>=120 then raise exception 'Too many actions; retry shortly'; end if;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(case when action='create_business' then null else t end,u,action,jsonb_build_object('record_id',p->>'id'));
 if action='create_business' then
   if not exists(select from pg_timezone_names where name=p->>'timeZone') then raise exception 'Invalid timezone'; end if;
   insert into public.sms_businesses(tenant_id,name,time_zone) values(p->>'id',p->>'name',p->>'timeZone');
   insert into sms_private.providers(tenant_id) values(p->>'id');
   insert into public.sms_business_memberships(tenant_id,clerk_user_id) values(p->>'id',u);
   return jsonb_build_object('id',p->>'id','name',p->>'name','timeZone',p->>'timeZone','status','pending');
 end if;
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 if action='contact' then
   insert into public.sms_contacts(tenant_id,phone,name,email,source,metadata)
   values(t,p->>'phone',coalesce(p->>'name',''),p->>'email',coalesce(p->>'source','contact'),coalesce(p->'metadata','{}'))
   on conflict(tenant_id,phone) do update set name=excluded.name,email=excluded.email,source=excluded.source,metadata=excluded.metadata,updated_at=now() returning * into c;
   return to_jsonb(c);
 elsif action='consent' then
   if coalesce(length(p->>'evidence'),0)=0 then raise exception 'Consent evidence required'; end if;
   select * into strict c from public.sms_contacts where tenant_id=t and phone=p->>'phone' for update;
   update public.sms_contacts set opted_out=not (p->>'consent')::boolean,marketing_consent=(p->>'consent')::boolean,generation=generation+1,updated_at=now() where tenant_id=t and id=c.id;
   insert into public.sms_consent_events(tenant_id,contact_id,consent,source,evidence) values(t,c.id,(p->>'consent')::boolean,'admin',p->>'evidence');
   if not (p->>'consent')::boolean then perform sms_private.cancel_contact(t,c.id); end if;
   return jsonb_build_object('ok',true);
 elsif action='send' then
   return sms_private.outbox(t,p->>'idempotencyKey',p-'idempotencyKey');
 elsif action='group' then
   if jsonb_array_length(p->'rule'->'steps') not between 1 and 30 then raise exception '1-30 steps required'; end if;
   insert into public.sms_automation_groups(tenant_id,id,name,description,kind,rule,active)
   values(t,p->>'id',p->>'name',coalesce(p->>'description',''),coalesce(p->>'kind','custom'),p->'rule',coalesce((p->>'active')::boolean,true))
   on conflict(tenant_id,id) do update set name=excluded.name,description=excluded.description,rule=excluded.rule,active=excluded.active,version=sms_automation_groups.version+1,updated_at=now() returning * into g;
   delete from public.sms_automation_steps where tenant_id=t and group_id=g.id;
   n:=0;
   for r in select value from jsonb_array_elements(p->'rule'->'steps') loop
     insert into public.sms_automation_steps values(t,g.id,n,r->>'template',(r->>'delayCount')::integer,r->>'delayUnit'); n:=n+1;
   end loop;
   update public.sms_automation_enrollments set generation=generation+1,next_run_at=now() where tenant_id=t and category_id=g.id and status='active';
   return to_jsonb(g);
 elsif action='delete_group' then
   update public.sms_automation_groups set active=false,version=version+1 where tenant_id=t and id=p->>'id';
   update public.sms_automation_enrollments set status='cancelled',generation=generation+1 where tenant_id=t and category_id=p->>'id' and status in ('active','paused');
   return jsonb_build_object('ok',true);
 elsif action='ai_settings' then
   insert into public.sms_ai_settings(tenant_id,group_id,enabled,instructions) values(t,p->>'id',coalesce((p->>'enabled')::boolean,false),coalesce(p->>'instructions',''))
   on conflict(tenant_id,group_id) do update set enabled=excluded.enabled,instructions=excluded.instructions,updated_at=now();
   update public.sms_thread_contacts set generation=generation+1 where tenant_id=t;
   return jsonb_build_object('ok',true);
 elsif action='enroll' then
   select * into strict c from public.sms_contacts where tenant_id=t and phone=p->>'phone' for update;
   select * into strict g from public.sms_automation_groups where tenant_id=t and id=p->>'categoryId' and active;
   if c.opted_out or (g.kind<>'reminder' and not c.marketing_consent) then raise exception 'Consent required' using errcode='42501'; end if;
   if g.kind='reminder' and ((p->>'appointment_at') is null or (p->>'appointment_at')::timestamptz<=now()) then raise exception 'Future appointment required'; end if;
   update public.sms_automation_enrollments set status='cancelled',generation=generation+1 where tenant_id=t and contact_id=c.id and category_id=g.id and status in ('active','paused');
   insert into public.sms_automation_enrollments(tenant_id,contact_id,category_id,next_run_at,appointment_at,metadata)
   values(t,c.id,g.id,now(),(p->>'appointment_at')::timestamptz,coalesce(p->'metadata','{}')) returning id into eid;
   return jsonb_build_object('id',eid,'status','active');
 elsif action='unenroll' then
   update public.sms_automation_enrollments set status='cancelled',generation=generation+1 where tenant_id=t
     and contact_id=(select id from public.sms_contacts where tenant_id=t and phone=p->>'phone') and category_id=p->>'categoryId' and status in ('active','paused');
   return jsonb_build_object('ok',true);
 elsif action in ('read','pause','resume') then
   update public.sms_thread_contacts set unread_count=case when action='read' then 0 else unread_count end,
     ai_paused=case when action='pause' then true when action='resume' then false else ai_paused end,
     generation=generation+case when action='read' then 0 else 1 end where tenant_id=t and phone=p->>'phone';
   return jsonb_build_object('ok',true);
 elsif action='retry_job' then
   select to_jsonb(j) into strict r from sms_private.jobs j where tenant_id=t and id=(p->>'id')::uuid and status='failed' for update;
   update sms_private.jobs set status='queued',attempts=0,available_at=now(),lease_token=null,leased_until=null,
     queue_msg_id=(select pgmq.send(r->>'queue',jsonb_build_object('job_id',r->>'id'),0)) where id=(r->>'id')::uuid;
   return jsonb_build_object('ok',true);
 elsif action='provision' then
   return jsonb_build_object('jobId',sms_private.enqueue(t,'provisioning_jobs','twilio-bootstrap:v1',
     jsonb_build_object('name',(select name from public.sms_businesses where tenant_id=t),'operation','bootstrap')),'status','queued');
 end if;
 raise exception 'Unknown operation';
end $$;

create or replace function sms_private.configure_ai(u text,t text,gid text,is_enabled boolean,instructions text,is_default boolean) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare result public.sms_ai_settings; begin
 perform sms_private.require_admin(u);
 if not exists(select from public.sms_automation_groups where tenant_id=t and id=gid) then raise exception 'Unknown automation group'; end if;
 if length(coalesce(instructions,''))>6000 then raise exception 'AI instructions cannot exceed 6000 characters'; end if;
 is_default:=coalesce(is_default,false) and coalesce(is_enabled,false);
 if is_default then update public.sms_ai_settings set default_for_inbound=false,updated_at=now() where tenant_id=t and group_id<>gid and default_for_inbound; end if;
 insert into public.sms_ai_settings(tenant_id,group_id,enabled,instructions,default_for_inbound)
 values(t,gid,coalesce(is_enabled,false),coalesce(instructions,''),is_default)
 on conflict(tenant_id,group_id) do update set enabled=excluded.enabled,instructions=excluded.instructions,default_for_inbound=excluded.default_for_inbound,updated_at=now()
 returning * into result;
 update public.sms_thread_contacts set generation=generation+1 where tenant_id=t;
 return to_jsonb(result);
end $$;

create function sms_private.cancel_contact(t text,cid uuid) returns void language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare ph text; begin
 select phone into strict ph from public.sms_contacts where tenant_id=t and id=cid;
 update public.sms_automation_enrollments set status='cancelled',generation=generation+1 where tenant_id=t and contact_id=cid and status in ('active','paused');
 update public.sms_thread_contacts set generation=generation+1 where tenant_id=t and phone=ph;
 update sms_private.jobs set status='cancelled',updated_at=now() where tenant_id=t and status in ('queued','retry','processing')
   and (payload->'request'->>'phone'=ph or payload->>'phone'=ph);
 update public.sms_messages set status='cancelled',updated_at=now() where tenant_id=t and contact_phone=ph and direction='outbound' and status='queued';
end $$;

create function sms_private.api_read(u text,t text,resource text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column

declare rows jsonb; total bigint; tbl text; clause text:=''; extra text:=''; page integer; size integer; begin
 perform sms_private.require_admin(u);
 if resource='businesses' then
   return jsonb_build_object('rows',coalesce((select jsonb_agg(to_jsonb(b)) from public.sms_businesses b),'[]'));
 end if;
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 if resource='overview' then
   return jsonb_build_object('total',(select count(*) from public.sms_messages where tenant_id=t),
     'contactCount',(select count(*) from public.sms_contacts where tenant_id=t),
     'conversationCount',(select count(*) from public.sms_thread_contacts where tenant_id=t),
     'optedOutTotal',(select count(*) from public.sms_contacts where tenant_id=t and opted_out),
     'counts',coalesce((select jsonb_object_agg(status,n) from (select status,count(*) n from public.sms_messages where tenant_id=t group by status)s),'{}'),
     'byCategory',coalesce((select jsonb_agg(jsonb_build_object('id',category_id,'total',n)) from (select category_id,count(*) n from public.sms_messages where tenant_id=t and category_id is not null group by category_id)s),'[]'));
 elsif resource='operations' then
   return jsonb_build_object('jobs',coalesce((select jsonb_agg(s) from (select queue,status,count(*) count,min(created_at) oldest from sms_private.jobs where tenant_id=t and status not in ('completed','cancelled') group by queue,status)s),'[]'),
     'workers',coalesce((select jsonb_agg(h) from sms_private.heartbeats h),'[]'),
     'scheduler',(select to_jsonb(r) from sms_private.runtime r),
     'problems',coalesce((select jsonb_agg(s) from (select id,queue,status,error_code,created_at from sms_private.jobs where tenant_id=t and status in ('failed','submission_unknown') order by created_at desc limit 50)s),'[]'));
 elsif resource='provisioning' then
   return coalesce((select jsonb_build_object(
     'state',pr.provisioning_state,
     'accountSid',pr.account_sid,
     'accountFriendlyName',pr.account_friendly_name,
     'messagingServiceSid',pr.messaging_service_sid,
     'phoneNumber',pr.from_number,
     'phoneNumberSid',pr.phone_number_sid,
     'registrationStatus',pr.registration_status,
     'readyForNumber',pr.account_sid is not null and pr.messaging_service_sid is not null,
     'sendingEnabled',b.sending_enabled,
     'businessStatus',b.status,
     'updatedAt',pr.updated_at)
     from sms_private.providers pr join public.sms_businesses b using(tenant_id) where pr.tenant_id=t),
     jsonb_build_object('state','pending','sendingEnabled',false,'businessStatus','pending'));
 end if;
 tbl:=case resource when 'contacts' then 'sms_contacts' when 'threads' then 'sms_thread_contacts' when 'messages' then 'sms_messages'
 when 'groups' then 'sms_automation_groups' when 'steps' then 'sms_automation_steps' when 'enrollments' then 'sms_automation_enrollments'
 when 'calls' then 'sms_voice_conversations' when 'ai_settings' then 'sms_ai_settings' when 'bookings' then 'sms_bookings' when 'quotes' then 'sms_quotes' end;
 if tbl is null then raise exception 'Unknown resource'; end if;
 page:=greatest(1,least(100000,coalesce((p->>'page')::integer,1))); size:=greatest(1,least(250,coalesce((p->>'pageSize')::integer,50)));
 if resource in ('contacts','threads','calls') then
   if p->>'phone' is not null then clause:=clause||format(' and phone=%L',p->>'phone'); end if;
   if p->>'q' is not null then clause:=clause||format(' and (phone ilike %L%s)','%'||(p->>'q')||'%',case when resource<>'calls' then format(' or name ilike %L','%'||(p->>'q')||'%') else '' end); end if;
 end if;
 if resource='contacts' then
   if p->>'source' is not null then clause:=clause||format(' and source=%L',p->>'source'); end if;
   if p->>'consented'='1' then clause:=clause||' and marketing_consent and not opted_out'; end if;
   if p->>'opted_out'='1' then clause:=clause||' and opted_out'; end if;
 end if;
 if resource='threads' and p->>'unread'='1' then clause:=clause||' and unread_count>0'; end if;
 if resource='messages' then
   if p->>'phone' is not null then clause:=clause||format(' and contact_phone=%L',p->>'phone'); end if;
   if p->>'status' is not null then clause:=clause||format(' and status=%L',p->>'status'); end if;
   if p->>'direction' is not null then clause:=clause||format(' and direction=%L',p->>'direction'); end if;
 end if;
 if resource in ('messages','enrollments') and p->>'category' is not null then clause:=clause||format(' and category_id=%L',p->>'category'); end if;
 if resource='steps' then clause:=clause||format(' and group_id=%L',p->>'id'); end if;
 if resource='groups' and p->>'id' is not null then clause:=clause||format(' and id=%L',p->>'id'); end if;
 if resource='contacts' then extra:=', (select coalesce(jsonb_agg(category_id),''[]'') from public.sms_automation_enrollments e where e.tenant_id=base.tenant_id and e.contact_id=base.id and e.status=''active'') as enrollments'; end if;
 if resource='enrollments' then extra:=', (select phone from public.sms_contacts c where c.tenant_id=base.tenant_id and c.id=base.contact_id) as phone, (select name from public.sms_contacts c where c.tenant_id=base.tenant_id and c.id=base.contact_id) as name'; end if;
 if resource='messages' then extra:=', (select coalesce(jsonb_agg(event),''[]'') from (select status,created_at as at,error_code from public.sms_message_events e where e.tenant_id=base.tenant_id and e.message_id=base.id order by created_at desc limit 100)event) as status_history'; end if;
 execute format('select count(*) from public.%I where tenant_id=$1%s',tbl,clause) into total using t;
 execute format('select coalesce(jsonb_agg(x),''[]'') from (select base.* %s from public.%I base where tenant_id=$1%s order by %s limit $2 offset $3)x',extra,tbl,clause,
 case when resource='steps' then 'step_index' when resource='threads' then 'last_message_at desc nulls last,phone' when resource='ai_settings' then 'group_id' when resource='calls' then 'started_at desc,conversation_id' when resource='bookings' then 'appointment_at desc,id' else 'created_at desc,id' end)
 into rows using t,size,(page-1)*size;
 return jsonb_build_object('rows',rows,'total',total,'page',page,'pageSize',size,'totalPages',greatest(1,ceil(total::numeric/size)),'configured',true);
end $$;

create function sms_private.provider_setup(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
begin
 perform sms_private.require_admin(u);
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 return coalesce((select jsonb_build_object(
   'state',p.provisioning_state,
   'accountSid',p.account_sid,
   'accountFriendlyName',p.account_friendly_name,
   'messagingServiceSid',p.messaging_service_sid,
   'phoneNumber',p.from_number,
   'phoneNumberSid',p.phone_number_sid,
   'registrationStatus',p.registration_status,
   'details',p.setup_details,
   'detailsComplete',p.setup_completed_at is not null,
   'readyForNumber',p.account_sid is not null and p.messaging_service_sid is not null,
   'sendingEnabled',b.sending_enabled,
   'businessStatus',b.status,
   'updatedAt',p.updated_at)
   from sms_private.providers p join public.sms_businesses b using(tenant_id) where p.tenant_id=t),
   jsonb_build_object('state','pending','sendingEnabled',false,'businessStatus','pending'));
end $$;

create function sms_private.save_provider_setup(u text,t text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare details jsonb; samples jsonb; sender text; brand text;
begin
 perform sms_private.require_admin(u);
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 sender:=input->>'senderType'; brand:=input->>'brandType'; samples:=input->'sampleMessages';
 if sender not in ('local_a2p','toll_free') then raise exception 'Choose a sender type'; end if;
 if sender='local_a2p' and brand not in ('standard','sole_proprietor') then raise exception 'Choose a brand type'; end if;
 if length(trim(coalesce(input->>'legalBusinessName',''))) not between 1 and 160 then raise exception 'Legal business name is required'; end if;
 if coalesce(input->>'notificationEmail','') !~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' then raise exception 'Valid notification email is required'; end if;
 if coalesce(input->>'websiteUrl','') !~* '^https://[^[:space:]]+$' then raise exception 'A public HTTPS website is required'; end if;
 if sender='local_a2p' and coalesce(input->>'areaCode','') !~ '^[0-9]{3}$' then raise exception 'A three-digit area code is required'; end if;
 if length(trim(coalesce(input->>'campaignDescription',''))) not between 40 and 1500 then raise exception 'Campaign description must be 40-1500 characters'; end if;
 if length(trim(coalesce(input->>'optInDescription',''))) not between 40 and 1500 then raise exception 'Opt-in description must be 40-1500 characters'; end if;
 if coalesce(jsonb_typeof(samples),'null')<>'array' then raise exception 'Provide 2-5 sample messages of 20-320 characters'; end if;
 if jsonb_array_length(samples) not between 2 and 5
   or exists(select from jsonb_array_elements_text(samples) s where length(trim(s)) not between 20 and 320)
 then raise exception 'Provide 2-5 sample messages of 20-320 characters'; end if;
 details:=jsonb_build_object(
   'senderType',sender,'brandType',case when sender='local_a2p' then brand else null end,
   'legalBusinessName',trim(input->>'legalBusinessName'),'notificationEmail',lower(trim(input->>'notificationEmail')),
   'websiteUrl',trim(input->>'websiteUrl'),'areaCode',case when sender='local_a2p' then input->>'areaCode' else null end,
   'campaignDescription',trim(input->>'campaignDescription'),'optInDescription',trim(input->>'optInDescription'),
   'sampleMessages',samples);
 update sms_private.providers set setup_details=details,setup_completed_at=now(),registration_status='collecting_details',updated_at=now()
 where tenant_id=t;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'provider_setup_saved',jsonb_build_object('senderType',sender));
 return sms_private.provider_setup(u,t);
end $$;

create function sms_private.queue_provision(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare jid uuid; job_status text;
begin
 perform sms_private.require_admin(u);
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 jid:=sms_private.enqueue(t,'provisioning_jobs','twilio-bootstrap:v1',
   jsonb_build_object('name',(select name from public.sms_businesses where tenant_id=t),'operation','bootstrap'));
 select status into strict job_status from sms_private.jobs where id=jid;
 return jsonb_build_object('jobId',jid,'status',job_status);
end $$;

create function sms_private.business_profile(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
begin
 perform sms_private.require_admin(u);
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 return coalesce((select jsonb_build_object(
   'onboarding',coalesce(b.profile->'onboarding','{}'::jsonb),
   'onboardingComplete',coalesce((b.profile->'onboarding'->>'completedAt') is not null,false),
   'updatedAt',b.profile->'onboarding'->>'updatedAt')
   from public.sms_businesses b where b.tenant_id=t),
   jsonb_build_object('onboarding','{}'::jsonb,'onboardingComplete',false));
end $$;

create function sms_private.save_business_profile(u text,t text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare onboarding jsonb; services jsonb; locations jsonb; faqs jsonb; website text; summary text; hours text; contact_phone text; tone text; handoff text;
begin
 perform sms_private.require_admin(u);
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 services:=input->'services'; locations:=input->'locations'; faqs:=coalesce(input->'faqs','[]'::jsonb);
 if length(trim(coalesce(input->>'businessName',''))) not between 1 and 120 then raise exception 'Business name is required'; end if;
 website:=trim(coalesce(input->>'websiteUrl',''));
 if website<>'' and website !~* '^https://[^[:space:]]+$' then raise exception 'Website must start with https://'; end if;
 summary:=trim(coalesce(input->>'summary',''));
 if summary<>'' and length(summary) not between 20 and 2000 then raise exception 'Summary must be 20-2000 characters'; end if;
 if coalesce(jsonb_typeof(services),'null')<>'array' then raise exception 'Add 1-30 services, with no more than 160 characters per service'; end if;
 if jsonb_array_length(services) not between 1 and 30
   or exists(select from jsonb_array_elements_text(services) s where length(trim(s)) not between 1 and 160)
 then raise exception 'Add 1-30 services, with no more than 160 characters per service'; end if;
 if coalesce(jsonb_typeof(locations),'null')<>'array' then raise exception 'Add 1-20 service areas, with no more than 160 characters per area'; end if;
 if jsonb_array_length(locations) not between 1 and 20
   or exists(select from jsonb_array_elements_text(locations) s where length(trim(s)) not between 1 and 160)
 then raise exception 'Add 1-20 service areas, with no more than 160 characters per area'; end if;
 hours:=trim(coalesce(input->>'hours',''));
 if length(hours)>200 then raise exception 'Hours must be 200 characters or fewer'; end if;
 contact_phone:=trim(coalesce(input->>'contactPhone',''));
 if length(contact_phone)>32 then raise exception 'Contact phone must be 32 characters or fewer'; end if;
 tone:=trim(coalesce(input->>'tone',''));
 if tone<>'' and tone not in ('friendly','professional','casual') then raise exception 'Choose a brand voice'; end if;
 if coalesce(jsonb_typeof(faqs),'null')<>'array' then raise exception 'FAQs must be a list'; end if;
 if jsonb_array_length(faqs)>20
   or exists(select from jsonb_array_elements_text(faqs) s where length(trim(s)) not between 1 and 300)
 then raise exception 'Add up to 20 FAQs, with no more than 300 characters each'; end if;
 handoff:=trim(coalesce(input->>'handoff',''));
 if length(handoff)>1000 then raise exception 'Handoff rule must be 1000 characters or fewer'; end if;
 onboarding:=jsonb_build_object(
   'businessName',trim(input->>'businessName'),
   'websiteUrl',website,
   'summary',summary,
   'services',(select coalesce(jsonb_agg(trim(s)),'[]'::jsonb) from jsonb_array_elements_text(services) s),
   'locations',(select coalesce(jsonb_agg(trim(s)),'[]'::jsonb) from jsonb_array_elements_text(locations) s),
   'hours',hours,
   'contactPhone',contact_phone,
   'tone',tone,
   'faqs',(select coalesce(jsonb_agg(trim(s)),'[]'::jsonb) from jsonb_array_elements_text(faqs) s where trim(s)<>''),
   'handoff',handoff,
   'updatedAt',now(),'completedAt',now());
 update public.sms_businesses set profile=coalesce(profile,'{}'::jsonb)||jsonb_build_object('onboarding',onboarding) where tenant_id=t;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'business_onboarding_saved',jsonb_build_object('services',jsonb_array_length(services)));
 return sms_private.business_profile(u,t);
end $$;

create function public.sms_crm_list_contacts(p_tenant_id text,p_options jsonb default '{}') returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
 begin
 return sms_private.api_read(auth.jwt()->>'sub',p_tenant_id,'contacts',p_options);
end $$;
create function public.sms_crm_enroll_contact(p_tenant_id text,p_contact jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
 begin
 return sms_private.api_action(auth.jwt()->>'sub',p_tenant_id,'enroll',p_contact);
end $$;
revoke all on function public.sms_crm_list_contacts(text,jsonb),public.sms_crm_enroll_contact(text,jsonb) from public,anon;
grant execute on function public.sms_crm_list_contacts(text,jsonb),public.sms_crm_enroll_contact(text,jsonb) to authenticated;
