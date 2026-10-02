create function sms_private.email_overview(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
begin
  perform sms_private.require_web_form_editor(u,t);
  return jsonb_build_object(
    'configured',t='e2-local',
    'workerReady',exists(select from sms_private.edge_config c
      where c.queue='automation_jobs' and c.enabled and c.secret_id is not null),
    'groups',coalesce((select jsonb_agg(to_jsonb(s)||jsonb_build_object('name',g.name,'fixedType',g.fixed_type)
      order by g.name) from sms_private.email_group_settings s
      join public.sms_automation_groups g on g.tenant_id=s.tenant_id and g.id=s.group_id
      where s.tenant_id=t),'[]'::jsonb),
    'enrollments',coalesce((select jsonb_agg(x order by x.enrolled_at desc) from
      (select id,group_id,email,name,source_type,status,step_index,next_run_at,enrolled_at
       from sms_private.email_enrollments where tenant_id=t order by enrolled_at desc limit 100)x),'[]'::jsonb),
    'jobs',coalesce((select jsonb_agg(x order by x.created_at desc) from
      (select j.id,e.group_id,e.email,j.subject,j.status,j.provider_status,j.provider_id,
         j.error_code,j.step_index,j.created_at from sms_private.email_jobs j
       join sms_private.email_enrollments e on e.id=j.enrollment_id
       where e.tenant_id=t order by j.created_at desc limit 100)x),'[]'::jsonb)
  );
end $$;

create function sms_private.email_save_group(u text,t text,gid text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare s sms_private.email_group_settings; g public.sms_automation_groups;
  proposed_rule jsonb; proposed_enabled boolean;
begin
  perform sms_private.require_web_form_editor(u,t);
  if t<>'e2-local' then raise exception 'Email sender is not configured for this business'; end if;
  select * into strict g from public.sms_automation_groups where tenant_id=t and id=gid;
  select * into strict s from sms_private.email_group_settings where tenant_id=t and group_id=gid for update;
  if jsonb_typeof(p->'enabled')<>'boolean' or jsonb_typeof(p->'rule')<>'object'
    or jsonb_typeof(p->'intent')<>'string' or jsonb_typeof(p->'systemPrompt')<>'string'
    or jsonb_typeof(p->'businessContext')<>'string'
    or jsonb_typeof(p->'mailingAddress')<>'string' then raise exception 'Invalid email settings'; end if;
  proposed_rule:=p->'rule'; proposed_enabled:=(p->>'enabled')::boolean;
  if (proposed_rule->>'anchor')<>(case when g.fixed_type='bookings' then 'appointment' else 'enrollment' end)
    or coalesce((proposed_rule->>'repeatCount')::integer,0) not between 1 and 30
    or coalesce((proposed_rule->>'intervalCount')::integer,0) not between 1 and 365
    or proposed_rule->>'intervalUnit' not in ('hour','day','week','month')
    or coalesce((proposed_rule->>'startHour')::integer,-1) not between 0 and 23
    or coalesce((proposed_rule->>'endHour')::integer,-1) not between 1 and 24
    or (proposed_rule->>'startHour')::integer >= (proposed_rule->>'endHour')::integer
    then raise exception 'Invalid email schedule'; end if;
  if g.fixed_type='bookings' then
    if coalesce((proposed_rule->>'leadHours')::integer,0) not between 1 and 720 then raise exception 'Invalid reminder lead time'; end if;
  elsif coalesce((proposed_rule->>'firstDelayCount')::integer,-1) not between 0 and 365
    or proposed_rule->>'firstDelayUnit' not in ('hour','day','week','month')
    then raise exception 'Invalid first email delay'; end if;
  if length(p->>'intent')>1600 or length(p->>'systemPrompt')>6000 or length(p->>'businessContext')>10000
    or length(p->>'mailingAddress')>300
    then raise exception 'Email instructions are too long'; end if;
  if proposed_enabled and (btrim(p->>'intent')='' or btrim(p->>'systemPrompt')=''
    or btrim(p->>'businessContext')='' or btrim(p->>'mailingAddress')=''
    or not exists(select from sms_private.edge_config c
      where c.queue='automation_jobs' and c.enabled and c.secret_id is not null))
    then raise exception 'Configure email instructions and worker before activation'; end if;
  update sms_private.email_group_settings set enabled=proposed_enabled,rule=proposed_rule,
    intent=btrim(p->>'intent'),system_prompt=btrim(p->>'systemPrompt'),
    business_context=btrim(p->>'businessContext'),mailing_address=btrim(p->>'mailingAddress'),updated_at=now()
    where tenant_id=t and group_id=gid returning * into s;
  if not proposed_enabled then
    update sms_private.email_enrollments set status='cancelled',next_run_at=null,
      generation=generation+1,updated_at=now() where tenant_id=t and group_id=gid and status='active';
  end if;
  return to_jsonb(s);
end $$;

create function sms_private.email_resolve(u text,t text,eid uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare result sms_private.email_enrollments; begin
  perform sms_private.require_web_form_editor(u,t);
  update sms_private.email_enrollments set status='resolved',next_run_at=null,
    generation=generation+1,updated_at=now()
    where id=eid and tenant_id=t and status='active' returning * into result;
  if result.id is null then raise exception 'Active email enrollment not found' using errcode='P0002'; end if;
  return to_jsonb(result);
end $$;

create function sms_private.email_unsubscribe(token uuid) returns jsonb
language plpgsql security definer set search_path='' as $$
declare target sms_private.email_enrollments; begin
  select * into target from sms_private.email_enrollments where unsubscribe_token=token;
  if target.id is null then return jsonb_build_object('ok',true); end if;
  insert into sms_private.email_suppressions(tenant_id,email,reason)
    values(target.tenant_id,target.email,'unsubscribe') on conflict do nothing;
  update sms_private.email_enrollments set status='unsubscribed',next_run_at=null,
    generation=generation+1,updated_at=now()
    where tenant_id=target.tenant_id and email=target.email and status='active';
  return jsonb_build_object('ok',true);
end $$;
