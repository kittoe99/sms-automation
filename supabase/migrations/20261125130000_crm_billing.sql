-- CRM-owned forward migration. Runs only with E2 20261125120000_customer_billing.sql
-- (live version 20261126030348 customer_billing), whose tables this function reads
-- at call time. The Business setup billing summary is E2-owned
-- (E2 20261125140000_billing_business_list.sql). Apply only this missing migration;
-- never replay either paired history.
-- Staff billing in the CRM. Refunds and cancellations run against Stripe from the
-- crm-api Edge function; the database only answers which Stripe customer belongs
-- to a business, lists the stored subscriptions, and audits every staff action.
-- Subscription rows are still written only by the E2 Stripe webhook.
create function sms_private.platform_billing(u text,action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid:=sms_private.platform_actor(u); t text:=p->>'tenantId'; kind text:=p->>'kind';
begin
 if aid is null or not sms_private.platform_staff(aid) then raise exception 'Staff access required' using errcode='42501'; end if;
 if t is null or not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Business not found' using errcode='P0002'; end if;
 if action='read' then
  return jsonb_build_object(
   'businessName',(select b.name from public.sms_businesses b where b.tenant_id=t),
   'customerId',(select c.stripe_customer_id from public.platform_billing_customers c where c.tenant_id=t),
   'subscriptions',coalesce((select jsonb_agg(jsonb_build_object('id',s.stripe_subscription_id,'status',s.status,'plans',to_jsonb(s.plans),
     'currentPeriodEnd',s.current_period_end,'cancelAtPeriodEnd',s.cancel_at_period_end,'updatedAt',s.updated_at)
     order by (s.status in ('canceled','incomplete_expired')),s.updated_at desc)
    from public.platform_billing_subscriptions s where s.tenant_id=t),'[]'::jsonb));
 end if;
 -- Called by crm-api after Stripe accepted a staff refund or subscription change.
 if action='audit' then
  if kind is null or kind not in ('refund','cancel_at_period_end','resume','cancel_now') then raise exception 'Unknown billing action' using errcode='22023'; end if;
  insert into public.platform_audit(actor_account_id,action,target,changed) values(aid,'billing_'||kind,t,coalesce(p->'details','{}'::jsonb));
  return jsonb_build_object('audited',true);
 end if;
 raise exception 'Unknown billing operation' using errcode='22023';
end $$;

revoke all on function sms_private.platform_billing(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function sms_private.platform_billing(text,text,jsonb) to sms_api;
