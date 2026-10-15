-- CRM-owned, after pending 20261015043000 and the paired E2 baseline.
-- CLI-created file sequenced immediately after its pending prerequisite.
-- No grants, publication pointers, enrollment settings or sending flags change.

-- The runtime already renders {{request}} for direct sequences. Validate it as
-- a supported direct-only token without allowing form-field placeholders.
create or replace function sms_private.direct_validate(s jsonb) returns void
language plpgsql set search_path='' as $$
declare checked jsonb; begin
 if s->>'trigger' is distinct from 'submission' or coalesce(s->>'replyPolicy','') not in ('pause','continue','stop') then raise exception 'Invalid direct sequence'; end if;
 if jsonb_typeof(s->'steps') is distinct from 'array' then raise exception 'Invalid direct messages'; end if;
 if exists(select from jsonb_array_elements(s->'steps') v where length(btrim(v->>'body')) not between 1 and 1600) then raise exception 'Messages must contain 1 to 1600 characters'; end if;
 checked:=s||jsonb_build_object('replyPolicy',case when s->>'replyPolicy'='stop' then 'pause' else s->>'replyPolicy' end,
  'steps',(select jsonb_agg(v||jsonb_build_object('body',replace(v->>'body','{{request}}','{{name}}')) order by n)
    from jsonb_array_elements(s->'steps') with ordinality a(v,n)));
 perform sms_private.validate_form_sequence(checked,'[]',false);
end $$;

create function sms_private.mcp_sms_preview(u text,t text,p jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare x record; f public.sms_web_form_definitions; c public.sms_contacts; b public.sms_businesses;
 cfg jsonb; sampled jsonb; result jsonb; info jsonb; ctx jsonb; fingerprint text; source jsonb;
 mode text:=coalesce(p->>'source','draft'); scenario text:=coalesce(p->>'scenario','none');
 k text:=p->>'kind'; field_name text; total integer; start_at timestamptz; stopped text; warnings jsonb:='[]';
begin
 perform sms_private.require_sms_reader(u,t);
 if jsonb_typeof(p) is distinct from 'object' then raise exception 'Invalid preview'; end if;
 if exists(select from jsonb_object_keys(p) key_name where not key_name=any(array['businessId','kind','automationId','revision','formRevision','source','sequence','sample','contactId','contactRevision','context','submittedLocal','scenario'])) then raise exception 'Unexpected input field'; end if;
 if k is null or k not in ('form','contact') or mode not in ('draft','published','input') or scenario not in ('none','reply','opt_out') then raise exception 'Choose valid preview options'; end if;
 if p ? 'source' and jsonb_typeof(p->'source')<>'string' or p ? 'scenario' and jsonb_typeof(p->'scenario')<>'string' then raise exception 'Invalid preview options'; end if;
 select * into x from sms_private.mcp_sms_catalog(t) a where a.kind=k and a.id=(p->>'automationId')::uuid;
 if not found then raise exception 'Automation unavailable' using errcode='42501'; end if;
 if jsonb_typeof(p->'revision') is distinct from 'number' then raise exception 'Current revision required'; end if;
 if (p->>'revision')::numeric is distinct from x.revision::numeric then raise exception 'Automation changed; reread before preview' using errcode='40001'; end if;
 info:=sms_private.mcp_sms_read(u,t,'crm_get_sms_automation',jsonb_build_object('businessId',t,'kind',k,'automationId',x.id));
 select * into b from public.sms_businesses where tenant_id=t;
 if mode='input' then cfg:=p->'sequence';
 else
  if p ? 'sequence' then raise exception 'Unsaved rules require source=input'; end if;
  cfg:=info->'automation'->mode;
 end if;
 if cfg is null or cfg='null' then raise exception 'No rules for the selected preview source'; end if;
 if jsonb_typeof(p->'submittedLocal') is distinct from 'string' or p->>'submittedLocal' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' then raise exception 'Explicit business-local simulation time required'; end if;
 start_at:=(p->>'submittedLocal')::timestamp at time zone b.time_zone;
 -- Reject local times that fall in a DST gap; folds follow PostgreSQL's standard-time interpretation.
 if to_char(start_at at time zone b.time_zone,'YYYY-MM-DD"T"HH24:MI')<>p->>'submittedLocal' then raise exception 'Simulation time does not exist in the business timezone'; end if;
 if k='form' then
  if p ?| array['contactId','contactRevision','context'] then raise exception 'Forms require sample answers'; end if;
  select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=x.id;
  if jsonb_typeof(p->'formRevision') is distinct from 'number' then raise exception 'Current formRevision required'; end if;
  if (p->>'formRevision')::numeric is distinct from f.version::numeric then raise exception 'Form changed; reread before preview' using errcode='40001'; end if;
 else
  if p ? 'formRevision' then raise exception 'Contact templates do not have a form revision'; end if;
  if (p ? 'sample')=(p ? 'contactId') then raise exception 'Choose sample or contactId, not both'; end if;
  if p ? 'context' and (jsonb_typeof(p->'context')<>'string' or length(p->>'context')>2500) then raise exception 'Invalid request context'; end if;
 end if;
 perform sms_private.mcp_sms_validate_sequence(cfg,k,coalesce(f.fields,'[]'),f.preset);
 if p ? 'contactId' then
  select * into c from public.sms_contacts where tenant_id=t and id=(p->>'contactId')::uuid;
  if not found then raise exception 'Contact unavailable' using errcode='42501'; end if;
  if jsonb_typeof(p->'contactRevision') is distinct from 'number' then raise exception 'Current contactRevision required'; end if;
  if (p->>'contactRevision')::numeric is distinct from c.revision::numeric then raise exception 'Contact changed; reread before preview' using errcode='40001'; end if;
  sampled:=jsonb_build_object('name',coalesce(c.name,''),'phone',c.phone,'email',coalesce(c.email,''),'smsOptIn',c.marketing_consent);
 else
  if p ? 'contactRevision' then raise exception 'contactRevision requires contactId'; end if;
  sampled:=p->'sample';
  if jsonb_typeof(sampled) is distinct from 'object' then raise exception 'Sample required'; end if;
  if exists(select from jsonb_object_keys(sampled) v where not v=any(case when k='form' then array['name','phone','email','smsOptIn','details','appointmentLocal'] else array['name','phone','email','smsOptIn'] end)) then raise exception 'Unexpected sample field'; end if;
  foreach field_name in array array['name','phone','email'] loop
   if jsonb_typeof(sampled->field_name) is distinct from 'string' then raise exception 'Invalid sample fields'; end if;
  end loop;
  if length(sampled->>'name')>200 or length(sampled->>'email')>320 or sampled->>'phone' !~ '^[+][1-9][0-9]{7,14}$' or jsonb_typeof(sampled->'smsOptIn') is distinct from 'boolean' then raise exception 'Invalid sample fields'; end if;
  select * into c from public.sms_contacts where tenant_id=t and phone=sampled->>'phone';
 end if;
 if k='form' then
  result:=sms_private.preview_form_automation(u,t,f.public_id,jsonb_build_object('sample',sampled,'sequence',cfg,'submittedLocal',p->>'submittedLocal','scenario',scenario));
 else
  select sum((v->>'sendCount')::integer) into total from jsonb_array_elements(cfg->'steps') v;
  if not (sampled->>'smsOptIn')::boolean or c.id is not null and (c.opted_out or not c.marketing_consent) then stopped:='No automation: SMS consent is missing or this phone has opted out.';
  elsif coalesce(c.enquiry_blocked,false) then stopped:='No automation: contact enquiry follow-ups are blocked.'; end if;
  ctx:=jsonb_build_object('name',sampled->>'name','first_name',split_part(sampled->>'name',' ',1),'phone',sampled->>'phone','email',sampled->>'email','business_name',b.name,'request',coalesce(p->>'context',''));
  if stopped is not null then result:=jsonb_build_object('rows','[]'::jsonb,'totalSends',total,'truncated',false,'outcome',stopped);
  else result:=sms_private.simulate_sms_sequence(cfg,ctx,start_at,null,b.time_zone,scenario,50); end if;
  result:=result||jsonb_build_object('warnings',info->'readiness'->'blockers');
 end if;
 source:=jsonb_build_object('kind',k,'automationId',x.id,'revision',x.revision,'formRevision',x.form_revision,
  'publishedVersion',x.published_version,'contactRevision',c.revision,'mode',mode);
 fingerprint:=encode(sha256(convert_to(jsonb_build_object('source',source,'sequence',cfg,'sample',sampled,'context',p->'context',
  'submittedAt',start_at,'scenario',scenario,'timeZone',b.time_zone,'businessName',b.name,'formFields',f.fields,
  'contactState',jsonb_build_object('revision',c.revision,'optedOut',c.opted_out,'consent',c.marketing_consent,'blocked',c.enquiry_blocked))::text,'UTF8')),'hex');
 warnings:=coalesce(result->'warnings','[]')||jsonb_build_array('Estimated schedule only. Live replies, quiet waits, overlap checks and provider processing can defer or prevent sending.');
 return jsonb_build_object('businessId',t,'simulation',true,'timeZone',b.time_zone,'submittedAt',start_at,'source',source,'fingerprint',fingerprint,
  'rows',result->'rows','totalSends',result->'totalSends','limit',case when k='form' then 200 else 50 end,'truncated',result->'truncated',
  'warnings',warnings,'outcome',result->'outcome','readiness',info->'readiness');
exception when invalid_datetime_format or datetime_field_overflow then raise exception 'Invalid simulation date';
end $$;

create function sms_private.mcp_sms_validate_sequence(s jsonb,k text,fields jsonb,preset text) returns void
language plpgsql immutable set search_path='' as $$
declare step jsonb; n text; begin
 if jsonb_typeof(s) is distinct from 'object' then raise exception 'Sequence must be an object'; end if;
 if exists(select from jsonb_object_keys(s) x where not x=any(array['trigger','leadHours','replyPolicy','startHour','endHour','steps']))
  or not s ?& array['trigger','leadHours','replyPolicy','startHour','endHour','steps'] then raise exception 'Invalid sequence fields'; end if;
 foreach n in array array['leadHours','startHour','endHour'] loop
  if jsonb_typeof(s->n) is distinct from 'number' then raise exception 'Sequence timing must use whole numbers'; end if;
  if (s->>n)::numeric<>trunc((s->>n)::numeric) or (s->>n)::numeric not between 0 and 8760 then raise exception 'Invalid sequence timing'; end if;
 end loop;
 if jsonb_typeof(s->'steps') is distinct from 'array' then raise exception 'Messages must be an array'; end if;
 if jsonb_array_length(s->'steps') not between 1 and 50 then raise exception 'Use 1 to 50 messages'; end if;
 for step in select value from jsonb_array_elements(s->'steps') loop
  if jsonb_typeof(step) is distinct from 'object' then raise exception 'Invalid message'; end if;
  if exists(select from jsonb_object_keys(step) x where not x=any(array['body','delayCount','delayUnit','sendCount','intervalCount','intervalUnit'])) then raise exception 'Invalid message fields'; end if;
  foreach n in array array['delayCount','sendCount','intervalCount'] loop
   if jsonb_typeof(step->n) is distinct from 'number' then raise exception 'Message timing must use whole numbers'; end if;
   if (step->>n)::numeric<>trunc((step->>n)::numeric) or (step->>n)::numeric not between 0 and 1000 then raise exception 'Invalid message timing'; end if;
  end loop;
 end loop;
 if k='form' then perform sms_private.validate_form_sequence(s,fields,preset='bookings');
 elsif k='contact' then perform sms_private.direct_validate(s);
 else raise exception 'Invalid automation kind'; end if;
end $$;

-- Shared pure simulation kernel. Uses the canonical scheduler; no database reads
-- or writes and no provider call. Context is supplied only by scoped callers.
create function sms_private.simulate_sms_sequence(cfg jsonb,ctx jsonb,start_at timestamptz,appointment timestamptz,tz text,scenario text,cap integer)
returns jsonb language plpgsql immutable set search_path='' as $$
declare step jsonb; due timestamptz; quiet_until timestamptz; body text; token text[]; val text;
 rows jsonb:='[]'; total integer; mi integer:=0; ri integer; shown integer:=0; stopped text; missing text;
begin
 if scenario not in ('none','reply','opt_out') or cap not between 1 and 200 then raise exception 'Invalid simulation options'; end if;
 select sum((s->>'sendCount')::integer) into total from jsonb_array_elements(cfg->'steps') s;
 due:=case when cfg->>'trigger'='appointment' then appointment-make_interval(hours=>(cfg->>'leadHours')::integer) else start_at end;
 <<messages>>
 for step in select jsonb_array_elements(cfg->'steps') loop
  mi:=mi+1;missing:=null;
  due:=sms_private.form_due(due,(step->>'delayCount')::integer,step->>'delayUnit',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
  due:=sms_private.form_due(greatest(due,start_at,quiet_until),0,'minute',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
  body:=step->>'body';
  for token in select regexp_matches(body,'\{\{([^{}]+)\}\}','g') loop
   val:=case when token[1]='appointment_at' then to_char(appointment at time zone tz,'Mon DD, YYYY HH24:MI')||' ('||tz||')'
    when token[1] like 'field.%' then ctx->'fields'->>substring(token[1] from 7) else ctx->>token[1] end;
   if nullif(btrim(val),'') is null then missing:=token[1];exit;end if;
   body:=replace(body,'{{'||token[1]||'}}',val);
  end loop;
  if missing is not null then stopped:='Paused: missing message field '||missing;exit;end if;
  if length(body)>1600 or position('{{' in body)>0 then stopped:='Paused: personalized message is too long or contains unresolved fields.';exit;end if;
  for ri in 1..(step->>'sendCount')::integer loop
   if shown>=cap then exit messages;end if;
   due:=sms_private.form_due(greatest(due,quiet_until),0,'minute',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);
   if cfg->>'trigger'='appointment' and due>=appointment then stopped:='Stopped at appointment time.';exit messages;end if;
   shown:=shown+1;rows:=rows||jsonb_build_array(jsonb_build_object('message',mi,'repeat',ri,'at',due,'body',body));
   if shown=1 and scenario='opt_out' then stopped:='Stopped: the test customer opted out after the first message.';exit messages;end if;
   if shown=1 and scenario='reply' then
    if cfg->>'replyPolicy'='pause' then stopped:='Paused: the test customer replied after the first message.';exit messages;
    elsif cfg->>'replyPolicy'='stop' then stopped:='Stopped: the test customer replied after the first message.';exit messages;
    elsif cfg->>'trigger'='submission' then quiet_until:=due+interval '30 minutes'; end if;
   end if;
   if ri<(step->>'sendCount')::integer then due:=sms_private.form_due(due,(step->>'intervalCount')::integer,step->>'intervalUnit',tz,(cfg->>'startHour')::integer,(cfg->>'endHour')::integer);end if;
  end loop;
 end loop;
 return jsonb_build_object('rows',rows,'totalSends',total,'truncated',stopped is null and shown<total,
  'outcome',coalesce(stopped,case when shown<total then 'Showing the first '||cap||' scheduled sends.' else 'Simulation completed. No messages were sent or leads saved.' end));
end $$;

create function sms_private.mcp_sms_draft(u text,t text,tool text,p jsonb,connection uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f public.sms_web_form_definitions; d sms_private.direct_templates; s sms_private.form_sequences;
 creating boolean:=tool='crm_create_sms_automation'; k text:=p->>'kind'; expected bigint; x record; r jsonb; inner_key text;
begin
 perform sms_private.require_sms_reader(u,t);perform sms_private.require_admin(u);
 if jsonb_typeof(p) is distinct from 'object' or k is null or k not in ('form','contact') then raise exception 'Choose an automation kind'; end if;
 if exists(select from jsonb_object_keys(p) key_name where not key_name=any(array['businessId','kind','automationId','revision','formRevision','name','sequence','idempotencyKey'])) then raise exception 'Unexpected input field'; end if;
 if creating and p ? 'revision' then raise exception 'Creation does not accept an existing draft revision'; end if;
 if not creating then
  if jsonb_typeof(p->'revision') is distinct from 'number' then raise exception 'Current revision required'; end if;
  if (p->>'revision')::numeric<>trunc((p->>'revision')::numeric) or (p->>'revision')::numeric not between 0 and 2147483647 then raise exception 'Invalid revision'; end if;
 end if;
 if k='form' then
  if p ? 'name' then raise exception 'Form titles are managed in Forms'; end if;
  select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=(p->>'automationId')::uuid for update;
  if not found then raise exception 'Automation unavailable' using errcode='42501'; end if;
  if f.archived then raise exception 'Form is archived'; end if;
  if jsonb_typeof(p->'formRevision') is distinct from 'number' then raise exception 'Current formRevision required'; end if;
  if (p->>'formRevision')::numeric is distinct from f.version::numeric then raise exception 'Form changed; reread before saving' using errcode='40001'; end if;
  select * into s from sms_private.form_sequences where tenant_id=t and form_id=f.public_id for update;
  expected:=case when s.revision=1 and s.draft='{}' then 0 else coalesce(s.revision,0) end;
  if creating and (s.draft is not null and s.draft<>'{}' or s.published_version is not null) then raise exception 'Draft already exists; reread before editing' using errcode='40001'; end if;
  if not creating and (s.draft is null or s.draft='{}') then raise exception 'Create a draft first'; end if;
  if not creating and expected is distinct from (p->>'revision')::bigint then raise exception 'Draft changed; reread before saving' using errcode='40001'; end if;
  perform sms_private.mcp_sms_validate_sequence(p->'sequence',k,f.fields,f.preset);
  perform sms_private.form_workspace(u,t,'draft',f.public_id,jsonb_build_object('revision',expected,'sequence',p->'sequence'));
  select * into x from sms_private.mcp_sms_catalog(t) c where c.kind=k and c.id=f.public_id;
 else
  if p ? 'formRevision' then raise exception 'Contact templates do not have a form revision'; end if;
  if jsonb_typeof(p->'name') is distinct from 'string' or length(btrim(p->>'name')) not between 1 and 100 then raise exception 'Template name required (1 to 100 characters)'; end if;
  if creating and p ? 'automationId' then raise exception 'New contact templates must not specify an ID'; end if;
  inner_key:='mcp:'||connection::text||':'||encode(sha256(convert_to(p->>'idempotencyKey','UTF8')),'hex');
  -- Match the canonical direct operation's lock order and isolate its retry namespace.
  perform pg_advisory_xact_lock(hashtextextended(t||':direct-operation:'||inner_key,419));
  if not creating then
   select * into d from sms_private.direct_templates where tenant_id=t and id=(p->>'automationId')::uuid for update;
   if not found then raise exception 'Automation unavailable' using errcode='42501'; end if;
   if d.archived then raise exception 'Template is archived'; end if;
  end if;
  perform sms_private.mcp_sms_validate_sequence(p->'sequence',k,'[]',null);
  r:=sms_private.contact_automations(u,t,'save',jsonb_build_object('name',btrim(p->>'name'),'sequence',p->'sequence','idempotencyKey',inner_key)
   ||case when creating then '{}'::jsonb else jsonb_build_object('id',d.id,'revision',p->'revision') end);
  select * into x from sms_private.mcp_sms_catalog(t) c where c.kind=k and c.id=(r->'template'->>'id')::uuid;
 end if;
 return jsonb_build_object('businessId',t,'automation',sms_private.mcp_sms_summary(to_jsonb(x)),'databaseStatus','committed');
end $$;

-- Keep canonical form validation and consent checks; share only the pure rendering kernel.
create or replace function sms_private.preview_form_automation(u text,t text,fid uuid,input jsonb) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare f public.sms_web_form_definitions; b public.sms_businesses; saved sms_private.form_sequences;
 cfg jsonb; p jsonb:=coalesce(input->'sample','{}'); step jsonb; field jsonb; answers jsonb; value jsonb;
 customer_name text; normalized_phone text; normalized_email text; k text; field_type text; keys text[]:='{}';
 start_at timestamptz; appointment timestamptz; due timestamptz; ctx jsonb; body text; token text[]; val text;
 rows jsonb:='[]'; total integer:=0; mi integer:=0; ri integer; shown integer:=0; stopped text; missing text;
 scenario text:=coalesce(input->>'scenario','none'); warnings jsonb:='[]'; result jsonb;
begin
 perform sms_private.require_sms_reader(u,t);
 select * into f from public.sms_web_form_definitions where tenant_id=t and public_id=fid;
 if f.public_id is null then raise exception 'Form not found' using errcode='P0002'; end if;
 select * into b from public.sms_businesses where tenant_id=t;
 select * into saved from sms_private.form_sequences where tenant_id=t and form_id=fid;
 if input ? 'fields' then f.fields:=input->'fields'; end if;
 if jsonb_typeof(f.fields) is distinct from 'array' or jsonb_array_length(f.fields)>20 then raise exception 'Invalid form fields'; end if;
 for field in select jsonb_array_elements(f.fields) loop
  k:=field->>'key';
  if jsonb_typeof(field) is distinct from 'object' or k is null or k!~'^[a-z][a-z0-9_]{0,39}$' or k=any(keys)
   or k=any(array['name','phone','email','appointment_at','sms_opt_in','consent_evidence'])
   or coalesce(field->>'type','') not in ('text','textarea','select','checkbox','date')
   or jsonb_typeof(coalesce(field->'required','false'::jsonb)) is distinct from 'boolean'
   or length(btrim(coalesce(field->>'label',''))) not between 1 and 100 then raise exception 'Complete each custom field before testing'; end if;
  if field->>'type'='select' then
   if jsonb_typeof(field->'options') is distinct from 'array' or jsonb_array_length(field->'options') not between 1 and 20
    or exists(select from jsonb_array_elements(field->'options') v where jsonb_typeof(v.value)<>'string' or length(btrim(v.value #>> '{}')) not between 1 and 100)
    or (select count(distinct opt.value) from jsonb_array_elements_text(field->'options') opt)<>jsonb_array_length(field->'options') then raise exception 'Select fields need 1-20 unique options';end if;
  elsif field ? 'options' then raise exception 'Only select fields may have options';end if;
  keys:=array_append(keys,k);
 end loop;
  customer_name:=btrim(coalesce(p->>'name',''));
  normalized_phone:=btrim(coalesce(p->>'phone',''));
  normalized_email:=lower(btrim(coalesce(p->>'email','')));
  if length(customer_name) not between 1 and 200 or normalized_phone !~ '^[+][1-9][0-9]{7,14}$'
     or length(normalized_email) not between 3 and 320
     or normalized_email !~ '^[^[:space:]@]+@[^[:space:]@]+[.][^[:space:]@]+$'
     or jsonb_typeof(p->'smsOptIn') is distinct from 'boolean' then raise exception 'Invalid required form fields'; end if;
  answers:=coalesce(p->'details','{}'::jsonb);
  if jsonb_typeof(answers) is distinct from 'object' then raise exception 'Custom answers must be an object'; end if;
  for k in select jsonb_object_keys(answers) loop
    if not exists(select from jsonb_array_elements(f.fields) x where x->>'key'=k) then
      raise exception 'Unknown custom field';
    end if;
  end loop;
  for field in select x.value from jsonb_array_elements(f.fields) x loop
    k:=field->>'key'; field_type:=field->>'type'; value:=answers->k;
    if value is null or value='null'::jsonb or value='""'::jsonb then
      if coalesce((field->>'required')::boolean,false) then raise exception 'Required custom field missing'; end if;
      continue;
    end if;
    if field_type='checkbox' then
      if jsonb_typeof(value)<>'boolean' or (coalesce((field->>'required')::boolean,false) and value='false'::jsonb) then
        raise exception 'Invalid checkbox answer'; end if;
    elsif jsonb_typeof(value)<>'string' or length(value #>> '{}')>2000 then
      raise exception 'Invalid custom field answer';
    elsif field_type='text' and length(value #>> '{}')>300 then
      raise exception 'Text answer too long';
    elsif field_type='select' and not (field->'options' ? (value #>> '{}')) then
      raise exception 'Invalid select answer';
    elsif field_type='date' then
      if (value #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'
        or to_char(to_date(value #>> '{}','YYYY-MM-DD'),'YYYY-MM-DD')<>(value #>> '{}') then
        raise exception 'Invalid date answer'; end if;
    end if;
  end loop;

 if scenario not in ('none','reply','opt_out') then raise exception 'Choose a valid test scenario'; end if;
 if nullif(input->>'submittedLocal','') is not null then
  if input->>'submittedLocal' !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' then raise exception 'Invalid test start time';end if;
  start_at:=(input->>'submittedLocal')::timestamp at time zone b.time_zone;
 else start_at:=now();end if;
 if f.preset='bookings' then
  if coalesce(p->>'appointmentLocal','') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$' then raise exception 'Enter an appointment date and time';end if;
  appointment:=(p->>'appointmentLocal')::timestamp at time zone b.time_zone;
  if appointment<=start_at then raise exception 'The appointment must be after the test submission';end if;
 end if;
 cfg:=nullif(coalesce(nullif(input->'sequence','null'::jsonb),saved.draft),'{}'::jsonb);
 if cfg is not null and (jsonb_typeof(cfg) is distinct from 'object' or jsonb_typeof(cfg->'steps') is distinct from 'array') then raise exception 'Invalid automation rules';end if;
 result:=jsonb_build_object('simulation',true,'timeZone',b.time_zone,'submittedAt',start_at,'publishedVersion',saved.published_version,
  'automationEnabled',coalesce(saved.enabled,false),'sendingEnabled',b.sending_enabled and b.status='active');
 if not f.enabled or f.archived then warnings:=warnings||jsonb_build_array('This form is not collecting live submissions.');end if;
 if not coalesce(saved.enabled,false) then warnings:=warnings||jsonb_build_array('The published automation is not enabled for live submissions.');end if;
 if not b.sending_enabled or b.status<>'active' then warnings:=warnings||jsonb_build_array('SMS sending is disabled or paused for this business.');end if;
 if cfg is null or coalesce(jsonb_array_length(cfg->'steps'),0)=0 then
  return result||jsonb_build_object('rows','[]'::jsonb,'totalSends',0,'truncated',false,'warnings',warnings,'outcome','Form answers are valid. Add messages and timing to preview an automation.');end if;
 perform sms_private.validate_form_sequence(cfg,f.fields,f.preset='bookings');
 select sum((s->>'sendCount')::integer) into total from jsonb_array_elements(cfg->'steps') s;
 if not (p->>'smsOptIn')::boolean then
  return result||jsonb_build_object('rows','[]'::jsonb,'totalSends',total,'truncated',false,'warnings',warnings,'outcome','No automation: SMS consent was not selected.');end if;
 if exists(select from public.sms_contacts where tenant_id=t and phone=normalized_phone and (opted_out or not marketing_consent)) then
  return result||jsonb_build_object('rows','[]'::jsonb,'totalSends',total,'truncated',false,'warnings',warnings,'outcome','No automation: this phone has opted out or lacks messaging consent.');end if;
 if cfg->>'trigger'='submission' and exists(select from public.sms_contacts where tenant_id=t and phone=normalized_phone and enquiry_blocked) then
  return result||jsonb_build_object('rows','[]'::jsonb,'totalSends',total,'truncated',false,'warnings',warnings,'outcome','No automation: contact enquiry follow-ups are blocked.');end if;
 ctx:=jsonb_build_object('name',customer_name,'first_name',split_part(customer_name,' ',1),'phone',normalized_phone,'email',normalized_email,'business_name',b.name,'fields',answers);
 return result||sms_private.simulate_sms_sequence(cfg,ctx,start_at,appointment,b.time_zone,scenario,200)||jsonb_build_object('warnings',warnings);
exception when invalid_parameter_value or invalid_datetime_format or datetime_field_overflow then
 raise exception 'Check your rules and test dates: %',sqlerrm using errcode='P0001';
end $$;

create or replace function sms_private.mcp_invoke(u text,client text,tool text,p jsonb,request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid; c sms_private.mcp_connections; result jsonb; data jsonb; required_permission text; action text;
 t text:=p->>'businessId'; target text:=coalesce(p->>'automationId',p->>'formId',p->>'businessId',p->>'accountId');
 pg integer; size integer; total integer; key text:=p->>'idempotencyKey'; fingerprint text; prior sms_private.mcp_requests;
 error_code text; error_message text; state text; replay boolean:=false; allowed_keys text[];
begin
 perform pg_advisory_xact_lock(hashtextextended('platform:privileges',0));
 -- Failure responses are returned, not raised, so denied attempts are audited.
 begin
  aid:=sms_private.platform_actor(u);
  if aid is null or not sms_private.platform_staff(aid) then raise exception 'Active CRM staff required' using errcode='42501'; end if;
  if client is null or length(client) not between 1 and 2048 then raise exception 'Invalid OAuth client'; end if;
  insert into sms_private.mcp_connections(issuer,subject,account_id,client_id)
   values(sms_private.login_issuer(),u,aid,client) on conflict(issuer,subject,client_id) do nothing;
 exception when others then
  insert into sms_private.mcp_activity(actor_id,tool,target,request_id,outcome,code)
   values(aid,left(tool,100),left(target,255),request_id,'denied','PERMISSION_DENIED');
  return jsonb_build_object('ok',false,'error',jsonb_build_object('code','PERMISSION_DENIED','message','Active CRM staff required','retryable',false));
 end;
 select * into c from sms_private.mcp_connections where issuer=sms_private.login_issuer() and subject=u and client_id=client for update;
 begin
  if c.id is null or c.account_id is distinct from aid then raise exception 'Connection identity mismatch' using errcode='42501'; end if;
  update sms_private.mcp_connections set last_used_at=now() where id=c.id;
  if tool='crm_get_access' then
   data:=jsonb_build_object('connectionId',c.id,'status',c.status,'permissions',case when c.status='active' then to_jsonb(c.permissions) else '[]'::jsonb end,
    'businessScope',case when c.status<>'active' then 'none' when c.all_businesses then 'all' else 'selected' end,
    'businesses',case when c.status='active' then coalesce((select jsonb_agg(jsonb_build_object('id',tenant_id,'name',name) order by tenant_id) from (select tenant_id,name from public.sms_businesses where c.all_businesses or tenant_id=any(c.business_ids) order by tenant_id limit 100) b),'[]') else '[]'::jsonb end);
  else
   if c.status<>'active' then raise exception 'Connection is not active' using errcode='42501'; end if;
   required_permission:=case tool when 'crm_search_customers' then 'read' when 'crm_get_customer' then 'read'
    when 'crm_create_sms_automation' then 'automation_draft' when 'crm_save_sms_automation_draft' then 'automation_draft'
    when 'crm_preview_sms_automation' then 'automation_preview'
    when 'crm_list_sms_automations' then 'automation_read' when 'crm_get_sms_automation' then 'automation_read'
    when 'crm_search_sms_contacts' then 'automation_read' when 'crm_list_form_submissions' then 'automation_read'
    when 'crm_list_businesses' then 'read' when 'crm_get_business' then 'read'
    when 'crm_save_business_profile_draft' then 'draft' when 'crm_review_business_profile' then 'review'
    when 'crm_add_business_service' then 'service_add' when 'crm_set_service_visibility' then 'visibility' end;
   if required_permission is null or not required_permission=any(c.permissions) then raise exception 'Action is not granted' using errcode='42501'; end if;
   if tool in ('crm_create_sms_automation','crm_save_sms_automation_draft','crm_preview_sms_automation','crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_business','crm_save_business_profile_draft','crm_review_business_profile','crm_add_business_service','crm_set_service_visibility')
    and (t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t)) then raise exception 'Business access denied' using errcode='42501'; end if;
   if tool='crm_preview_sms_automation' then
    data:=sms_private.mcp_sms_preview(u,t,p);
   elsif tool in ('crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions') then
    data:=sms_private.mcp_sms_read(u,t,tool,p);
   elsif tool='crm_get_business' then
    data:=jsonb_build_object('business',sms_private.mcp_business(t));
   elsif tool='crm_list_businesses' then
    pg:=greatest(1,least(coalesce((p->>'page')::integer,1),100000));size:=greatest(1,least(coalesce((p->>'pageSize')::integer,25),100));
    select count(*) into total from public.sms_businesses where (c.all_businesses or tenant_id=any(c.business_ids)) and name ilike '%'||left(coalesce(p->>'q',''),100)||'%';
    select coalesce(jsonb_agg(jsonb_build_object('id',x.tenant_id,'name',x.name,'timeZone',x.time_zone) order by x.tenant_id),'[]') into result
     from(select tenant_id,name,time_zone from public.sms_businesses where (c.all_businesses or tenant_id=any(c.business_ids)) and name ilike '%'||left(coalesce(p->>'q',''),100)||'%' order by tenant_id limit size offset (pg-1)*size)x;
    data:=jsonb_build_object('businesses',result,'total',total,'page',pg,'pageSize',size);
   elsif tool in ('crm_search_customers','crm_get_customer') then
    pg:=greatest(1,least(coalesce((p->>'page')::integer,1),100000));size:=greatest(1,least(coalesce((p->>'pageSize')::integer,25),100));
    with eligible as materialized (
     select a.id,a.clerk_display_name,a.clerk_primary_email,a.status,a.onboarding_completed_at from public.dashboard_accounts a
     where exists(select from public.platform_account_identities i cross join public.platform_runtime r where i.account_id=a.id and i.issuer=r.customer_issuer and i.deleted_at is null)
      and ('global_customer_lookup'=any(c.permissions) or exists(select from public.platform_business_memberships m where m.account_id=a.id and m.enabled and (c.all_businesses or m.tenant_id=any(c.business_ids))))
      and (tool<>'crm_get_customer' or a.id=(p->>'accountId')::uuid)
      and (tool<>'crm_search_customers' or concat_ws(' ',a.clerk_display_name,a.clerk_primary_email) ilike '%'||left(coalesce(p->>'q',''),100)||'%')
    ), page_rows as(select * from eligible order by id limit size offset (pg-1)*size)
    select (select count(*) from eligible),coalesce(jsonb_agg(jsonb_build_object('id',a.id,'name',a.clerk_display_name,'email',a.clerk_primary_email,'status',a.status,
     'onboardingCompletedAt',a.onboarding_completed_at,'businesses',coalesce((select jsonb_agg(jsonb_build_object('id',b.tenant_id,'name',b.name) order by b.tenant_id) from public.sms_businesses b
      where (c.all_businesses or b.tenant_id=any(c.business_ids)) and exists(select from public.platform_business_memberships m where m.tenant_id=b.tenant_id and m.account_id=a.id and m.enabled)),'[]')) order by a.id),'[]')
     into total,result from page_rows a;
    if tool='crm_get_customer' and total=0 then raise exception 'Customer unavailable' using errcode='42501'; end if;
    data:=case when tool='crm_get_customer' then jsonb_build_object('customer',result->0) else jsonb_build_object('customers',result,'total',total,'page',pg,'pageSize',size) end;
   else
    if jsonb_typeof(p->'idempotencyKey') is distinct from 'string' or key is null or length(key) not between 8 and 128 then raise exception 'An idempotency key of 8 to 128 characters is required'; end if;
    fingerprint:=encode(sha256(convert_to((p-'idempotencyKey')::text,'UTF8')),'hex');
    select * into prior from sms_private.mcp_requests where connection_id=c.id and idempotency_key=key;
    if found then
     if prior.tool<>tool or prior.fingerprint<>fingerprint then raise exception 'Idempotency key was used for a different request' using errcode='40001'; end if;
     data:=prior.result;replay:=true;
    else
     if tool in ('crm_create_sms_automation','crm_save_sms_automation_draft') then
      data:=sms_private.mcp_sms_draft(u,t,tool,p,c.id);
     else
     action:=case tool when 'crm_save_business_profile_draft' then 'business_profile_draft' when 'crm_review_business_profile' then 'business_profile_review'
      when 'crm_add_business_service' then 'service_add' when 'crm_set_service_visibility' then 'service_visibility' end;
     allowed_keys:=case when action in ('business_profile_draft','business_profile_review') then array['businessId','idempotencyKey','revision','profile']
      when action='service_add' then array['businessId','idempotencyKey','kind','siteId','siteRevision'] else array['businessId','idempotencyKey','serviceId','revision','visibility'] end;
     if exists(select from jsonb_object_keys(p) key_name where not key_name=any(allowed_keys)) then raise exception 'Unexpected input field'; end if;
     if action='service_add' and p->>'kind'='website' and not exists(select from public.hosting_sites where id=(p->>'siteId')::uuid and sms_tenant_id=t)
      then raise exception 'Website must already be linked to the permitted business' using errcode='42501'; end if;
     if action='service_visibility' and not exists(select from public.platform_business_services where id=(p->>'serviceId')::uuid and tenant_id=t)
      then raise exception 'Service access denied' using errcode='42501'; end if;
     result:=sms_private.platform_action(u,action,(p-'businessId'-'idempotencyKey')||jsonb_build_object('tenantId',t));
     data:=jsonb_build_object('record',result,'businessId',t,'databaseStatus','committed',
      'providerSetup',case when action='service_add' and p->>'kind'='sms' then
       jsonb_build_object('state',(select provisioning_state from sms_private.providers where tenant_id=t),
        'jobs',coalesce((select jsonb_agg(jsonb_build_object('id',j.id,'status',j.status) order by j.created_at desc,j.id) from
         (select id,status,created_at from sms_private.jobs where tenant_id=t and queue='provisioning_jobs' order by created_at desc,id limit 20) j),'[]'))
       else null end);
     end if;
     insert into sms_private.mcp_requests(connection_id,idempotency_key,tool,fingerprint,result) values(c.id,key,tool,fingerprint,data);
    end if;
   end if;
  end if;
  result:=jsonb_build_object('ok',true,'data',data);
 exception when others then
  get stacked diagnostics state=returned_sqlstate,error_message=message_text;
  error_code:=case when state='42501' then 'PERMISSION_DENIED' when state in ('23505','40001') then 'CONFLICT' when state in ('P0001','22P02','22023','23514','23502','P0002') then 'VALIDATION_ERROR' else 'TEMPORARY_FAILURE' end;
  if error_code='TEMPORARY_FAILURE' then error_message:='Service temporarily unavailable. Retry with the same idempotency key.'; end if;
  result:=jsonb_build_object('ok',false,'error',jsonb_build_object('code',error_code,'message',error_message,'retryable',error_code='TEMPORARY_FAILURE'));
 end;
 insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,code,revision)
  values(c.id,aid,left(tool,100),left(coalesce(data->'automation'->>'id',target),255),request_id,case when error_code is not null then 'denied' when replay then 'replayed' else 'success' end,error_code,
   case when error_code is null then coalesce((data->'source'->>'revision')::bigint,(data->'automation'->>'revision')::bigint,(data->'record'->>'revision')::bigint,(data->'business'->'setup'->>'revision')::bigint) end);
 return result;
end $$;


revoke all on function sms_private.mcp_sms_validate_sequence(jsonb,text,jsonb,text),sms_private.simulate_sms_sequence(jsonb,jsonb,timestamptz,timestamptz,text,text,integer),sms_private.mcp_sms_draft(text,text,text,jsonb,uuid),sms_private.mcp_sms_preview(text,text,jsonb) from public,anon,authenticated,sms_api,crm_mcp;
