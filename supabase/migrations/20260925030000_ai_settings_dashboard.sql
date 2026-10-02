-- Save group AI text without rewriting its schedule or enrollment state.
create function sms_private.save_group_ai_context(u text,t text,gid text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare prompt_text text; context_text text; group_row public.sms_automation_groups;
begin
  perform sms_private.require_admin(u);
  select * into strict group_row from public.sms_automation_groups
    where tenant_id=t and id=gid and fixed_type is not null for update;
  if jsonb_typeof(input->'systemPrompt')<>'string'
    or jsonb_typeof(input->'businessContext')<>'string' then
    raise exception 'AI instructions and business details are required' using errcode='22023';
  end if;
  prompt_text:=btrim(input->>'systemPrompt');
  context_text:=btrim(input->>'businessContext');
  if length(prompt_text)>6000 or length(context_text)>10000
    or (group_row.active and (prompt_text='' or context_text='')) then
    raise exception 'Add AI instructions and business details for an active automation'
      using errcode='22023';
  end if;
  update public.sms_automation_intents set system_prompt=nullif(prompt_text,''),
    business_context=nullif(context_text,''),updated_at=now()
    where tenant_id=t and group_id=gid;
  if not found then raise exception 'Automation intent missing' using errcode='22023'; end if;
  -- Drafts created before this edit must use the newly saved instructions.
  update public.sms_automation_enrollments set generation=generation+1,next_run_at=now()
    where tenant_id=t and category_id=gid and status='active';
  update public.sms_conversations set generation=generation+1
    where tenant_id=t and group_id=gid;
  insert into sms_private.audit(tenant_id,actor,action,detail)
    values(t,u,'group_ai_context_saved',jsonb_build_object('groupId',gid));
  return jsonb_build_object('groupId',gid,'systemPrompt',prompt_text,
    'businessContext',context_text,'aiConfigured',prompt_text<>'' and context_text<>'');
end $$;
revoke all on function sms_private.save_group_ai_context(text,text,text,jsonb)
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai;
grant execute on function sms_private.save_group_ai_context(text,text,text,jsonb) to sms_api;

