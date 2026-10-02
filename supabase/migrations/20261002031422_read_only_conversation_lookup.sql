-- Requires sms_workspace_access_guards. The paired canonical require_admin
-- decides who may initialize a conversation; SMS readers only resolve rows.
create or replace function sms_private.general_conversation(u text,t text,ph text) returns uuid
language plpgsql security definer set search_path='' as $$
declare cid uuid;
begin
  perform sms_private.require_sms_reader(u,t);
  select id into cid from public.sms_conversations where tenant_id=t and phone=ph and group_id is null;
  if cid is not null then return cid; end if;
  if not exists(select from public.sms_contacts where tenant_id=t and phone=ph) then return null; end if;
  begin
    perform sms_private.require_admin(u);
  exception when insufficient_privilege then return null;
  end;
  return sms_private.ensure_conversation(t,ph,null);
end $$;
