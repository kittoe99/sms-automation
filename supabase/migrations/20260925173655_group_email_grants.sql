revoke all on function sms_private.email_overview(text,text),
  sms_private.email_save_group(text,text,text,jsonb),sms_private.email_resolve(text,text,uuid),
  sms_private.email_retry(text,text,uuid),sms_private.email_unsubscribe(uuid),
  sms_private.email_claim(),sms_private.email_job_context(uuid,uuid),
  sms_private.email_save_draft(uuid,uuid,text,text),sms_private.email_save_payload(uuid,uuid,jsonb),sms_private.email_before_send(uuid,uuid),
  sms_private.email_finish(uuid,uuid,text,text,text),
  sms_private.email_record_provider_event(text,text,text,text),sms_private.dispatch_email_edge()
  from public,anon,authenticated,sms_api,sms_webhook,sms_sender,sms_automation,sms_ai,sms_form_public;
grant execute on function sms_private.email_overview(text,text),
  sms_private.email_save_group(text,text,text,jsonb),sms_private.email_resolve(text,text,uuid),
  sms_private.email_retry(text,text,uuid) to sms_api;
grant execute on function sms_private.email_unsubscribe(uuid) to sms_form_public;
grant execute on function sms_private.email_claim(),sms_private.email_job_context(uuid,uuid),
  sms_private.email_save_draft(uuid,uuid,text,text),sms_private.email_save_payload(uuid,uuid,jsonb),sms_private.email_before_send(uuid,uuid),
  sms_private.email_finish(uuid,uuid,text,text,text),
  sms_private.email_record_provider_event(text,text,text,text) to sms_automation;
