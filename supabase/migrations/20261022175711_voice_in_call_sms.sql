-- CRM-owned forward migration. Uses the released lookup, call archive and outbox
-- contracts; no existing permissions, sender setup or messaging consent changes.
create schema voice_sms_api;
revoke all on schema voice_sms_api from public;
create role sms_voice_sms nologin nosuperuser nobypassrls;
grant usage on schema voice_sms_api to sms_voice_sms;

create table sms_private.voice_sms_requests (
 tenant_id text not null references public.sms_businesses(tenant_id),
 call_id text not null, request_id uuid not null, phone text not null,
 body_hash text not null, message_id uuid not null,
 created_at timestamptz not null default now(),
 primary key(tenant_id,call_id,request_id),
 foreign key(tenant_id,message_id) references public.sms_messages(tenant_id,id),
 check(length(call_id) between 8 and 160),
 check(phone ~ '^\+[1-9][0-9]{7,14}$')
);
alter table sms_private.voice_sms_requests enable row level security;
create index voice_sms_phone_recent on sms_private.voice_sms_requests(tenant_id,phone,created_at);
revoke all on sms_private.voice_sms_requests from public,anon,authenticated,service_role;

create function voice_sms_api.readiness(t text,cid text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare ready boolean; begin
 perform sms_private.voice_read_scope(t);
 if cid is null or length(cid) not between 8 and 160 then raise exception 'Invalid call';end if;
 select exists(select from public.sms_businesses b
  join sms_private.providers p on p.tenant_id=b.tenant_id
  join public.sms_twilio_registrations r on r.tenant_id=b.tenant_id
  where b.tenant_id=t and b.status='active' and b.sending_enabled and b.active_profile_version_id is not null
   and p.auth_secret_id is not null and p.account_sid is not null
   and p.phone_number_sid is not null and p.from_number='+18777574365'
   and p.messaging_service_sid is not null and r.messaging_service_sid=p.messaging_service_sid and r.state='ready') into ready;
 return jsonb_build_object('ready',ready,'maxCharacters',600,'maxMessagesPerCall',5);
end $$;

create function voice_sms_api.send(t text,cid text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare ph text; body text; rid uuid; prior sms_private.voice_sms_requests;
 result jsonb; mid uuid; delivery text; request_hash text;
begin
 perform sms_private.voice_read_scope(t);
 if cid is null or length(cid) not between 8 and 160 or jsonb_typeof(p) is distinct from 'object'
  or exists(select from jsonb_object_keys(p) k where k not in ('phone','body','requestId'))
  or jsonb_typeof(p->'phone') is distinct from 'string' or not sms_private.voice_valid_phone(p->>'phone')
  or jsonb_typeof(p->'body') is distinct from 'string' or length(btrim(p->>'body')) not between 1 and 600
  or coalesce(p->>'requestId','') !~ '^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$'
  then raise exception 'Invalid SMS request';end if;
 ph:=p->>'phone';body:=btrim(p->>'body');rid:=(p->>'requestId')::uuid;request_hash:=md5(body);
 -- Caller ID cannot authorize customer reads. For this one-off text, only the
 -- admitted active SIP call's server-recorded number or a verified callback is eligible.
 if not sms_private.voice_verified(t,cid,ph) and not exists(select from sms_private.voice_calls c
   where c.tenant_id=t and c.job_id=cid and c.agent_id='opek-phone' and c.phone=ph
    and c.status='active' and c.room_id like 'phone-%' and nullif(c.sip_call_id,'') is not null
    and c.seen_at>now()-interval '2 minutes')
  then raise exception 'Use the current caller or verify the callback phone' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(t||':voice-call-sms:'||cid,991));
 perform sms_private.coordination_lock(t,ph);
 select * into prior from sms_private.voice_sms_requests where tenant_id=t and call_id=cid and request_id=rid;
 if found then
  if prior.phone<>ph or prior.body_hash<>request_hash then raise exception 'SMS request changed' using errcode='23505';end if;
  select status into delivery from public.sms_messages where tenant_id=t and id=prior.message_id;
  return jsonb_build_object('messageId',prior.message_id,'status','queued','deliveryStatus',delivery,'duplicate',true);
 end if;
 if not (voice_sms_api.readiness(t,cid)->>'ready')::boolean then raise exception 'Business SMS sending is unavailable';end if;
 if (select count(*) from sms_private.voice_sms_requests where tenant_id=t and call_id=cid)>=5
  or (select count(*) from sms_private.voice_sms_requests where tenant_id=t and phone=ph and created_at>now()-interval '1 hour')>=10
  then raise exception 'In-call SMS limit reached';end if;
 -- Verification and SIP archives never opt contacts into marketing. Existing
 -- outbox/worker gates enforce opt-out, business controls and STOP at delivery.
 insert into public.sms_contacts(tenant_id,phone,source) values(t,ph,'voice') on conflict do nothing;
 result:=sms_private.outbox(t,'voice-call-sms:'||md5(cid||':'||rid::text),
  jsonb_build_object('phone',ph,'body',body,'purpose','transactional'));
 mid:=(result->>'messageId')::uuid;
 insert into sms_private.voice_sms_requests(tenant_id,call_id,request_id,phone,body_hash,message_id)
  values(t,cid,rid,ph,request_hash,mid);
 insert into sms_private.audit(tenant_id,actor,action,detail)
  values(t,'voice:'||cid,'in_call_sms_queued',jsonb_build_object('messageId',mid,'requestId',rid));
 return result||jsonb_build_object('deliveryStatus','queued','duplicate',false);
end $$;
revoke all on all functions in schema voice_sms_api from public,anon,authenticated,service_role;
grant execute on all functions in schema voice_sms_api to sms_voice_sms;
