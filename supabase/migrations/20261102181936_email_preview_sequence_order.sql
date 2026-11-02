-- CRM-owned: sequential previews cannot precede an earlier step. No enrollment changes.
create or replace function sms_private.email_automation_apply(t text,actor text,action text,p jsonb) returns jsonb language plpgsql set search_path='' as $$
declare a sms_private.email_templates; c sms_private.email_connections; s sms_private.email_business_settings; r sms_private.email_enrollments; ct public.sms_contacts;
 result jsonb; saved sms_private.email_automation_operations; key uuid; d jsonb; j sms_private.email_jobs; was_consented boolean; begin
 if jsonb_typeof(p) is distinct from 'object' or length(p::text)>350000 then raise exception 'Invalid email request'; end if;
 if action='read' then return sms_private.email_automation_read(t,p); end if;
 if action='preview' then
  select * into strict a from sms_private.email_templates where tenant_id=t and id=(p->>'id')::uuid;
  if a.revision is distinct from (p->>'revision')::integer then raise exception 'Email template changed; reload' using errcode='40001'; end if;
  d:=coalesce(p->'definition',a.draft); perform sms_private.email_validate_definition(d);
  return jsonb_build_object('definition',d,'schedule',(
   select jsonb_agg(jsonb_build_object('step',n+1,'dueAt',case when due is null then null else sequential_due end) order by n)
   from (select n,due,max(due) over(order by n) sequential_due from (
    select n,sms_private.email_template_due(d,n,coalesce(nullif(p->>'startAt','')::timestamptz,now()),nullif(p->>'appointmentAt','')::timestamptz,(select time_zone from public.sms_businesses where tenant_id=t)) due
    from generate_series(0,jsonb_array_length(d->'steps')-1)n
   ) nominal) sequential),'queued',false);
 end if;
 key:=(p->>'idempotencyKey')::uuid; if key is null then raise exception 'Retry identity required'; end if;
 perform pg_advisory_xact_lock(hashtextextended('email-operation:'||t||':'||actor||':'||key,0));
 select * into saved from sms_private.email_automation_operations where tenant_id=t and email_automation_operations.actor=email_automation_apply.actor and retry_key=key;
 if found then if saved.action<>action or saved.payload<>p then raise exception 'Retry identity already used'; end if; return saved.result; end if;
 if action in ('create','save','publish','archive','duplicate') then
  if action<>'create' then
   select * into strict a from sms_private.email_templates where tenant_id=t and id=(p->>'id')::uuid for update;
   if a.revision is distinct from (p->>'revision')::integer then raise exception 'Email template changed; reload' using errcode='40001'; end if;
  end if;
  if action in ('create','save') then
   perform sms_private.email_validate_definition(p->'definition');
   if action='create' then insert into sms_private.email_templates(tenant_id,name,draft) values(t,btrim(p->>'name'),p->'definition') returning * into a;
   else update sms_private.email_templates set name=btrim(p->>'name'),draft=p->'definition',revision=revision+1 where id=a.id returning * into a; end if;
  elsif action='publish' then
   if a.archived then raise exception 'Archived template'; end if;
   perform sms_private.email_validate_definition(a.draft);
   if a.draft->>'purpose'='service' and exists(select from sms_private.email_connections where template_id=a.id and enabled and event not like 'booking.%') then raise exception 'Disconnect non-booking connections before publishing a service template'; end if;
   insert into sms_private.email_template_versions values(t,a.id,coalesce(a.published_version,0)+1,a.draft,now());
   update sms_private.email_templates set published_version=coalesce(published_version,0)+1,revision=revision+1 where id=a.id returning * into a;
  elsif action='archive' then
   update sms_private.email_templates set archived=true,revision=revision+1 where id=a.id returning * into a;
  else insert into sms_private.email_templates(tenant_id,name,draft) values(t,left(a.name||' copy',120),a.draft) returning * into a;
  end if; result:=to_jsonb(a);
 elsif action='settings' then
  insert into sms_private.email_business_settings(tenant_id) values(t) on conflict do nothing;
  select * into strict s from sms_private.email_business_settings where tenant_id=t for update;
  if not p ? 'revision' or s.revision is distinct from greatest(1,(p->>'revision')::integer) then raise exception 'Email settings changed; reload' using errcode='40001'; end if;
  if jsonb_typeof(p->'enabled') is distinct from 'boolean' or coalesce(p->>'replyTo','') !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$' or length(p->>'replyTo')>320 or coalesce(length(btrim(p->>'mailingAddress')),0)>300 then raise exception 'Invalid email settings'; end if;
  if nullif(p->>'domainId','') is not null and not exists(select from sms_private.email_sender_domains where id=(p->>'domainId')::uuid and (tenant_id=t or tenant_id is null) and status='verified') then raise exception 'Choose a verified business sender'; end if;
  if (p->>'enabled')::boolean and (coalesce(length(btrim(p->>'mailingAddress')),0)=0 or not exists(select from sms_private.email_sender_domains where id=coalesce(nullif(p->>'domainId','')::uuid,(select id from sms_private.email_sender_domains where domain='e2local.com')) and status='verified')
   or not exists(select from sms_private.edge_config where queue='automation_jobs' and enabled and secret_id is not null)) then raise exception 'Verify sender, worker and mailing address before activation'; end if;
  update sms_private.email_business_settings set enabled=(p->>'enabled')::boolean,domain_id=nullif(p->>'domainId','')::uuid,reply_to=lower(btrim(p->>'replyTo')),mailing_address=btrim(p->>'mailingAddress'),revision=revision+1 where tenant_id=t returning * into s;
  result:=to_jsonb(s);
 elsif action='form_consent' then
  perform 1 from public.sms_web_form_definitions where tenant_id=t and public_id=(p->>'formId')::uuid and version=(p->>'revision')::integer and not archived for update;
  if not found then raise exception 'Form changed; reload' using errcode='40001'; end if;
  if jsonb_typeof(p->'enabled') is distinct from 'boolean' then raise exception 'Choose email consent'; end if;
  update public.sms_web_form_definitions set email_enabled=(p->>'enabled')::boolean where tenant_id=t and public_id=(p->>'formId')::uuid and email_enabled is distinct from (p->>'enabled')::boolean;
  if found then update sms_private.mcp_form_drafts set base_revision=(p->>'revision')::integer+1,revision=revision+1,updated_at=now() where tenant_id=t and form_id=(p->>'formId')::uuid and base_revision=(p->>'revision')::integer; end if;
  result:=jsonb_build_object('ok',true);
 elsif action='connection' then
  select * into strict a from sms_private.email_templates where tenant_id=t and id=(p->>'templateId')::uuid for share;
  if a.archived or a.published_version is null then raise exception 'Publish the template first'; end if;
  select definition into d from sms_private.email_template_versions where tenant_id=t and template_id=a.id and version=a.published_version;
  if d->>'purpose'='service' and coalesce(p->>'event','') not like 'booking.%' then raise exception 'Service templates require booking events'; end if;
  if nullif(p->>'formId','') is not null and not exists(select from public.sms_web_form_definitions where tenant_id=t and public_id=(p->>'formId')::uuid and not archived) then raise exception 'Unknown business form'; end if;
  if p ? 'id' and nullif(p->>'id','') is not null then
   select * into strict c from sms_private.email_connections where tenant_id=t and id=(p->>'id')::uuid for update;
   if c.revision is distinct from (p->>'revision')::integer then raise exception 'Email connection changed; reload' using errcode='40001'; end if;
  end if;
  if coalesce((p->>'enabled')::boolean,false) and not coalesce((p->>'replaceLegacy')::boolean,false) and exists(select from sms_private.email_group_settings where tenant_id=t and enabled) then raise exception 'Confirm replacement of overlapping legacy email routing'; end if;
  if c.id is null then insert into sms_private.email_connections(tenant_id,template_id,event,form_id,enabled,replace_legacy) values(t,a.id,p->>'event',nullif(p->>'formId','')::uuid,coalesce((p->>'enabled')::boolean,false),coalesce((p->>'replaceLegacy')::boolean,false)) returning * into c;
  else update sms_private.email_connections set template_id=a.id,event=p->>'event',form_id=nullif(p->>'formId','')::uuid,enabled=coalesce((p->>'enabled')::boolean,false),replace_legacy=coalesce((p->>'replaceLegacy')::boolean,false),revision=revision+1 where id=c.id returning * into c; end if;
  if not c.enabled then update sms_private.email_enrollments set status='cancelled',generation=generation+1,next_run_at=null where tenant_id=t and connection_id=c.id and status in ('active','paused'); end if;
  result:=to_jsonb(c);
 elsif action='consent' then
  select * into strict ct from public.sms_contacts where tenant_id=t and id=(p->>'contactId')::uuid for share;
  if ct.revision is distinct from (p->>'contactRevision')::integer then raise exception 'Contact changed; reload' using errcode='40001'; end if;
  if jsonb_typeof(p->'consent') is distinct from 'boolean' then raise exception 'Choose email consent'; end if;
  perform pg_advisory_xact_lock(hashtextextended('email:'||t||':'||lower(btrim(ct.email)),0));
  was_consented:=exists(select from sms_private.email_permissions where tenant_id=t and email=lower(btrim(ct.email)) and consent);
  perform sms_private.email_set_permission(t,ct.email,(p->>'consent')::boolean,p->>'evidence',actor);
  if (p->>'consent')::boolean and not was_consented then perform sms_private.email_emit(t,'contact.opted_in',ct.id::text,key::text,ct.email,ct.name,ct.phone,ct.id,jsonb_build_object('name',ct.name),null); end if;
  result:=jsonb_build_object('ok',true);
 elsif action='start' then
  select * into strict ct from public.sms_contacts where tenant_id=t and id=(p->>'contactId')::uuid for share;
  if ct.revision is distinct from (p->>'contactRevision')::integer then raise exception 'Contact changed; reload' using errcode='40001'; end if;
  if exists(select from sms_private.email_template_versions v join sms_private.email_templates et on et.id=v.template_id and et.published_version=v.version where et.tenant_id=t and et.id=(p->>'templateId')::uuid and (v.definition->>'purpose'='service' or exists(select from jsonb_array_elements(v.definition->'steps') st where st->>'anchor'='appointment'))) then raise exception 'This template requires a booking event'; end if;
  result:=jsonb_build_object('runId',sms_private.email_start_template(t,(p->>'templateId')::uuid,null,'contact',ct.id::text,key::text,ct.email,ct.name,ct.phone,ct.id,jsonb_build_object('name',ct.name,'request',left(coalesce(p->>'request',''),1600)),null));
  if result->>'runId' is null then raise exception 'Email cannot start: check activation, sender, consent and suppression'; end if;
 elsif action in ('pause','resume','stop','retry') then
  select * into strict r from sms_private.email_enrollments where tenant_id=t and id=(p->>'runId')::uuid and template_id is not null for update;
  if r.revision is distinct from (p->>'revision')::integer or r.generation is distinct from (p->>'generation')::integer then raise exception 'Email run changed; reload' using errcode='40001'; end if;
  if action='stop' then update sms_private.email_enrollments set status='cancelled',generation=generation+1,next_run_at=null where id=r.id returning * into r;
  elsif action='pause' and r.status='active' then update sms_private.email_enrollments set status='paused',pause_reason='STAFF_PAUSED' where id=r.id returning * into r;
  elsif action in ('resume','retry') and r.status='paused' then
   if not coalesce((sms_private.email_sender_settings(t)->>'enabled')::boolean,false) or not coalesce((sms_private.email_sender_settings(t)->>'ready')::boolean,false)
    or exists(select from sms_private.email_global_suppressions where email=r.email)
    or r.purpose='marketing' and (not sms_private.email_has_permission(t,r.email) or exists(select from sms_private.email_suppressions where tenant_id=t and email=r.email))
    or r.contact_id is not null and not exists(select from public.sms_contacts where tenant_id=t and id=r.contact_id and lower(email)=r.email)
    or r.connection_id is not null and not exists(select from sms_private.email_connections where id=r.connection_id and enabled)
    or r.form_public_id is not null and not exists(select from public.sms_web_form_definitions where public_id=r.form_public_id and enabled and not archived and email_enabled)
   then raise exception 'Email cannot resume: check activation, recipient, consent and suppression'; end if;
   if exists(select from sms_private.email_jobs where enrollment_id=r.id and generation=r.generation and (status='uncertain' or send_started_at<=now()-interval '23 hours')) then raise exception 'Reconcile provider outcome before resuming'; end if;
   update sms_private.email_jobs set status='pending',attempts=0,error_code=null,due_at=now() where enrollment_id=r.id and generation=r.generation and step_index=r.step_index and status='failed';
   update sms_private.email_enrollments set status='active',pause_reason=null where id=r.id returning * into r;
  else raise exception 'Email run cannot perform this action'; end if;
  result:=jsonb_build_object('id',r.id,'status',r.status,'revision',r.revision,'generation',r.generation);
 else raise exception 'Unknown email action'; end if;
 insert into sms_private.email_automation_operations values(t,actor,key,action,p,result,now());
 return result;
end $$;
