-- Authenticated Form Builder live tests queue one real SMS without creating an
-- automation enrollment or granting marketing consent.
create function sms_private.forms_live_test(u text,t text,fid uuid,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare f public.sms_forms; c public.sms_contacts; result jsonb; gid text;
begin
 perform sms_private.form_access(u,t);
 select * into f from public.sms_forms where tenant_id=t and id=fid for share;
 if not found then raise exception 'Form not found' using errcode='P0002'; end if;
 if (p->>'revision')::integer is distinct from f.revision then raise exception 'Draft changed. Reload before testing.' using errcode='23505'; end if;
 if p->'consent' is distinct from 'true'::jsonb then raise exception 'SMS consent is required'; end if;
 if coalesce(p->>'idempotencyKey','') !~ '^[a-zA-Z0-9_-]{8,100}$' then raise exception 'Valid test key required'; end if;
 if coalesce(p->'mapped'->>'phone','') !~ '^\+[1-9][0-9]{7,14}$' then raise exception 'Valid test phone required'; end if;
 if length(coalesce(p->>'body','')) not between 1 and 1000 then raise exception 'Test SMS must contain 1 to 1000 characters'; end if;
 gid:=p->>'groupId';
 if not (gid=f.draft->'routing'->>'defaultGroupId' or exists(select from jsonb_array_elements(f.draft->'routing'->'rules') r where r->>'groupId'=gid)) then raise exception 'Invalid routing target'; end if;
 if not (exists(select from public.sms_automation_groups g where g.tenant_id=t and g.id=gid and g.active and g.kind<>'reminder') or exists(select from jsonb_array_elements(f.draft_groups) g where g->>'id'=gid)) then raise exception 'Automation unavailable'; end if;
 insert into public.sms_contacts(tenant_id,phone,name,email,source,metadata)
 values(t,p->'mapped'->>'phone',coalesce(p->'mapped'->>'name',''),p->'mapped'->>'email','form_test',jsonb_build_object('form_id',fid,'test',true))
 on conflict(tenant_id,phone) do nothing;
 select * into strict c from public.sms_contacts where tenant_id=t and phone=p->'mapped'->>'phone' for update;
 if c.opted_out then raise exception 'This number has opted out and cannot receive a test SMS' using errcode='42501'; end if;
 result:=sms_private.outbox(t,'form-live-test:'||fid||':'||(p->>'idempotencyKey'),jsonb_build_object('phone',c.phone,'body',p->>'body','purpose','transactional','category_id',null,'form_id',fid,'form_test',true));
 insert into public.sms_form_audit(tenant_id,form_id,actor,event,detail)
 values(t,fid,u,'live_test_queued',jsonb_build_object('groupId',gid,'messageId',result->>'messageId'));
 return result||jsonb_build_object('accepted',true);
end $$;

revoke all on function sms_private.forms_live_test(text,text,uuid,jsonb) from public,anon,authenticated;
grant execute on function sms_private.forms_live_test(text,text,uuid,jsonb) to sms_forms;
