create or replace function sms_private.mcp_validate_json(v jsonb,s jsonb,depth integer default 0) returns void
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
   elsif jsonb_typeof(s->'additionalProperties')='object' then perform sms_private.mcp_validate_json(item,s->'additionalProperties',depth+1);
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
  if s ? 'format' and s->>'format' not in ('uuid','date','date-time') then raise exception 'Unsupported input format' using errcode='XX000';end if;
  if s->>'format'='uuid' and k !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Invalid UUID' using errcode='22023';end if;
  if s->>'format'='date' then
   if k !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then raise exception 'Invalid date' using errcode='22023';end if;
   begin perform k::date;exception when others then raise exception 'Invalid date' using errcode='22023';end;
  end if;
  if s->>'format'='date-time' then
   if k !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9](:[0-5][0-9](\.[0-9]+)?)?(Z|[+-]([01][0-9]|2[0-3]):[0-5][0-9])$' then raise exception 'Explicit time offset required' using errcode='22023';end if;
   begin perform k::timestamptz;exception when others then raise exception 'Invalid date/time' using errcode='22023';end;
  end if;
 elsif typ='number' then
  if s ? 'minimum' and (v#>>'{}')::numeric<(s->>'minimum')::numeric or s ? 'maximum' and (v#>>'{}')::numeric>(s->>'maximum')::numeric then raise exception 'Number outside bounds' using errcode='22023';end if;
 end if;
end $$;
-- CRM-owned. Existing operational booking and intake workflows only.
alter table public.sms_bookings add column revision bigint not null default 1 check(revision between 1 and 9007199254740991);
alter table public.sms_automation_bookings add column revision bigint not null default 1 check(revision between 1 and 9007199254740991);
create function sms_private.booking_shared_revision() returns trigger language plpgsql set search_path='' as $$
begin
 if new.tenant_id<>old.tenant_id or new.id<>old.id then raise exception 'Booking identity cannot change';end if;
 if tg_table_name='sms_voice_service_rules' then new.version:=old.version+1;else new.revision:=old.revision+1;end if;
 return new;
end $$;
create trigger booking_shared_revision before update on public.sms_bookings for each row execute function sms_private.booking_shared_revision();
create trigger intake_shared_revision before update on public.sms_automation_bookings for each row execute function sms_private.booking_shared_revision();
create trigger schedule_shared_revision before update on public.sms_voice_service_rules for each row execute function sms_private.booking_shared_revision();
revoke all on function sms_private.booking_shared_revision() from public,anon,authenticated,service_role,sms_api,crm_mcp;
-- Serialize all staff schedule writers before checking shared resource capacity.
alter function sms_private.voice_save_rule(text,text,jsonb) rename to voice_save_rule_before_mcp_booking;
create function sms_private.voice_save_rule(u text,t text,p jsonb) returns jsonb language plpgsql security definer set search_path='' as $$
begin
 perform sms_private.require_admin(u);if not sms_private.can_access(t,u) then raise exception 'Business access required' using errcode='42501';end if;
 perform 1 from public.sms_businesses where tenant_id=t for update;
 return sms_private.voice_save_rule_before_mcp_booking(u,t,p);
end $$;
revoke all on function sms_private.voice_save_rule_before_mcp_booking(text,text,jsonb),sms_private.voice_save_rule(text,text,jsonb) from public,anon,authenticated,service_role,sms_api,crm_mcp;
grant execute on function sms_private.voice_save_rule(text,text,jsonb) to sms_api;

create function sms_private.mcp_booking_schedule(r public.sms_voice_service_rules) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',r.id,'revision',r.version,'enabled',r.enabled,'configuration',jsonb_build_object('service',r.service,'market',r.market,'resourcePool',r.resource_pool,'timeZone',r.time_zone,'durationMinutes',r.duration_minutes,'capacity',r.capacity,'minimumNoticeMinutes',r.minimum_notice_minutes,'maximumAdvanceDays',r.maximum_advance_days,'weeklyAvailability',(select jsonb_object_agg(d::text,coalesce(r.weekly_availability->d::text,'[]')) from generate_series(0,6) d),'dateExceptions',coalesce((select jsonb_agg(jsonb_build_object('date',x->'date','closed',coalesce(x->'closed','false'),'windows',coalesce(x->'windows','[]'))) from jsonb_array_elements(r.date_exceptions) x),'[]')))
$$;
create function sms_private.mcp_booking_record(b public.sms_bookings,c public.sms_contacts) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',b.id,'revision',b.revision,'status',b.status,'contactId',c.id,'contactRevision',c.revision,'name',b.customer_name,'phone',c.phone,'appointmentAt',b.appointment_at,'timeZone',b.time_zone,'address',b.service_address,'source',b.source,'service',b.voice_service)
$$;
create function sms_private.mcp_booking_intake(r public.sms_automation_bookings) returns jsonb language sql stable set search_path='' as $$
 select jsonb_build_object('id',r.id,'revision',r.revision,'status',r.status,'name',r.name,'phone',r.phone,'appointmentAt',r.appointment_at,'intakeState',r.intake_state,'contactId',(select id from public.sms_contacts where tenant_id=r.tenant_id and phone=r.phone),'contactRevision',(select revision from public.sms_contacts where tenant_id=r.tenant_id and phone=r.phone),
 'answers',coalesce((select jsonb_agg(jsonb_build_object('key',left(key,100),'value',left(value,2500)) order by key) from (select * from jsonb_each_text(r.details) order by key limit 30) x),'[]'),
 'answersTruncated',(select count(*)>30 or coalesce(bool_or(length(key)>100 or length(value)>2500),false) from jsonb_each_text(r.details)))
$$;
revoke all on function sms_private.mcp_booking_schedule(public.sms_voice_service_rules),sms_private.mcp_booking_record(public.sms_bookings,public.sms_contacts),sms_private.mcp_booking_intake(public.sms_automation_bookings) from public,anon,authenticated,service_role,sms_api,crm_mcp;

create function sms_private.mcp_booking_action(u text,t text,tool text,p jsonb,cid uuid,rid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare b public.sms_bookings;c public.sms_contacts;after_c public.sms_contacts;i public.sms_automation_bookings;r public.sms_voice_service_rules;result jsonb;args jsonb;rows jsonb;total bigint;prev bigint;desired boolean;
 pg integer:=coalesce((p->>'page')::integer,1);size integer:=coalesce((p->>'pageSize')::integer,25);ids uuid[];email_ids uuid[];legacy_ids uuid[];intake_ids uuid[];run_ids uuid[];
begin
 perform sms_private.mcp_validate_input(tool,p);
 if tool='crm_list_bookings' then
  with eligible as materialized(select b0.*,sms_private.mcp_booking_record(b0,c0) value from public.sms_bookings b0 join public.sms_contacts c0 on c0.tenant_id=b0.tenant_id and c0.id=b0.contact_id where b0.tenant_id=t and (not p ? 'status' or b0.status=p->>'status')),
   selected as(select * from eligible order by appointment_at desc nulls last,id limit size offset(pg-1)*size)
  select (select count(*) from eligible),coalesce(jsonb_agg(value order by appointment_at desc nulls last,id),'[]') into total,rows from selected;
  return jsonb_build_object('businessId',t,'bookings',rows,'total',total,'page',pg,'pageSize',size);
 elsif tool='crm_list_booking_intakes' then
  with eligible as materialized(select * from public.sms_automation_bookings where tenant_id=t and (not p ? 'status' or status=p->>'status')),
   selected as(select * from eligible order by created_at desc,id limit size offset(pg-1)*size)
  select (select count(*) from eligible),coalesce(jsonb_agg(sms_private.mcp_booking_intake(x::public.sms_automation_bookings) order by created_at desc,id),'[]') into total,rows from selected x;
  return jsonb_build_object('businessId',t,'intakes',rows,'total',total,'page',pg,'pageSize',size);
 elsif tool='crm_list_booking_schedules' then
  with eligible as materialized(select * from public.sms_voice_service_rules where tenant_id=t),selected as(select * from eligible order by service,market,id limit size offset(pg-1)*size)
  select (select count(*) from eligible),coalesce(jsonb_agg(sms_private.mcp_booking_schedule(x::public.sms_voice_service_rules) order by service,market,id),'[]') into total,rows from selected x;
  return jsonb_build_object('businessId',t,'schedules',rows,'total',total,'page',pg,'pageSize',size);
 elsif tool in ('crm_get_booking','crm_cancel_booking') then
  select * into b from public.sms_bookings where tenant_id=t and id=p->>'bookingId';
  if not found then raise exception 'Booking unavailable' using errcode='42501';end if;
  select * into c from public.sms_contacts where tenant_id=t and id=b.contact_id;
  if not found then raise exception 'Booking unavailable' using errcode='42501';end if;
  if tool='crm_get_booking' then return jsonb_build_object('businessId',t,'booking',sms_private.mcp_booking_record(b,c));end if;
  perform sms_private.coordination_lock(t,c.phone);
  perform pg_advisory_xact_lock(hashtextextended(t||':cancel:'||b.id,993));
  select * into b from public.sms_bookings where tenant_id=t and id=b.id for update;
  if b.revision<>(p->>'revision')::bigint then raise exception 'Booking changed' using errcode='40001';end if;prev:=b.revision;
  select * into c from public.sms_contacts where tenant_id=t and id=c.id for update nowait;
  if c.revision<>(p->>'contactRevision')::bigint then raise exception 'Contact changed' using errcode='40001';end if;
  ids:=array(select id from public.sms_automation_enrollments where tenant_id=t and status in ('active','paused') and metadata->>'booking_id'=b.id order by id for update nowait);
  intake_ids:=array(select id from public.sms_automation_bookings where tenant_id=t and ((source='sms_bookings' and source_record_id=b.id) or id=b.voice_intake_id) order by id for update nowait);
  run_ids:=array(select id from sms_private.form_runs where tenant_id=t and intake_id=any(intake_ids) and status in ('active','paused') order by id for update nowait);
  email_ids:=array(select id from sms_private.email_enrollments where tenant_id=t and source_type='bookings' and source_id=any(intake_ids) and status in ('active','paused') order by id for update nowait);
  result:=sms_private.cancel_booking(u,t,b.id,'mcp:'||cid||':'||(p->>'idempotencyKey'));
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision)
   select cid,sms_private.platform_actor(u),'crm_cancel_booking:cancel_enrollment',id::text,rid,'success',generation from public.sms_automation_enrollments where tenant_id=t and id=any(ids);
  select * into after_c from public.sms_contacts where tenant_id=t and id=c.id;
  if (after_c.name is distinct from c.name or after_c.email is distinct from c.email) and not exists(select from sms_private.mcp_connections where id=cid and 'contact_edit'=any(permissions)) then raise exception 'Shared contact changes require contact_edit' using errcode='42501';end if;
  if after_c.revision<>c.revision then insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,previous_revision,revision) values(cid,sms_private.platform_actor(u),tool||':contact',c.id::text,rid,'success',c.revision,after_c.revision);end if;
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision) select cid,sms_private.platform_actor(u),'crm_cancel_booking:intake',id::text,rid,'success',revision from public.sms_automation_bookings where tenant_id=t and id=any(intake_ids);
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision) select cid,sms_private.platform_actor(u),'crm_cancel_booking:run',id::text,rid,'success',generation from sms_private.form_runs where tenant_id=t and id=any(run_ids);
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision) select cid,sms_private.platform_actor(u),'crm_cancel_booking:email',id::text,rid,'success',generation from sms_private.email_enrollments where tenant_id=t and id=any(email_ids);
  select * into b from public.sms_bookings where tenant_id=t and id=b.id;
  return jsonb_build_object('businessId',t,'databaseStatus','committed','bookingId',b.id,'previousRevision',prev,'revision',b.revision,'status',b.status,'messageQueued',false);
 elsif tool in ('crm_get_booking_intake','crm_update_booking_intake') then
  select * into i from public.sms_automation_bookings where tenant_id=t and id=(p->>'intakeId')::uuid;
  if not found then raise exception 'Intake unavailable' using errcode='42501';end if;
  if tool='crm_get_booking_intake' then return jsonb_build_object('businessId',t,'intake',sms_private.mcp_booking_intake(i));end if;
  perform sms_private.coordination_lock(t,i.phone);
  select * into i from public.sms_automation_bookings where tenant_id=t and id=i.id for update;
  select * into c from public.sms_contacts where tenant_id=t and phone=i.phone for update nowait;
  if not found then raise exception 'Existing contact required' using errcode='42501';end if;
  if c.revision<>(p->>'contactRevision')::bigint then raise exception 'Contact changed' using errcode='40001';end if;
  if i.revision<>(p->>'revision')::bigint then raise exception 'Intake changed' using errcode='40001';end if;prev:=i.revision;
  if exists(select from jsonb_array_elements(p->'answers') x group by x->>'key' having count(*)>1) then raise exception 'Duplicate answer keys' using errcode='22023';end if;
  select coalesce(jsonb_object_agg(x->>'key',x->'value'),'{}') into args from jsonb_array_elements(p->'answers') x;
  ids:=array(select id from sms_private.form_runs where tenant_id=t and intake_id=i.id and status in ('active','paused') order by id for update nowait);
  email_ids:=array(select id from sms_private.email_enrollments where tenant_id=t and source_type='bookings' and source_id=i.id and status in ('active','paused') order by id for update nowait);
  legacy_ids:=array(select id from public.sms_automation_enrollments where tenant_id=t and id=i.enrollment_id for update nowait);
  result:=sms_private.update_intake_booking(u,t,i.id,jsonb_build_object('name',p->'name','details',args,'status',p->'status','appointmentAt',p->'appointmentAt'));
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision)
   select cid,sms_private.platform_actor(u),'crm_update_booking_intake:run',id::text,rid,'success',generation from sms_private.form_runs where tenant_id=t and id=any(ids);
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision) select cid,sms_private.platform_actor(u),'crm_update_booking_intake:email',id::text,rid,'success',generation from sms_private.email_enrollments where tenant_id=t and id=any(email_ids);
  insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,revision) select cid,sms_private.platform_actor(u),'crm_update_booking_intake:legacy',id::text,rid,'success',generation from public.sms_automation_enrollments where tenant_id=t and id=any(legacy_ids);
  select * into after_c from public.sms_contacts where tenant_id=t and id=c.id;
  if (after_c.name is distinct from c.name or after_c.email is distinct from c.email) and not exists(select from sms_private.mcp_connections where id=cid and 'contact_edit'=any(permissions)) then raise exception 'Shared contact changes require contact_edit' using errcode='42501';end if;
  if after_c.revision<>c.revision then insert into sms_private.mcp_activity(connection_id,actor_id,tool,target,request_id,outcome,previous_revision,revision) values(cid,sms_private.platform_actor(u),tool||':contact',c.id::text,rid,'success',c.revision,after_c.revision);end if;
  select * into i from public.sms_automation_bookings where tenant_id=t and id=i.id;
  return jsonb_build_object('businessId',t,'databaseStatus','committed','intakeId',i.id,'previousRevision',prev,'revision',i.revision,'status',i.status,'operationalBookingChanged',false);
 end if;
 if tool in ('crm_create_booking_schedule','crm_update_booking_schedule','crm_set_booking_schedule_enabled') then perform 1 from public.sms_businesses where tenant_id=t for update;end if;
 if tool<>'crm_create_booking_schedule' then
  select * into r from public.sms_voice_service_rules where tenant_id=t and id=(p->>'scheduleId')::uuid;
  if not found then raise exception 'Schedule unavailable' using errcode='42501';end if;
  if tool='crm_get_booking_schedule' then return jsonb_build_object('businessId',t,'schedule',sms_private.mcp_booking_schedule(r));end if;
  if tool='crm_preview_booking_availability' then perform 1 from public.sms_voice_service_rules where tenant_id=t and id=r.id for share;else perform 1 from public.sms_voice_service_rules where tenant_id=t and id=r.id for update;end if;
  select * into r from public.sms_voice_service_rules where tenant_id=t and id=r.id;
  if r.version<>(p->>'revision')::bigint then raise exception 'Schedule changed' using errcode='40001';end if;prev:=r.version;
 end if;
 if tool='crm_preview_booking_availability' then
  result:=sms_private.preview_booking_availability(u,t,jsonb_build_object('channel','voice','localDate',p->'localDate','rule',sms_private.mcp_booking_schedule(r)->'configuration'||jsonb_build_object('id',r.id,'enabled',r.enabled)));
  return result||jsonb_build_object('businessId',t,'scheduleId',r.id,'revision',r.version);
 end if;
 if tool not in ('crm_create_booking_schedule','crm_update_booking_schedule','crm_set_booking_schedule_enabled') then raise exception 'Unknown booking tool' using errcode='22023';end if;
 args:=case when tool='crm_set_booking_schedule_enabled' then sms_private.mcp_booking_schedule(r)->'configuration' else p->'configuration' end;
 desired:=case when tool='crm_create_booking_schedule' then false when tool='crm_set_booking_schedule_enabled' then (p->>'enabled')::boolean else r.enabled end;
 args:=args||jsonb_build_object('id',coalesce(r.id,gen_random_uuid()),'enabled',desired,'variant',coalesce(r.variant,''),'zipCodes',coalesce(to_jsonb(r.zip_codes),'[]'));
 result:=sms_private.voice_save_rule(u,t,args);
 return jsonb_build_object('businessId',t,'databaseStatus','committed','scheduleId',result->'id','previousRevision',prev,'revision',result->'version','enabled',result->'enabled');
end $$;
revoke all on function sms_private.mcp_booking_action(text,text,text,jsonb,uuid,uuid) from public,anon,authenticated,service_role,sms_api,crm_mcp;

-- GENERATED MCP CONTRACTS
insert into sms_private.mcp_input_schemas values('crm_list_bookings','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"page":{"type":"integer","minimum":1,"maximum":100000,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":25},"status":{"type":"string","enum":["requested","confirmed","cancelled"]}},"required":["businessId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_booking','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"bookingId":{"type":"string","minLength":1,"maxLength":255}},"required":["businessId","bookingId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_list_booking_intakes','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"page":{"type":"integer","minimum":1,"maximum":100000,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":25},"status":{"type":"string","enum":["requested","confirmed","cancelled"]}},"required":["businessId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_booking_intake','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"intakeId":{"type":"string","format":"uuid"}},"required":["businessId","intakeId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_list_booking_schedules','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"page":{"type":"integer","minimum":1,"maximum":100000,"default":1},"pageSize":{"type":"integer","minimum":1,"maximum":100,"default":25}},"required":["businessId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_get_booking_schedule','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"scheduleId":{"type":"string","format":"uuid"}},"required":["businessId","scheduleId"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_create_booking_schedule','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"configuration":{"type":"object","properties":{"service":{"type":"string","enum":["junk_removal","dumpster_rental","property_cleanout","local_moving"]},"market":{"type":"string","minLength":1,"maxLength":100},"resourcePool":{"type":"string","minLength":1,"maxLength":100},"timeZone":{"type":"string","minLength":1,"maxLength":100},"durationMinutes":{"type":"integer","minimum":15,"maximum":43200},"capacity":{"type":"integer","minimum":1,"maximum":100},"minimumNoticeMinutes":{"type":"integer","minimum":0,"maximum":43200},"maximumAdvanceDays":{"type":"integer","minimum":1,"maximum":730},"weeklyAvailability":{"type":"object","properties":{"0":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8},"1":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8},"2":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8},"3":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8},"4":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8},"5":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8},"6":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8}},"required":["0","1","2","3","4","5","6"],"additionalProperties":false},"dateExceptions":{"type":"array","items":{"type":"object","properties":{"date":{"type":"string","format":"date"},"closed":{"type":"boolean"},"windows":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8}},"required":["date","closed","windows"],"additionalProperties":false},"maxItems":366}},"required":["service","market","resourcePool","timeZone","durationMinutes","capacity","minimumNoticeMinutes","maximumAdvanceDays","weeklyAvailability","dateExceptions"],"additionalProperties":false},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","configuration","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_update_booking_schedule','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"scheduleId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"configuration":{"type":"object","properties":{"service":{"type":"string","enum":["junk_removal","dumpster_rental","property_cleanout","local_moving"]},"market":{"type":"string","minLength":1,"maxLength":100},"resourcePool":{"type":"string","minLength":1,"maxLength":100},"timeZone":{"type":"string","minLength":1,"maxLength":100},"durationMinutes":{"type":"integer","minimum":15,"maximum":43200},"capacity":{"type":"integer","minimum":1,"maximum":100},"minimumNoticeMinutes":{"type":"integer","minimum":0,"maximum":43200},"maximumAdvanceDays":{"type":"integer","minimum":1,"maximum":730},"weeklyAvailability":{"type":"object","properties":{"0":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8},"1":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8},"2":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8},"3":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8},"4":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8},"5":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8},"6":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8}},"required":["0","1","2","3","4","5","6"],"additionalProperties":false},"dateExceptions":{"type":"array","items":{"type":"object","properties":{"date":{"type":"string","format":"date"},"closed":{"type":"boolean"},"windows":{"type":"array","items":{"type":"object","properties":{"start":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"},"end":{"type":"string","pattern":"^([01][0-9]|2[0-3]):[0-5][0-9]$"}},"required":["start","end"],"additionalProperties":false},"maxItems":8}},"required":["date","closed","windows"],"additionalProperties":false},"maxItems":366}},"required":["service","market","resourcePool","timeZone","durationMinutes","capacity","minimumNoticeMinutes","maximumAdvanceDays","weeklyAvailability","dateExceptions"],"additionalProperties":false},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","scheduleId","revision","configuration","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_set_booking_schedule_enabled','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"scheduleId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"enabled":{"type":"boolean"},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","scheduleId","revision","enabled","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_preview_booking_availability','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"scheduleId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"localDate":{"type":"string","format":"date"}},"required":["businessId","scheduleId","revision","localDate"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_update_booking_intake','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"intakeId":{"type":"string","format":"uuid"},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"contactRevision":{"type":"integer","minimum":1,"maximum":9007199254740991},"name":{"type":"string","maxLength":200},"answers":{"type":"array","items":{"type":"object","properties":{"key":{"type":"string","minLength":1,"maxLength":100},"value":{"type":"string","maxLength":2500}},"required":["key","value"],"additionalProperties":false},"maxItems":30},"appointmentAt":{"anyOf":[{"type":"string","format":"date-time"},{"type":"null"}]},"status":{"type":"string","enum":["requested","confirmed","cancelled"]},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","intakeId","revision","contactRevision","name","answers","appointmentAt","status","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
insert into sms_private.mcp_input_schemas values('crm_cancel_booking','{"type":"object","properties":{"businessId":{"type":"string","minLength":1,"maxLength":255},"bookingId":{"type":"string","minLength":1,"maxLength":255},"revision":{"type":"integer","minimum":1,"maximum":9007199254740991},"contactRevision":{"type":"integer","minimum":1,"maximum":9007199254740991},"idempotencyKey":{"type":"string","minLength":8,"maxLength":128}},"required":["businessId","bookingId","revision","contactRevision","idempotencyKey"],"additionalProperties":false,"$schema":"http://json-schema.org/draft-07/schema#"}'::jsonb);
alter table sms_private.mcp_connections drop constraint mcp_connections_permissions_check;
alter table sms_private.mcp_connections add constraint mcp_connections_permissions_check check(permissions <@ array['booking_read','booking_intake_read','booking_schedule_read','booking_schedule_edit','booking_schedule_enable','booking_preview','booking_intake_edit','booking_cancel','form_duplicate','form_archive','form_restore','automation_archive','automation_preset_read','automation_preset_save','conversation_ai_pause','conversation_ai_resume','conversation_message_reassign','handoff_alert_retry','activity_report_read','activity_tag_manage','activity_attribution_update','read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read','contact_read','contact_create','contact_edit','consent_read','consent_opt_in','contact_suppress','contact_automation_block','sms_message_preview','sms_message_send']::text[]);
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
  if not perms <@ array['booking_read','booking_intake_read','booking_schedule_read','booking_schedule_edit','booking_schedule_enable','booking_preview','booking_intake_edit','booking_cancel','form_duplicate','form_archive','form_restore','automation_archive','automation_preset_read','automation_preset_save','conversation_ai_pause','conversation_ai_resume','conversation_message_reassign','handoff_alert_retry','activity_report_read','activity_tag_manage','activity_attribution_update','read','draft','review','service_add','visibility','global_customer_lookup','automation_read','automation_draft','automation_preview','automation_publish','automation_enable','automation_run_start','automation_run_resume','automation_run_pause_stop','automation_activity','form_read','form_create','form_edit','form_preview','form_publish','form_activate','enquiry_read','enquiry_status_read','lead_read','lead_status_update','lead_assign','handoff_read','handoff_status_update','handoff_assign','conversation_read','conversation_messages_read','conversation_reply','conversation_mark_read','contact_read','contact_create','contact_edit','consent_read','consent_opt_in','contact_suppress','contact_automation_block','sms_message_preview','sms_message_send']::text[] or cardinality(businesses)>500
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
   required_permission:=case tool when 'crm_list_bookings' then 'booking_read' when 'crm_get_booking' then 'booking_read' when 'crm_list_booking_intakes' then 'booking_intake_read' when 'crm_get_booking_intake' then 'booking_intake_read' when 'crm_list_booking_schedules' then 'booking_schedule_read' when 'crm_get_booking_schedule' then 'booking_schedule_read' when 'crm_create_booking_schedule' then 'booking_schedule_edit' when 'crm_update_booking_schedule' then 'booking_schedule_edit' when 'crm_set_booking_schedule_enabled' then 'booking_schedule_enable' when 'crm_preview_booking_availability' then 'booking_preview' when 'crm_update_booking_intake' then 'booking_intake_edit' when 'crm_cancel_booking' then 'booking_cancel' when 'crm_duplicate_form' then 'form_duplicate' when 'crm_archive_form' then 'form_archive' when 'crm_restore_form' then 'form_restore' when 'crm_archive_sms_template' then 'automation_archive' when 'crm_list_sms_presets' then 'automation_preset_read' when 'crm_get_sms_preset' then 'automation_preset_read' when 'crm_save_sms_preset' then 'automation_preset_save' when 'crm_pause_conversation_ai' then 'conversation_ai_pause' when 'crm_resume_conversation_ai' then 'conversation_ai_resume' when 'crm_reassign_conversation_message' then 'conversation_message_reassign' when 'crm_retry_handoff_alert' then 'handoff_alert_retry' when 'crm_get_activity_report' then 'activity_report_read' when 'crm_list_activity_tags' then 'activity_report_read' when 'crm_get_enquiry_attribution_context' then 'activity_report_read' when 'crm_create_activity_tag' then 'activity_tag_manage' when 'crm_update_activity_tag' then 'activity_tag_manage' when 'crm_set_enquiry_tag' then 'activity_tag_manage' when 'crm_link_enquiry_booking' then 'activity_attribution_update' when 'crm_link_enquiry_response' then 'activity_attribution_update' when 'crm_link_enquiry_activity' then 'activity_attribution_update' when 'crm_list_contacts' then 'contact_read' when 'crm_get_contact' then 'contact_read' when 'crm_get_contact_consent' then 'consent_read' when 'crm_create_contact' then 'contact_create' when 'crm_update_contact' then 'contact_edit' when 'crm_record_contact_sms_opt_in' then 'consent_opt_in' when 'crm_suppress_contact_sms' then 'contact_suppress' when 'crm_set_contact_automation_blocked' then 'contact_automation_block' when 'crm_preview_contact_sms' then 'sms_message_preview' when 'crm_send_contact_sms' then 'sms_message_send' when 'crm_reply_to_conversation' then 'conversation_reply' when 'crm_preview_conversation_reply' then 'conversation_reply' when 'crm_mark_conversation_messages_read' then 'conversation_mark_read' when 'crm_list_conversations' then 'conversation_read' when 'crm_get_conversation' then 'conversation_read' when 'crm_assign_lead' then 'lead_assign' when 'crm_set_lead_status' then 'lead_status_update' when 'crm_assign_handoff' then 'handoff_assign' when 'crm_set_handoff_status' then 'handoff_status_update' when 'crm_list_leads' then 'lead_read' when 'crm_get_lead' then 'lead_read' when 'crm_list_handoffs' then 'handoff_read' when 'crm_get_handoff' then 'handoff_read' when 'crm_get_enquiry_status' then 'enquiry_status_read' when 'crm_list_enquiries' then 'enquiry_read' when 'crm_get_enquiry' then 'enquiry_read' when 'crm_set_form_collection_enabled' then 'form_activate' when 'crm_apply_form_draft' then 'form_publish' when 'crm_preview_form' then 'form_preview' when 'crm_create_form' then 'form_create' when 'crm_save_form_draft' then 'form_edit' when 'crm_list_forms' then 'form_read' when 'crm_get_form' then 'form_read' when 'crm_search_customers' then 'read' when 'crm_get_customer' then 'read'
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
   if tool in ('crm_list_bookings','crm_get_booking','crm_list_booking_intakes','crm_get_booking_intake','crm_list_booking_schedules','crm_get_booking_schedule','crm_create_booking_schedule','crm_update_booking_schedule','crm_set_booking_schedule_enabled','crm_preview_booking_availability','crm_update_booking_intake','crm_cancel_booking','crm_duplicate_form','crm_archive_form','crm_restore_form','crm_archive_sms_template','crm_list_sms_presets','crm_get_sms_preset','crm_save_sms_preset','crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_get_activity_report','crm_list_activity_tags','crm_get_enquiry_attribution_context','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity','crm_list_contacts','crm_get_contact','crm_get_contact_consent','crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_preview_contact_sms','crm_send_contact_sms','crm_reply_to_conversation','crm_preview_conversation_reply','crm_mark_conversation_messages_read','crm_list_conversations','crm_get_conversation','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status','crm_list_leads','crm_get_lead','crm_list_handoffs','crm_get_handoff','crm_get_enquiry_status','crm_list_enquiries','crm_get_enquiry','crm_set_form_collection_enabled','crm_apply_form_draft','crm_preview_form','crm_create_form','crm_save_form_draft','crm_list_forms','crm_get_form','crm_list_sms_runs','crm_get_sms_run','crm_get_sms_run_activity','crm_resume_sms_run','crm_pause_sms_run','crm_stop_sms_run','crm_get_sms_run_start_context','crm_start_sms_automation_run','crm_publish_sms_automation','crm_set_form_followups_enabled','crm_create_sms_automation','crm_save_sms_automation_draft','crm_preview_sms_automation','crm_list_sms_automations','crm_get_sms_automation','crm_search_sms_contacts','crm_list_form_submissions','crm_get_business','crm_save_business_profile_draft','crm_review_business_profile','crm_add_business_service','crm_set_service_visibility')
    and (t is null or (not c.all_businesses and not t=any(c.business_ids)) or not exists(select from public.sms_businesses where tenant_id=t)) then raise exception 'Business access denied' using errcode='42501'; end if;
   if tool='crm_start_sms_automation_run' and p->>'overlapChoice'='stop_selected' and not 'automation_run_pause_stop'=any(c.permissions) then raise exception 'Stopping overlapping runs is not granted' using errcode='42501'; end if;
   if tool='crm_get_conversation' and p->'includeMessages'='true'::jsonb and not 'conversation_messages_read'=any(c.permissions) then raise exception 'Message content is not granted' using errcode='42501'; end if;
   if tool in ('crm_list_bookings','crm_get_booking','crm_list_booking_intakes','crm_get_booking_intake','crm_list_booking_schedules','crm_get_booking_schedule','crm_preview_booking_availability') then
    data:=sms_private.mcp_booking_action(u,t,tool,p,c.id,request_id);
   elsif tool in ('crm_list_sms_presets','crm_get_sms_preset') then
    data:=sms_private.mcp_form_lifecycle(u,t,tool,p,c.id,request_id);
   elsif tool in ('crm_get_activity_report','crm_list_activity_tags','crm_get_enquiry_attribution_context') then
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
     if tool in ('crm_create_booking_schedule','crm_update_booking_schedule','crm_set_booking_schedule_enabled','crm_update_booking_intake','crm_cancel_booking') then
      data:=sms_private.mcp_booking_action(u,t,tool,p,c.id,request_id);
     elsif tool in ('crm_duplicate_form','crm_archive_form','crm_restore_form','crm_archive_sms_template','crm_save_sms_preset') then
      data:=sms_private.mcp_form_lifecycle(u,t,tool,p,c.id,request_id);
     elsif tool in ('crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity') then
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
  values(c.id,aid,left(tool,100),left(coalesce(data->>'bookingId',data->>'intakeId',data->>'scheduleId',data->>'formId',data->>'presetId',data->>'automationId',data->>'tagId',data->>'runId',data->>'handoffId',data->>'conversationId',data->>'contactId',data->'contact'->>'id',data->'conversation'->>'id',data->'lead'->>'id',data->'handoff'->>'id',data->'enquiry'->>'id',data->'form'->>'id',data->'run'->>'id',data->'automation'->>'id',target),255),request_id,case when error_code is not null then 'denied' when replay then 'replayed' else 'success' end,error_code,
   case when error_code is null then coalesce((data->>'revision')::bigint,(data->'contact'->>'revision')::bigint,(data->'conversation'->>'revision')::bigint,(data->'lead'->>'revision')::bigint,(data->'handoff'->>'revision')::bigint,(data->'enquiryStatus'->'sms'->>'generation')::bigint,(data->'enquiryStatus'->>'submittedFormVersion')::bigint,(data->'enquiry'->>'submittedFormVersion')::bigint,(data->'form'->>'revision')::bigint,(data->'run'->>'generation')::bigint,(data->'source'->>'revision')::bigint,(data->'automation'->>'revision')::bigint,(data->'record'->>'revision')::bigint,(data->'business'->'setup'->>'revision')::bigint) end,
   case when error_code is null then (data->'form'->>'draftRevision')::bigint end,
   case when error_code is null and tool in ('crm_create_booking_schedule','crm_update_booking_schedule','crm_set_booking_schedule_enabled','crm_update_booking_intake','crm_cancel_booking','crm_duplicate_form','crm_archive_form','crm_restore_form','crm_archive_sms_template','crm_save_sms_preset','crm_pause_conversation_ai','crm_resume_conversation_ai','crm_reassign_conversation_message','crm_retry_handoff_alert','crm_create_activity_tag','crm_update_activity_tag','crm_set_enquiry_tag','crm_link_enquiry_booking','crm_link_enquiry_response','crm_link_enquiry_activity','crm_create_contact','crm_update_contact','crm_record_contact_sms_opt_in','crm_suppress_contact_sms','crm_set_contact_automation_blocked','crm_send_contact_sms','crm_reply_to_conversation','crm_mark_conversation_messages_read','crm_assign_lead','crm_set_lead_status','crm_assign_handoff','crm_set_handoff_status') then (data->>'previousRevision')::bigint end,
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
