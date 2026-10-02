-- Production follow-up: restore the onboarding read RPC and make pgvector's
-- distance operator explicit for security-definer functions with an empty
-- search_path.

create or replace function sms_private.business_profile(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
begin
 perform sms_private.require_admin(u);
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 return coalesce((select jsonb_build_object(
   'onboarding',coalesce(b.profile->'onboarding','{}'::jsonb),
   'onboardingComplete',coalesce((b.profile->'onboarding'->>'completedAt') is not null,false),
   'updatedAt',b.profile->'onboarding'->>'updatedAt')
   from public.sms_businesses b where b.tenant_id=t),
   jsonb_build_object('onboarding','{}'::jsonb,'onboardingComplete',false));
end $$;

create or replace function sms_private.search_job_knowledge(jid uuid,token uuid,query text,query_embedding text,match_count integer default 8) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare j sms_private.jobs; result jsonb;
begin
 j:=sms_private.lease(jid,token); if j.queue<>'ai_reply_jobs' then raise exception 'Wrong queue'; end if;
 match_count:=least(greatest(coalesce(match_count,8),1),20);
 if nullif(query_embedding,'') is null then
  select coalesce(jsonb_agg(x),'[]') into result from (
   select c.id,c.content,c.metadata,c.precedence,s.title,s.origin,ts_rank_cd(c.fts,websearch_to_tsquery('english',query)) score
   from public.sms_knowledge_chunks c join public.sms_knowledge_sources s on s.tenant_id=c.tenant_id and s.id=c.source_id and s.active_version_id=c.source_version_id
   join public.sms_knowledge_source_versions v on v.tenant_id=c.tenant_id and v.id=c.source_version_id and v.status='approved'
   where c.tenant_id=j.tenant_id and s.status='ready' and c.fts @@ websearch_to_tsquery('english',query)
   order by c.precedence,score desc limit match_count) x;
 else
  execute $q$with keyword as (
    select c.id,row_number() over(order by ts_rank_cd(c.fts,websearch_to_tsquery('english',$2)) desc) r
    from public.sms_knowledge_chunks c join public.sms_knowledge_sources s on s.tenant_id=c.tenant_id and s.id=c.source_id and s.active_version_id=c.source_version_id
    join public.sms_knowledge_source_versions v on v.tenant_id=c.tenant_id and v.id=c.source_version_id and v.status='approved'
    where c.tenant_id=$1 and s.status='ready' and c.fts @@ websearch_to_tsquery('english',$2) limit 30), semantic as (
    select c.id,row_number() over(order by c.embedding OPERATOR(extensions.<=>) $3::extensions.vector) r
    from public.sms_knowledge_chunks c join public.sms_knowledge_sources s on s.tenant_id=c.tenant_id and s.id=c.source_id and s.active_version_id=c.source_version_id
    join public.sms_knowledge_source_versions v on v.tenant_id=c.tenant_id and v.id=c.source_version_id and v.status='approved'
    where c.tenant_id=$1 and s.status='ready' and c.embedding is not null order by c.embedding OPERATOR(extensions.<=>) $3::extensions.vector limit 30), ranked as (
    select coalesce(k.id,s.id) id,coalesce(1.0/(50+k.r),0)+coalesce(1.0/(50+s.r),0) score from keyword k full join semantic s using(id))
    select coalesce(jsonb_agg(x),'[]') from (select c.id,c.content,c.metadata,c.precedence,src.title,src.origin,r.score
    from ranked r join public.sms_knowledge_chunks c on c.tenant_id=$1 and c.id=r.id join public.sms_knowledge_sources src on src.tenant_id=c.tenant_id and src.id=c.source_id
    order by c.precedence,r.score desc limit $4) x$q$ into result using j.tenant_id,query,query_embedding,match_count;
 end if;
 return result;
end $$;

create or replace function sms_private.activation_readiness(u text,t text) returns jsonb
language plpgsql security definer set search_path='' as $$
declare reasons jsonb:='[]'::jsonb; p sms_private.providers; r public.sms_twilio_registrations; b public.sms_businesses;
begin
 perform sms_private.require_admin(u); select * into strict b from public.sms_businesses where tenant_id=t; select * into p from sms_private.providers where tenant_id=t; select * into r from public.sms_twilio_registrations where tenant_id=t;
 if b.active_profile_version_id is null then reasons:=reasons||'"approved_business_profile_required"'; end if;
 if p.auth_secret_id is null or p.account_sid is null then reasons:=reasons||'"child_credentials_required"'; end if;
 if p.from_number is null or p.phone_number_sid is null then reasons:=reasons||'"owned_phone_number_required"'; end if;
 if p.messaging_service_sid is null or r.messaging_service_sid is distinct from p.messaging_service_sid then reasons:=reasons||'"messaging_service_attachment_required"'; end if;
 if r.state not in ('webhook_verified','canary_pending','ready') then reasons:=reasons||'"approved_registration_required"'; end if;
 return jsonb_build_object('ready',jsonb_array_length(reasons)=0,'reasons',reasons,'registrationState',r.state,'sendingEnabled',b.sending_enabled);
end $$;

alter function sms_private.validate_business_facts(jsonb) stable;

revoke all on function sms_private.business_profile(text,text),sms_private.search_job_knowledge(uuid,uuid,text,text,integer),sms_private.activation_readiness(text,text)
 from public,anon,authenticated;
grant execute on function sms_private.business_profile(text,text),sms_private.activation_readiness(text,text) to sms_api;
grant execute on function sms_private.search_job_knowledge(uuid,uuid,text,text,integer) to sms_ai;
