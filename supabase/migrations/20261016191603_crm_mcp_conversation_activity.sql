-- CRM-owned forward migration. Generated input contracts are private, not RPCs.
create table sms_private.mcp_input_schemas(tool text primary key, schema jsonb not null);
alter table sms_private.mcp_input_schemas enable row level security;
revoke all on sms_private.mcp_input_schemas from public,anon,authenticated,service_role,sms_api,crm_mcp;

create function sms_private.mcp_validate_json(v jsonb,s jsonb,depth integer default 0) returns void
language plpgsql set search_path='' as $$
declare k text; item jsonb; branch jsonb; matched boolean:=false; typ text; n integer;
begin
 if depth>24 or s is null or v is null then raise exception 'Invalid input' using errcode='22023';end if;
 if exists(select from jsonb_object_keys(s) x where x<>all(array['$schema','type','properties','required','additionalProperties','items','minimum','maximum','minLength','maxLength','enum','const','anyOf','allOf','format','pattern','minItems','maxItems','uniqueItems','default','description'])) then raise exception 'Unsupported input contract' using errcode='XX000';end if;
 if s ? 'anyOf' then
  for branch in select value from jsonb_array_elements(s->'anyOf') loop
   begin perform sms_private.mcp_validate_json(v,branch,depth+1);matched:=true;exit;exception when sqlstate '22023' then null;end;
  end loop;
  if not matched then raise exception 'Invalid input alternative' using errcode='22023';end if;
 end if;
 if s ? 'allOf' then for branch in select value from jsonb_array_elements(s->'allOf') loop perform sms_private.mcp_validate_json(v,branch,depth+1);end loop;end if;
 typ:=jsonb_typeof(v);
 if s ? 'type' and not (s->'type'=to_jsonb(typ) or s->'type' ? typ or (typ='number' and (s->>'type'='integer' or s->'type' ? 'integer') and (v#>>'{}')::numeric=trunc((v#>>'{}')::numeric))) then raise exception 'Invalid input type' using errcode='22023';end if;
 if s ? 'enum' and not exists(select from jsonb_array_elements(s->'enum') x where x=v) then raise exception 'Invalid input choice' using errcode='22023';end if;
 if s ? 'const' and s->'const'<>v then raise exception 'Invalid constant' using errcode='22023';end if;
 if typ='object' then
  for k in select jsonb_array_elements_text(coalesce(s->'required','[]')) loop if not v ? k then raise exception 'Required field missing: %',k using errcode='22023';end if;end loop;
  for k,item in select * from jsonb_each(v) loop
   if s->'properties' ? k then perform sms_private.mcp_validate_json(item,s->'properties'->k,depth+1);
   elsif s->'additionalProperties'='false'::jsonb then raise exception 'Unexpected input field: %',k using errcode='22023';end if;
  end loop;
 elsif typ='array' then
  n:=jsonb_array_length(v);
  if n<coalesce((s->>'minItems')::integer,0) or n>coalesce((s->>'maxItems')::integer,10000) then raise exception 'Invalid array size' using errcode='22023';end if;
  if s->'uniqueItems'='true'::jsonb and (select count(distinct x) from jsonb_array_elements(v) x)<>n then raise exception 'Duplicate input items' using errcode='22023';end if;
  for item in select value from jsonb_array_elements(v) loop perform sms_private.mcp_validate_json(item,s->'items',depth+1);end loop;
 elsif typ='string' then
  k:=v#>>'{}';select coalesce(sum(case when ascii(ch)>65535 then 2 else 1 end),0) into n from unnest(string_to_array(k,null)) ch;
  if n<coalesce((s->>'minLength')::integer,0) or n>coalesce((s->>'maxLength')::integer,1000000) then raise exception 'Invalid string length' using errcode='22023';end if;
  if s ? 'pattern' and k !~ (s->>'pattern') then raise exception 'Invalid string format' using errcode='22023';end if;
  if s->>'format'='uuid' and k !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid UUID' using errcode='22023';end if;
  if s->>'format'='date' then
   if k !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Invalid date' using errcode='22023';end if;
   begin perform k::date;exception when others then raise exception 'Invalid date' using errcode='22023';end;
  end if;
  if s->>'format'='date-time' then
   if k !~ '(Z|[+-][0-9]{2}:[0-9]{2})$' then raise exception 'Explicit time offset required' using errcode='22023';end if;
   begin perform k::timestamptz;exception when others then raise exception 'Invalid date/time' using errcode='22023';end;
  end if;
 elsif typ='number' then
  if s ? 'minimum' and (v#>>'{}')::numeric<(s->>'minimum')::numeric or s ? 'maximum' and (v#>>'{}')::numeric>(s->>'maximum')::numeric then raise exception 'Number outside bounds' using errcode='22023';end if;
 end if;
end $$;
create function sms_private.mcp_validate_input(tool_name text,p jsonb) returns void
language plpgsql security definer set search_path='' as $$
declare s jsonb;begin select schema into s from sms_private.mcp_input_schemas where tool=tool_name;
 if not found then raise exception 'Missing input contract' using errcode='XX000';end if;
 perform sms_private.mcp_validate_json(p,s);end $$;
revoke all on function sms_private.mcp_validate_json(jsonb,jsonb,integer),sms_private.mcp_validate_input(text,jsonb)
 from public,anon,authenticated,service_role,sms_api,crm_mcp,sms_sender,sms_webhook,sms_ai,sms_automation;

-- Activity changes are not SMS lifecycle changes. A separate revision covers
-- tag membership, attribution and incoming activity across UI/worker/MCP writers.
alter table sms_private.form_runs add column activity_revision bigint not null default 1 check(activity_revision between 1 and 9007199254740991);
create function sms_private.mcp_activity_revision() returns trigger language plpgsql security definer set search_path='' as $$
declare old_run uuid;new_run uuid;tenant text;r record;
begin
 if tg_op<>'INSERT' then old_run:=old.run_id;tenant:=old.tenant_id;end if;
 if tg_op<>'DELETE' then new_run:=new.run_id;tenant:=new.tenant_id;end if;
 for r in select id from sms_private.form_runs where tenant_id=tenant and id in (old_run,new_run) order by id for update loop
  update sms_private.form_runs set activity_revision=activity_revision+1 where id=r.id;
 end loop;return null;
end $$;
create trigger mcp_activity_tag_revision after insert or update or delete on sms_private.activity_run_tags for each row execute function sms_private.mcp_activity_revision();
create trigger mcp_activity_booking_revision after insert or update or delete on sms_private.activity_bookings for each row execute function sms_private.mcp_activity_revision();
create trigger mcp_activity_response_revision after insert or update or delete on sms_private.activity_responses for each row execute function sms_private.mcp_activity_revision();
create trigger mcp_activity_event_revision after insert or update or delete on sms_private.activity_events for each row execute function sms_private.mcp_activity_revision();
revoke all on function sms_private.mcp_activity_revision() from public,anon,authenticated,service_role,sms_api,crm_mcp,sms_sender,sms_webhook,sms_ai,sms_automation;

create function sms_private.mcp_activity_action(u text,t text,tool text,p jsonb,connection_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare c public.sms_conversations; dest public.sms_conversations; m public.sms_messages; h public.sms_handoffs;
 r sms_private.form_runs; tg sms_private.activity_tags; previous bigint; target_rev bigint; result jsonb; rows jsonb;
 total bigint; pg integer:=coalesce((p->>'page')::integer,1);size integer:=coalesce((p->>'pageSize')::integer,25);action text;args jsonb;
begin
 perform sms_private.mcp_validate_input(tool,p);
 if tool in ('crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message') then
  -- Coordination lock first, then consistently ordered conversation locks.
  select * into c from public.sms_conversations where tenant_id=t and id=(p->>'conversationId')::uuid;
  if not found then raise exception 'Conversation unavailable' using errcode='42501';end if;
  perform sms_private.coordination_lock(t,c.phone);
  if tool='crm_reassign_conversation_message' then
   select * into dest from public.sms_conversations where tenant_id=t and id=(p->>'targetConversationId')::uuid and phone=c.phone;
   if not found then raise exception 'Same-contact conversation required' using errcode='42501';end if;
   perform 1 from public.sms_conversations where tenant_id=t and id in(c.id,dest.id) order by id for update;
   target_rev:=sms_private.lock_conversation_revision(u,t,dest.id,p->'targetRevision');
  end if;
  previous:=sms_private.lock_conversation_revision(u,t,c.id,p->'revision');
  if tool='crm_reassign_conversation_message' then
   select * into m from public.sms_messages where tenant_id=t and id=(p->>'messageId')::uuid and conversation_id=c.id and contact_phone=c.phone and direction='inbound' for update nowait;
   if not found then raise exception 'Inbound message unavailable' using errcode='42501';end if;
   if exists(select from sms_private.jobs where tenant_id=t and status in ('submitting','submission_unknown') and queue='sms_send_jobs' and payload->'request'->>'conversation_id' in(c.id::text,dest.id::text)) then raise exception 'Submission needs reconciliation' using errcode='40001';end if;
   result:=sms_private.reassign_inbound_message(u,t,m.id,dest.group_id);
   if result->>'conversationId' is distinct from dest.id::text then raise exception 'Reassignment target mismatch' using errcode='XX000';end if;
   return jsonb_build_object('businessId',t,'databaseStatus','committed','conversationId',c.id,'previousRevision',previous,'revision',(select revision from public.sms_conversations where tenant_id=t and id=c.id),'targetConversationId',dest.id,'targetRevision',(select revision from public.sms_conversations where tenant_id=t and id=dest.id),'messageId',m.id,'changed',result->'changed');
  end if;
  if tool='crm_resume_conversation_ai' then
   perform 1 from public.sms_contacts where tenant_id=t and phone=c.phone and not opted_out for share nowait;
   if not found then raise exception 'Contact suppression prevents AI resumption' using errcode='42501';end if;
  end if;
  perform sms_private.conversation_action(u,t,c.id,case when tool='crm_pause_conversation_ai' then 'pause' else 'resume' end,'{}');
  select * into c from public.sms_conversations where tenant_id=t and id=c.id;
  return jsonb_build_object('businessId',t,'databaseStatus','committed','conversationId',c.id,'previousRevision',previous,'revision',c.revision,'aiPaused',c.ai_paused);
 elsif tool='crm_retry_handoff_alert' then
  select h0.* into h from public.sms_handoffs h0 join public.sms_contacts c0 on c0.tenant_id=h0.tenant_id and c0.id=h0.contact_id where h0.tenant_id=t and h0.id=(p->>'handoffId')::uuid for update of h0;
  if not found then raise exception 'Handoff unavailable' using errcode='42501';end if;
  if h.revision<>(p->>'revision')::bigint then raise exception 'Handoff changed; reread' using errcode='40001';end if;
  perform 1 from sms_private.jobs where tenant_id=t and dedupe_key='handoff-alert:'||h.id order by id for update nowait;
  if h.alert_status is distinct from 'failed' or exists(select from sms_private.jobs where tenant_id=t and dedupe_key='handoff-alert:'||h.id and status<>'failed') then raise exception 'Only definite failed alerts can be retried' using errcode='40001';end if;
  previous:=h.revision;result:=sms_private.retry_handoff_alert(u,t,h.id);
  return jsonb_build_object('businessId',t,'databaseStatus','committed','handoffId',h.id,'previousRevision',previous,'revision',(select revision from public.sms_handoffs where tenant_id=t and id=h.id),'jobId',result->>'jobId','deliveryStatus','queued');
 elsif tool='crm_get_activity_report' then
  result:=sms_private.automation_activity(u,t,'report',p-'businessId');
  return jsonb_build_object('businessId',t,'timeZone',result->'timeZone','reportingAt',result->'reportingAt','from',result->'from','to',result->'to','scope',coalesce(p->>'scope','enquiry'),'funnel',case when p->>'scope'='direct' then coalesce(result->'directFunnel',result->'funnel') else result->'funnel' end,'activity',result->'activity','outcomes',result->'outcomes','workload',result->'workload');
 elsif tool='crm_list_activity_tags' then
  with eligible as materialized(select * from sms_private.activity_tags where tenant_id=t and (coalesce((p->>'includeArchived')::boolean,false) or not archived)),selected as(select * from eligible order by name,id limit size offset(pg-1)*size)
  select (select count(*) from eligible),coalesce(jsonb_agg(jsonb_build_object('id',id,'name',name,'archived',archived,'revision',revision) order by name,id),'[]') into total,rows from selected;
  return jsonb_build_object('businessId',t,'tags',rows,'total',total,'page',pg,'pageSize',size);
 elsif tool in ('crm_create_activity_tag','crm_update_activity_tag') then
  if tool='crm_update_activity_tag' then
   select * into tg from sms_private.activity_tags where tenant_id=t and id=(p->>'tagId')::uuid for update;
   if not found then raise exception 'Tag unavailable' using errcode='42501';end if;previous:=tg.revision;
   if tg.revision<>(p->>'revision')::bigint then raise exception 'Tag changed' using errcode='40001';end if;
  end if;
  result:=sms_private.automation_activity(u,t,'tag',(p-'businessId'-'idempotencyKey'-'tagId')||case when tg.id is null then '{}'::jsonb else jsonb_build_object('id',tg.id) end);
  return jsonb_build_object('businessId',t,'databaseStatus','committed','tagId',result->'tag'->'id','previousRevision',previous,'revision',result->'tag'->'revision');
 end if;
 select x.* into r from sms_private.form_runs x join public.sms_contacts c0 on c0.tenant_id=x.tenant_id and c0.phone=x.phone
  where x.tenant_id=t and x.id=(p->>'runId')::uuid;
 if not found then raise exception 'Enquiry unavailable' using errcode='42501';end if;
 if tool='crm_get_enquiry_attribution_context' then
  with candidates as (
   select b.id,coalesce(a.revision,0)::bigint revision,a.run_id linked_run_id,b.status label,null::boolean present from public.sms_bookings b left join sms_private.activity_bookings a on a.tenant_id=b.tenant_id and a.booking_id=b.id
    where p->>'kind'='bookings' and b.tenant_id=t and coalesce(b.customer_phone,(select phone from public.sms_contacts where tenant_id=t and id=b.contact_id))=r.phone
   union all select m0.id::text,coalesce(a.revision,0)::bigint,a.run_id,m0.status,null::boolean from public.sms_messages m0 left join sms_private.activity_responses a on a.tenant_id=m0.tenant_id and a.message_id=m0.id
    where p->>'kind'='responses' and m0.tenant_id=t and m0.contact_phone=r.phone and m0.direction='inbound'
   union all select e.id::text,e.revision::bigint,e.run_id,e.kind,null::boolean from sms_private.activity_events e left join public.sms_conversations cv on cv.tenant_id=e.tenant_id and cv.id::text=e.details->>'conversationId'
    where p->>'kind'='events' and e.tenant_id=t and e.kind in('ai_action','ai_run','ai_sent') and coalesce(e.details->>'phone',cv.phone)=r.phone
   union all select tag.id::text,tag.revision::bigint,null::uuid,tag.name,exists(select from sms_private.activity_run_tags a where a.tenant_id=t and a.run_id=r.id and a.tag_id=tag.id)
    from sms_private.activity_tags tag where p->>'kind'='tags' and tag.tenant_id=t and not tag.archived
  ), selected as(select * from candidates order by id limit size offset(pg-1)*size)
  select (select count(*) from candidates),coalesce(jsonb_agg(jsonb_build_object('id',id,'revision',revision,'linkedRunId',case when exists(select from sms_private.form_runs rr where rr.tenant_id=t and rr.id=linked_run_id and rr.phone=r.phone) then linked_run_id else null end,'label',left(label,100),'present',present) order by id),'[]') into total,rows from selected;
  return jsonb_build_object('businessId',t,'runId',r.id,'activityRevision',r.activity_revision,'generation',r.generation,'kind',p->>'kind','rows',rows,'total',total,'page',pg,'pageSize',size);
 end if;
 perform sms_private.coordination_lock(t,r.phone);
 select * into r from sms_private.form_runs where tenant_id=t and id=r.id for update;
 if r.activity_revision<>(p->>'activityRevision')::bigint or r.generation<>(p->>'generation')::bigint then raise exception 'Enquiry activity changed; reread' using errcode='40001';end if;
 previous:=r.activity_revision;
 action:=case tool when 'crm_set_enquiry_tag' then 'tag_assignment' when 'crm_link_enquiry_booking' then 'booking_link' when 'crm_link_enquiry_response' then 'response_link' when 'crm_link_enquiry_activity' then 'activity_link' end;
 if action is null then raise exception 'Unknown activity tool' using errcode='22023';end if;
 if action='tag_assignment' then
  select * into tg from sms_private.activity_tags where tenant_id=t and id=(p->>'tagId')::uuid for share;
  if not found or tg.archived then raise exception 'Active tag unavailable' using errcode='42501';end if;
  if tg.revision<>(p->>'tagRevision')::bigint then raise exception 'Tag changed' using errcode='40001';end if;
 end if;
 perform sms_private.automation_activity(u,t,action,p-'businessId'-'idempotencyKey'-'activityRevision'-'generation'-'tagRevision');
 select * into r from sms_private.form_runs where tenant_id=t and id=r.id;
 result:=case action
 when 'tag_assignment' then jsonb_build_object('kind','tag','id',tg.id,'previousRevision',tg.revision,'revision',tg.revision)
 when 'booking_link' then jsonb_build_object('kind','booking','id',p->>'bookingId','previousRevision',p->'revision','revision',(select revision from sms_private.activity_bookings where tenant_id=t and booking_id=p->>'bookingId'))
 when 'response_link' then jsonb_build_object('kind','response','id',p->>'messageId','previousRevision',p->'revision','revision',(select revision from sms_private.activity_responses where tenant_id=t and message_id=(p->>'messageId')::uuid))
 else jsonb_build_object('kind','activity','id',p->>'eventId','previousRevision',p->'revision','revision',(select revision from sms_private.activity_events where tenant_id=t and id=(p->>'eventId')::bigint)) end;
 return jsonb_build_object('businessId',t,'databaseStatus','committed','runId',r.id,'previousRevision',previous,'revision',r.activity_revision,'generation',r.generation,'relatedRecord',result);
end $$;
revoke all on function sms_private.mcp_activity_action(text,text,text,jsonb,uuid)
 from public,anon,authenticated,service_role,sms_api,crm_mcp,sms_sender,sms_webhook,sms_ai,sms_automation;

-- GENERATED MCP CONTRACTS
insert into sms_private.mcp_input_schemas values('crm_pause_conversation_ai','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"conversationId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","conversationId","revision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_resume_conversation_ai','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"conversationId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","conversationId","revision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_reassign_conversation_message','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"conversationId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128},"messageId":{"type":"string","format":"uuid"},"targetConversationId":{"type":"string","format":"uuid"},"targetRevision":{"type":"integer","minimum":1,"maximum":9007199254740991}},"required":["businessId","conversationId","revision","idempotencyKey","messageId","targetConversationId","targetRevision"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_retry_handoff_alert','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"handoffId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","handoffId","revision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_activity_report','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"from":{"type":"string","format":"date"},"to":{"type":"string","format":"date"},"scope":{"type":"string","enum":["enquiry","appointment","test","direct"],"default":"enquiry"}},"required":["businessId","from","to"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_list_activity_tags','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"page":{"type":"integer","minimum":1,"maximum":100000,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":25},"includeArchived":{"type":"boolean","default":false}},"required":["businessId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_enquiry_attribution_context','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"runId":{"type":"string","format":"uuid"},"kind":{"type":"string","enum":["bookings","responses","events","tags"]},"page":{"type":"integer","minimum":1,"maximum":100000,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":25}},"required":["businessId","runId","kind"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_create_activity_tag','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"name":{"type":"string","minLength":1,"maxLength":40},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","name","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_update_activity_tag','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"tagId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"name":{"type":"string","minLength":1,"maxLength":40},"archived":{"type":"boolean"},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","tagId","revision","name","archived","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_set_enquiry_tag','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"runId":{"type":"string","format":"uuid"},"activityRevision":{"type":"integer","minimum":1,"maximum":9007199254740991},"generation":{"type":"integer","minimum":0,"maximum":9007199254740991},"tagId":{"type":"string","format":"uuid"},"tagRevision":{"type":"integer","minimum":1,"maximum":9007199254740991},"present":{"type":"boolean"},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","runId","activityRevision","generation","tagId","tagRevision","present","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_link_enquiry_booking','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"runId":{"type":"string","format":"uuid"},"activityRevision":{"type":"integer","minimum":1,"maximum":9007199254740991},"generation":{"type":"integer","minimum":0,"maximum":9007199254740991},"bookingId":{"type":"string","minLength":1,"maxLength":255},"revision":{"type":"integer","minimum":0,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","runId","activityRevision","generation","bookingId","revision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_link_enquiry_response','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"runId":{"type":"string","format":"uuid"},"activityRevision":{"type":"integer","minimum":1,"maximum":9007199254740991},"generation":{"type":"integer","minimum":0,"maximum":9007199254740991},"messageId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":0,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","runId","activityRevision","generation","messageId","revision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_link_enquiry_activity','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"runId":{"type":"string","format":"uuid"},"activityRevision":{"type":"integer","minimum":1,"maximum":9007199254740991},"generation":{"type":"integer","minimum":0,"maximum":9007199254740991},"eventId":{"type":"integer","minimum":1,"maximum":9007199254740991},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","runId","activityRevision","generation","eventId","revision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
alter table sms_private.mcp_connections drop constraint mcp_connections_permissions_check;
alter table sms_private.mcp_connections add constraint mcp_connections_permissions_check check(permissions <@ array['conversation_ai_pause','conversation_ai_resume','conversation_message_reassign','handoff_alert_retry','activity_report_read','activity_tag_manage','activity_attribution_update','read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read','contact_read','contact_create','contact_edit','consent_read','consent_opt_in','contact_suppress','contact_automation_block','sms_message_preview','sms_message_send']::text[]);
create or replace function sms_private.mcp_admin(u text,action text,p jsonb default '{}') returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid; c sms_private.mcp_connections; result jsonb; perms text[]; businesses text[];
 pg integer:=greatest(1,least(coalesce((p->>'page')::integer,1),100000)); total integer;
begin
 -- Match the platform's privilege/ownership lock order; grants cannot race a write.
 perform pg_advisory_xact_lock(hashtextextended('platform:privileges',0));
 aid:=sms_private.platform_actor(u);
 if aid is null or not sms_private.platform_staff(aid) then raise exception 'CRM staff required' using errcode='42501'; end if;
 if action='list' then
  select count(*) into total from sms_private.mcp_connections;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.created_at desc,x.id),'[]') into result from (
   select listed.*,a.clerk_display_name as staff_name,
    coalesce((select jsonb_object_agg(b.tenant_id,b.name) from public.sms_businesses b where b.tenant_id=any(listed.business_ids)),'{}') as business_labels
    from sms_private.mcp_connections listed
    left join public.dashboard_accounts a on a.id=listed.account_id order by listed.created_at desc,listed.id limit 25 offset (pg-1)*25) x;
  return jsonb_build_object('connections',result,'page',pg,'total',total,'totalPages',greatest(1,ceil(total/25.0)));
 elsif action='activity' then
  select count(*) into total from sms_private.mcp_activity where connection_id=(p->>'connectionId')::uuid;
  select coalesce(jsonb_agg(to_jsonb(x) order by x.id desc),'[]') into result from (
   select * from sms_private.mcp_activity where connection_id=(p->>'connectionId')::uuid order by id desc limit 50 offset (pg-1)*50) x;
  return jsonb_build_object('activity',result,'page',pg,'total',total,'totalPages',greatest(1,ceil(total/50.0)));
 elsif action='save' then
  select * into c from sms_private.mcp_connections where id=(p->>'connectionId')::uuid for update;
  if c.id is null then raise exception 'Connection not found'; end if;
  if c.revision is distinct from (p->>'revision')::bigint then raise exception 'Connection changed; refresh and retry' using errcode='40001'; end if;
  if c.status='revoked' then raise exception 'Revoked connections cannot be reactivated' using errcode='42501'; end if;
  if coalesce(p->>'status','') not in ('active','disabled','revoked') then raise exception 'Invalid connection status'; end if;
  if jsonb_typeof(p->'permissions') is distinct from 'array' or jsonb_typeof(p->'businessIds') is distinct from 'array' then raise exception 'Permissions and businesses are required'; end if;
  select coalesce(array_agg(distinct x),'{}') into perms from jsonb_array_elements_text(p->'permissions') x;
  select coalesce(array_agg(distinct x),'{}') into businesses from jsonb_array_elements_text(p->'businessIds') x;
  if not perms <@ array['conversation_ai_pause','conversation_ai_resume','conversation_message_reassign','handoff_alert_retry','activity_report_read','activity_tag_manage','activity_attribution_update','read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read','contact_read','contact_create','contact_edit','consent_read','consent_opt_in','contact_suppress','contact_automation_block','sms_message_preview','sms_message_send']::text[] or cardinality(businesses)>500
   or exists(select from unnest(businesses) t where not exists(select from public.sms_businesses b where b.tenant_id=t)) then raise exception 'Invalid connection grants'; end if;
  if p->>'status'='active' and not sms_private.platform_staff(c.account_id) then raise exception 'Connection owner must be active CRM staff' using errcode='42501'; end if;
  if p ? 'allBusinesses' and jsonb_typeof(p->'allBusinesses')<>'boolean' then raise exception 'Invalid business scope'; end if;
  update sms_private.mcp_connections set status=p->>'status',permissions=perms,business_ids=businesses,all_businesses=coalesce((p->>'allBusinesses')::boolean,false),revision=revision+1 where id=c.id returning to_jsonb(mcp_connections.*) into result;
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision)
   values(c.id,aid,'connection_'||(p->>'status'),c.id::text,gen_random_uuid(),'success',(result->>'revision')::bigint);
  return jsonb_build_object('connection',result);
 end if;
 raise exception 'Unknown connection action';
end $$;
create or replace function sms_private.mcp_invoke(u text,client text,tool text,p jsonb,request_id uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid; c sms_private.mcp_connections; result jsonb; data jsonb; required_permission text; action text;
 t text:=p->>'businessId'; target text:=coalesce(p->>'tagId',p->>'eventId',p->>'contactId',p->>'conversationId',p->>'leadId',p->>'handoffId',p->>'submissionId',p->>'runId',p->>'automationId',p->>'formId',p->>'businessId',p->>'accountId');
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
   required_permission:=case tool when 'crm_pause_conversation_ai' then 'conversation_ai_pause' when 'crm_resume_conversation_ai' then 'conversation_ai_resume' when 'crm_reassign_conversation_message' then 'conversation_message_reassign' when 'crm_retry_handoff_alert' then 'handoff_alert_retry' when 'crm_get_activity_report' then 'activity_report_read' when 'crm_list_activity_tags' then 'activity_report_read' when 'crm_get_enquiry_attribution_context' then 'activity_report_read' when 'crm_create_activity_tag' then 'activity_tag_manage' when 'crm_update_activity_tag' then 'activity_tag_manage' when 'crm_set_enquiry_tag' then 'activity_tag_manage' when 'crm_link_enquiry_booking' then 'activity_attribution_update' when 'crm_link_enquiry_response' then 'activity_attribution_update' when 'crm_link_enquiry_activity' then 'activity_attribution_update' when 'crm_list_contacts' then 'contact_read' when 'crm_get_contact' then 'contact_read' when 'crm_get_contact_consent' then 'consent_read' when 'crm_create_contact' then 'contact_create' when 'crm_update_contact' then 'contact_edit' when 'crm_record_contact_sms_opt_in' then 'consent_opt_in' when 'crm_suppress_contact_sms' then 'contact_suppress' when 'crm_set_contact_automation_blocked' then 'contact_automation_block' when 'crm_preview_contact_sms' then 'sms_message_preview' when 'crm_send_contact_sms' then 'sms_message_send' when 'crm_reply_to_conversation' then 'conversation_reply' when 'crm_preview_conversation_reply' then 'conversation_reply' when 'crm_mark_conversation_messages_read' then 'conversation_mark_read' when 'crm_list_conversations' then 'conversation_read' when 'crm_get_conversation' then 'conversation_read' when 'crm_assign_lead' then 'lead_assign' when 'crm_set_lead_status' then 'lead_status_update' when 'crm_assign_handoff' then 'handoff_assign' when 'crm_set_handoff_status' then 'handoff_status_update' when 'crm_list_leads' then 'lead_read' when 'crm_get_lead' then 'lead_read' when 'crm_list_handoffs' then 'handoff_read' when 'crm_get_handoff' then 'handoff_read' when 'crm_get_enquiry_status' then 'enquiry_status_read' when 'crm_list_enquiries' then 'enquiry_read' when 'crm_get_enquiry' then 'enquiry_read' when 'crm_set_form_collection_enabled' then 'form_activate' when 'crm_apply_form_draft' then 'form_publish' when 'crm_preview_form' then 'form_preview' when 'crm_create_form' then 'form_create' when 'crm_save_form_draft' then 'form_edit' when 'crm_list_forms' then 'form_read' when 'crm_get_form' then 'form_read' when 'crm_search_customers' then 'read' when 'crm_get_customer' then 'read'
    when 'crm_create_sms_automation' then 'automation_draft' when 'crm_save_sms_automation_draft' then 'automation_draft'
    when 'crm_list_sms_runs' then 'automation_activity' when 'crm_get_sms_run' then 'automation_activity' when 'crm_get_sms_run_activity' then 'automation_activity'
    when 'crm_resume_sms_run' then 'automation_run_resume' when 'crm_pause_sms_run' then 'automation_run_pause_stop' when 'crm_stop_sms_run' then 'automation_run_pause_stop'
    when 'crm_get_sms_run_start_context' then 'automation_read' when 'crm_start_sms_automation_run' then 'automation_run_start'
    when 'crm_preview_sms_automation' then 'automation_preview'
    when 'crm_publish_sms_automation' then 'automation_publish' when 'crm_set_form_followups_enabled' then 'automation_enable'
    when 'crm_list_sms_automations' then 'automation_read' when 'crm_get_sms_automation' then 'automation_read'
    when 'crm_search_sms_contacts' then 'automation_read' when 'crm_list_form_submissions' then 'automation_read'
    when 'crm_list_businesses' then 'read' when 'crm_get_business' then 'read'
    when 'crm_save_business_profile_draft' then 'draft' when 'crm_review_business_profile' then 'review'
    when 'crm_add_business_service' then 'service_add' when 'crm_set_service_visibility' then 'visibility' end;
   if required_permission is null or not required_permission=any(c.permissions) then raise exception 'Action is not granted' using errcode='42501'; end if;
   if tool in ('crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_get_activity_report','crm_list_activity_tags','crm_get_enquiry_attribution_context','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity','crm_list_contacts','crm_get_contact','crm_get_contact_consent','crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_preview_contact_sms','crm_send_contact_sms','crm_reply_to_conversation','crm_preview_conversation_reply','crm_mark_conversation_messages_read','crm_list_conversations','crm_get_conversation','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status','crm_list_leads','crm_get_lead','crm_list_handoffs','crm_get_handoff','crm_get_enquiry_status','crm_list_enquiries','crm_get_enquiry','crm_set_form_collection_enabled','crm_apply_form_draft','crm_preview_form','crm_create_form','crm_save_form_draft','crm_list_forms','crm_get_form','crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity','crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run','crm_get_sms_run_start_context','crm_start_sms_automation_run','crm_publish_sms_automation','crm_set_form_followups_enabled','crm_create_sms_automation','crm_save_sms_automation_draft','crm_preview_sms_automation','crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_business','crm_save_business_profile_draft','crm_review_business_profile','crm_add_business_service','crm_set_service_visibility')
    and (t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t)) then raise exception 'Business access denied' using errcode='42501'; end if;
   if tool='crm_start_sms_automation_run' and p->>'overlapChoice'='stop_selected' and not 'automation_run_pause_stop'=any(c.permissions) then raise exception 'Stopping overlapping runs is not granted' using errcode='42501'; end if;
   if tool='crm_get_conversation' and p->'includeMessages'='true'::jsonb and not 'conversation_messages_read'=any(c.permissions) then raise exception 'Message content is not granted' using errcode='42501'; end if;
   if tool in ('crm_get_activity_report','crm_list_activity_tags','crm_get_enquiry_attribution_context') then
    data:=sms_private.mcp_activity_action(u,t,tool,p,c.id);
   elsif tool in ('crm_list_contacts','crm_get_contact','crm_get_contact_consent','crm_preview_contact_sms') then
    data:=sms_private.mcp_contact_action(u,t,tool,p,c.id);
   elsif tool='crm_preview_conversation_reply' then
    data:=sms_private.mcp_conversation_reply_preview(u,t,p);
   elsif tool in ('crm_list_conversations','crm_get_conversation') then
    data:=sms_private.mcp_conversation_read(u,t,tool,p);
   elsif tool in ('crm_list_leads','crm_get_lead','crm_list_handoffs','crm_get_handoff') then
    data:=sms_private.mcp_lead_handoff_read(u,t,tool,p);
   elsif tool='crm_get_enquiry_status' then
    data:=sms_private.mcp_enquiry_status(u,t,p);
   elsif tool in ('crm_list_enquiries','crm_get_enquiry') then
    data:=sms_private.mcp_enquiry_read(u,t,tool,p);
   elsif tool='crm_preview_form' then
    data:=sms_private.mcp_form_preview(u,t,p);
   elsif tool in ('crm_list_forms','crm_get_form') then
    data:=sms_private.mcp_form_read(u,t,tool,p);
   elsif tool in ('crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity') then
    data:=sms_private.mcp_sms_activity(u,t,tool,p);
   elsif tool='crm_get_sms_run_start_context' then
    data:=sms_private.mcp_sms_start_context(u,t,p);
   elsif tool='crm_preview_sms_automation' then
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
     if tool in ('crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity') then
      data:=sms_private.mcp_activity_action(u,t,tool,p,c.id);
     elsif tool in ('crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_send_contact_sms') then
      data:=sms_private.mcp_contact_action(u,t,tool,p,c.id);
     elsif tool='crm_reply_to_conversation' then
      data:=sms_private.mcp_conversation_reply(u,t,p,c.id);
     elsif tool='crm_mark_conversation_messages_read' then
      data:=sms_private.mcp_conversation_mark_read(u,t,p);
     elsif tool in ('crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then
      data:=sms_private.mcp_lead_handoff_write(u,t,tool,p);
     elsif tool='crm_set_form_collection_enabled' then
      data:=sms_private.mcp_form_collection(u,t,p,c.id,request_id);
     elsif tool='crm_apply_form_draft' then
      data:=sms_private.mcp_form_apply(u,t,p,c.id);
     elsif tool in ('crm_create_form','crm_save_form_draft') then
      data:=sms_private.mcp_form_draft(u,t,tool,p,c.id);
     elsif tool in ('crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run') then
      data:=sms_private.mcp_sms_control(u,t,tool,p,c.id);
     elsif tool='crm_start_sms_automation_run' then
      data:=sms_private.mcp_sms_start(u,t,p,c.id,'automation_run_pause_stop'=any(c.permissions));
     elsif tool in ('crm_publish_sms_automation','crm_set_form_followups_enabled') then
      data:=sms_private.mcp_sms_release(u,t,tool,p,c.id);
     elsif tool in ('crm_create_sms_automation','crm_save_sms_automation_draft') then
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
  error_code:=case when state='42501' then 'PERMISSION_DENIED' when state in ('23505','40001') then 'CONFLICT' when left(state,2)='22' or state in ('P0001','23514','23502','P0002') then 'VALIDATION_ERROR' else 'TEMPORARY_FAILURE' end;
  if error_code='TEMPORARY_FAILURE' then error_message:='Service temporarily unavailable. Retry with the same idempotency key.'; end if;
  result:=jsonb_build_object('ok',false,'error',jsonb_build_object('code',error_code,'message',error_message,'retryable',error_code='TEMPORARY_FAILURE'));
 end;
 insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,code,revision,draft_revision,previous_revision,changed_fields,affected_message_ids,affected_message_count)
  values(c.id,aid,left(tool,100),left(coalesce(data->>'tagId',data->>'runId',data->>'handoffId',data->>'conversationId',data->>'contactId',data->'contact'->>'id',data->'conversation'->>'id',data->'lead'->>'id',data->'handoff'->>'id',data->'enquiry'->>'id',data->'form'->>'id',data->'run'->>'id',data->'automation'->>'id',target),255),request_id,case when error_code is not null then 'denied' when replay then 'replayed' else 'success' end,error_code,
   case when error_code is null then coalesce((data->>'revision')::bigint,(data->'contact'->>'revision')::bigint,(data->'conversation'->>'revision')::bigint,(data->'lead'->>'revision')::bigint,(data->'handoff'->>'revision')::bigint,(data->'enquiryStatus'->'sms'->>'generation')::bigint,(data->'enquiryStatus'->>'submittedFormVersion')::bigint,(data->'enquiry'->>'submittedFormVersion')::bigint,(data->'form'->>'revision')::bigint,(data->'run'->>'generation')::bigint,(data->'source'->>'revision')::bigint,(data->'automation'->>'revision')::bigint,(data->'record'->>'revision')::bigint,(data->'business'->'setup'->>'revision')::bigint) end,
   case when error_code is null then (data->'form'->>'draftRevision')::bigint end,
   case when error_code is null and tool in ('crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity','crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_send_contact_sms','crm_reply_to_conversation','crm_mark_conversation_messages_read','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then (data->>'previousRevision')::bigint end,
   case when error_code is null and tool in ('crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then array(select jsonb_array_elements_text(data->'changedFields')) end,
   case when error_code is null and tool in ('crm_reply_to_conversation','crm_send_contact_sms') then array[(data->>'messageId')::uuid] when error_code is null and tool='crm_mark_conversation_messages_read' then array(select x::uuid from jsonb_array_elements_text(data->'changedMessageIds') x) end,
   case when error_code is null and tool in ('crm_reply_to_conversation','crm_send_contact_sms') then 1 when error_code is null and tool='crm_mark_conversation_messages_read' then (data->>'changedCount')::integer end);
 if error_code is null and tool='crm_start_sms_automation_run' then
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision)
   select c.id,aid,'crm_start_sms_automation_run:replace',v->>'id',request_id,case when replay then 'replayed' else 'success' end,(v->>'generation')::bigint from jsonb_array_elements(data->'stoppedRuns') v;
 end if;
 if error_code is null and data ? 'relatedRecord' then
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision,previous_revision)
   values(c.id,aid,tool||':related',data->'relatedRecord'->>'id',request_id,case when replay then 'replayed' else 'success' end,(data->'relatedRecord'->>'revision')::bigint,(data->'relatedRecord'->>'previousRevision')::bigint);
 end if;
 if error_code is null and tool='crm_reassign_conversation_message' then
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision,previous_revision,affected_message_ids,affected_message_count)
   values(c.id,aid,tool||':target',data->>'targetConversationId',request_id,case when replay then 'replayed' else 'success' end,(data->>'targetRevision')::bigint,(p->>'targetRevision')::bigint,array[(data->>'messageId')::uuid],case when (data->>'changed')::boolean then 1 else 0 end);
 end if;
 return result;
end $$;
