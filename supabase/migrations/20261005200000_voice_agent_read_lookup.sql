-- Read-only CRM/business tools for the deployed phone agent. Verification is the
-- only write operation: it uses the existing transactional SMS outbox.
do $$ begin
  if not exists(select from pg_roles where rolname='sms_voice_lookup') then
    create role sms_voice_lookup nologin nosuperuser nobypassrls;
  end if;
end $$;
grant usage on schema sms_private to sms_voice_lookup;

create function sms_private.voice_read_scope(t text) returns void
language plpgsql stable security definer set search_path='' as $$
begin
  -- This deployment serves the registered owner of +18777574365 only.
  if t is distinct from 'biz-1c0c09ce-819e-4795-86b9-0e457ab92f58'
    or not exists(select from public.sms_businesses where tenant_id=t)
    or not exists(select from sms_private.providers where tenant_id=t and from_number='+18777574365')
    then raise exception 'Voice business scope denied' using errcode='42501'; end if;
end $$;

create function sms_private.voice_read_business(t text,q text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare profile jsonb; vid uuid; chunks jsonb;
begin
  perform sms_private.voice_read_scope(t);
  if q is null or length(q)>500 then raise exception 'Invalid search'; end if;
  select v.id,(select jsonb_object_agg(k,value) from jsonb_each(v.facts) f(k,value)
    where k in ('businessName','summary','websiteUrl','hours','contactPhone','contactEmail',
      'services','locations','faqs','pricing','policies','bookingRules')) into vid,profile
    from public.sms_businesses b join public.sms_business_profile_versions v
    on v.tenant_id=b.tenant_id and v.id=b.active_profile_version_id and v.status='approved'
    where b.tenant_id=t;
  select coalesce(jsonb_agg(x),'[]'::jsonb) into chunks from (
    select c.id as "citationId",s.title,left(c.content,4000) as content
    from public.sms_knowledge_chunks c join public.sms_knowledge_sources s
      on s.tenant_id=c.tenant_id and s.id=c.source_id and s.active_version_id=c.source_version_id
    join public.sms_knowledge_source_versions v
      on v.tenant_id=s.tenant_id and v.id=s.active_version_id and v.status='approved'
    where c.tenant_id=t and s.status='ready' and length(btrim(q))>0
      and c.fts @@ plainto_tsquery('english',q)
    order by c.precedence,ts_rank(c.fts,plainto_tsquery('english',q)) desc,c.id limit 5
  ) x;
  return jsonb_build_object('businessName',(select name from public.sms_businesses where tenant_id=t),
    'profileVersionId',vid,'approvedFacts',coalesce(profile,'{}'::jsonb),
    'knowledge',chunks,'hasApprovedProfile',vid is not null);
end $$;

create function sms_private.voice_read_start_otp(t text,cid text,ph text,hashed text,body text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o sms_private.voice_otps; queued jsonb;
begin
  perform sms_private.voice_read_scope(t);
  if cid is null or length(cid) not between 8 and 160 or not sms_private.voice_valid_phone(ph)
    or hashed is null or hashed !~ '^[0-9a-f]{64}$' or body is null or length(body) not between 20 and 160
    then raise exception 'Invalid verification request'; end if;
  perform pg_advisory_xact_lock(hashtextextended(t||':voice-read-otp:'||ph,991));
  if (select coalesce(sum(sent_count),0) from sms_private.voice_otps where tenant_id=t and phone=ph
      and last_sent_at>now()-interval '1 hour')>=5 then raise exception 'Verification limit reached'; end if;
  select * into o from sms_private.voice_otps where tenant_id=t and call_id=cid and phone=ph for update;
  if found and o.last_sent_at>now()-interval '60 seconds' then raise exception 'Wait before requesting another code'; end if;
  insert into public.sms_contacts(tenant_id,phone,source) values(t,ph,'voice_verification')
    on conflict(tenant_id,phone) do nothing;
  insert into sms_private.voice_otps(tenant_id,call_id,phone,code_hash,expires_at)
    values(t,cid,ph,hashed,now()+interval '5 minutes')
    on conflict(tenant_id,call_id,phone) do update set code_hash=excluded.code_hash,
      expires_at=excluded.expires_at,attempts=0,sent_count=voice_otps.sent_count+1,
      last_sent_at=now(),verified_at=null;
  queued:=sms_private.outbox(t,'voice-read-otp:'||md5(cid||':'||ph||':'||now()::text),
    jsonb_build_object('phone',ph,'body',body,'purpose','transactional'));
  return jsonb_build_object('status',queued->>'status','phoneLastFour',right(ph,4));
end $$;

create function sms_private.voice_read_verify_otp(t text,cid text,ph text,hashed text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare o sms_private.voice_otps;
begin
  perform sms_private.voice_read_scope(t);
  if cid is null or length(cid) not between 8 and 160 or not sms_private.voice_valid_phone(ph)
    or hashed is null or hashed !~ '^[0-9a-f]{64}$' then raise exception 'Invalid verification request'; end if;
  select * into o from sms_private.voice_otps where tenant_id=t and call_id=cid and phone=ph for update;
  if not found or o.expires_at<=now() or o.attempts>=3 then
    return jsonb_build_object('verified',false); end if;
  update sms_private.voice_otps set attempts=attempts+1,
    verified_at=case when code_hash=hashed then now() else null end
    where tenant_id=t and call_id=cid and phone=ph;
  return jsonb_build_object('verified',o.code_hash=hashed);
end $$;

create function sms_private.voice_read_customer(t text,cid text,ph text) returns jsonb
language plpgsql stable security definer set search_path='' as $$
declare customer jsonb; bookings jsonb;
begin
  perform sms_private.voice_read_scope(t);
  if not sms_private.voice_valid_phone(ph) or not sms_private.voice_verified(t,cid,ph)
    then raise exception 'Phone verification required' using errcode='42501'; end if;
  select jsonb_build_object('name',c.name,'phone',c.phone) into customer
    from public.sms_contacts c where c.tenant_id=t and c.phone=ph;
  select coalesce(jsonb_agg(x),'[]'::jsonb) into bookings from (
    select b.id,b.status,b.appointment_at as "appointmentAt",b.service_address as "serviceAddress",
      b.time_zone as "timeZone",b.voice_service as service
    from public.sms_bookings b where b.tenant_id=t and (b.customer_phone=ph or b.contact_id in (
      select id from public.sms_contacts where tenant_id=t and phone=ph))
    order by (b.appointment_at>=now()) desc,
      case when b.appointment_at>=now() then b.appointment_at end asc,
      case when b.appointment_at<now() then b.appointment_at end desc,b.id limit 10
  ) x;
  return jsonb_build_object('customer',customer,'bookings',bookings);
end $$;

revoke all on function sms_private.voice_read_scope(text),sms_private.voice_read_business(text,text),
  sms_private.voice_read_start_otp(text,text,text,text,text),sms_private.voice_read_verify_otp(text,text,text,text),
  sms_private.voice_read_customer(text,text,text) from public,anon,authenticated,service_role;
grant execute on function sms_private.voice_read_business(text,text),
  sms_private.voice_read_start_otp(text,text,text,text,text),sms_private.voice_read_verify_otp(text,text,text,text),
  sms_private.voice_read_customer(text,text,text) to sms_voice_lookup;
