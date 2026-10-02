-- Business onboarding context (second onboarding form after Twilio registration).
-- Stores Get Started step-1 style business facts on sms_businesses.profile.
-- Apply with: supabase db push (already-applied files are immutable; edit only this file before first apply).

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

create or replace function sms_private.save_business_profile(u text,t text,input jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
#variable_conflict use_column
declare onboarding jsonb; services jsonb; locations jsonb; faqs jsonb; website text; summary text; hours text; contact_phone text; tone text; handoff text;
begin
 perform sms_private.require_admin(u);
 if not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Unknown business'; end if;
 services:=input->'services'; locations:=input->'locations'; faqs:=coalesce(input->'faqs','[]'::jsonb);
 if length(trim(coalesce(input->>'businessName',''))) not between 1 and 120 then raise exception 'Business name is required'; end if;
 website:=trim(coalesce(input->>'websiteUrl',''));
 if website<>'' and website !~* '^https://[^[:space:]]+$' then raise exception 'Website must start with https://'; end if;
 summary:=trim(coalesce(input->>'summary',''));
 if summary<>'' and length(summary) not between 20 and 2000 then raise exception 'Summary must be 20-2000 characters'; end if;
 if coalesce(jsonb_typeof(services),'null')<>'array' then raise exception 'Add 1-30 services, with no more than 160 characters per service'; end if;
 if jsonb_array_length(services) not between 1 and 30
   or exists(select from jsonb_array_elements_text(services) s where length(trim(s)) not between 1 and 160)
 then raise exception 'Add 1-30 services, with no more than 160 characters per service'; end if;
 if coalesce(jsonb_typeof(locations),'null')<>'array' then raise exception 'Add 1-20 service areas, with no more than 160 characters per area'; end if;
 if jsonb_array_length(locations) not between 1 and 20
   or exists(select from jsonb_array_elements_text(locations) s where length(trim(s)) not between 1 and 160)
 then raise exception 'Add 1-20 service areas, with no more than 160 characters per area'; end if;
 hours:=trim(coalesce(input->>'hours',''));
 if length(hours)>200 then raise exception 'Hours must be 200 characters or fewer'; end if;
 contact_phone:=trim(coalesce(input->>'contactPhone',''));
 if length(contact_phone)>32 then raise exception 'Contact phone must be 32 characters or fewer'; end if;
 tone:=trim(coalesce(input->>'tone',''));
 if tone<>'' and tone not in ('friendly','professional','casual') then raise exception 'Choose a brand voice'; end if;
 if coalesce(jsonb_typeof(faqs),'null')<>'array' then raise exception 'FAQs must be a list'; end if;
 if jsonb_array_length(faqs)>20
   or exists(select from jsonb_array_elements_text(faqs) s where length(trim(s)) not between 1 and 300)
 then raise exception 'Add up to 20 FAQs, with no more than 300 characters each'; end if;
 handoff:=trim(coalesce(input->>'handoff',''));
 if length(handoff)>1000 then raise exception 'Handoff rule must be 1000 characters or fewer'; end if;
 onboarding:=jsonb_build_object(
   'businessName',trim(input->>'businessName'),
   'websiteUrl',website,
   'summary',summary,
   'services',(select coalesce(jsonb_agg(trim(s)),'[]'::jsonb) from jsonb_array_elements_text(services) s),
   'locations',(select coalesce(jsonb_agg(trim(s)),'[]'::jsonb) from jsonb_array_elements_text(locations) s),
   'hours',hours,
   'contactPhone',contact_phone,
   'tone',tone,
   'faqs',(select coalesce(jsonb_agg(trim(s)),'[]'::jsonb) from jsonb_array_elements_text(faqs) s where trim(s)<>''),
   'handoff',handoff,
   'updatedAt',now(),'completedAt',now());
 update public.sms_businesses set profile=coalesce(profile,'{}'::jsonb)||jsonb_build_object('onboarding',onboarding) where tenant_id=t;
 insert into sms_private.audit(tenant_id,actor,action,detail) values(t,u,'business_onboarding_saved',jsonb_build_object('services',jsonb_array_length(services)));
 return sms_private.business_profile(u,t);
end $$;

revoke all on function sms_private.business_profile(text,text),sms_private.save_business_profile(text,text,jsonb) from public,anon,authenticated;
grant execute on function sms_private.business_profile(text,text),sms_private.save_business_profile(text,text,jsonb) to sms_api;
