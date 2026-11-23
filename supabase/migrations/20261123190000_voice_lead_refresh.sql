-- CRM-owned forward migration. Requires CRM 20261121010000_multi_business_voice.sql.
-- A voice call outcome now refreshes the caller's open lead. Before, a repeat caller's
-- existing open lead kept the summary and details of their first call, so a new address
-- or problem from a later call never reached the lead. The open lead's summary takes the
-- latest outcome's summary, and its service, location and request take any non-empty
-- values from it; other fields (source, phoneVerified, ...) are kept.

do $$
declare f oid; def text; changed text;
begin
 select p.oid into f from pg_proc p join pg_namespace n on n.oid=p.pronamespace
  where n.nspname='voice_runtime_api' and p.proname='dispatch';
 def:=pg_get_functiondef(f);
 changed:=replace(def,
  '  update sms_private.voice_calls set outcome=p->>''outcome'',summary=p->>''summary'',request=p,lead_id=lid where tenant_id=t and id=c.id;',
  '  if lid is not null then
   update public.sms_leads set summary=p->>''summary'',
    fields=fields||jsonb_strip_nulls(jsonb_build_object(''service'',nullif(p->>''service'',''''),
     ''location'',nullif(p->>''location'',''''),''request'',nullif(p->>''request'','''')))
    where tenant_id=t and id=lid and status in (''open'',''assigned'');
  end if;
  update sms_private.voice_calls set outcome=p->>''outcome'',summary=p->>''summary'',request=p,lead_id=lid where tenant_id=t and id=c.id;');
 if changed=def then raise exception 'Could not add the lead refresh to voice_runtime_api.dispatch'; end if;
 execute changed;
end $$;
