-- CRM-owned forward migration. Apply after E2 20261127010000_paid_account_access.sql,
-- which owns public.platform_billing_exemptions (read here at call time), and after
-- CRM 20261125130000_crm_billing. Apply only this missing migration; never replay
-- either paired history.
-- Staff can waive payment for a business (comped, invoiced offline, partner). The
-- E2 dashboard opens for an exempt business without a Stripe subscription. Waiving
-- needs a reason; waiving and requiring payment again are both audited. Stripe is
-- not touched: an existing subscription keeps billing until staff cancel it.
create or replace function sms_private.platform_billing(u text,action text,p jsonb) returns jsonb
language plpgsql security definer set search_path='' as $$
declare aid uuid:=sms_private.platform_actor(u); t text:=p->>'tenantId'; kind text:=p->>'kind';
 reason text:=nullif(btrim(coalesce(p->>'reason','')),''); e record; -- record, not the E2 table's type: that table may not exist yet when this is created
begin
 if aid is null or not sms_private.platform_staff(aid) then raise exception 'Staff access required' using errcode='42501'; end if;
 if t is null or not exists(select from public.sms_businesses where tenant_id=t) then raise exception 'Business not found' using errcode='P0002'; end if;
 if action='read' then
  return jsonb_build_object(
   'businessName',(select b.name from public.sms_businesses b where b.tenant_id=t),
   'customerId',(select c.stripe_customer_id from public.platform_billing_customers c where c.tenant_id=t),
   'exemption',(select jsonb_build_object('reason',x.reason,'createdAt',x.created_at,'createdBy',coalesce(a.clerk_display_name,a.clerk_primary_email))
     from public.platform_billing_exemptions x left join public.dashboard_accounts a on a.id=x.created_by where x.tenant_id=t),
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
 if action='exempt' then
  if reason is null then raise exception 'Give a reason' using errcode='22023'; end if;
  if char_length(reason)>500 then raise exception 'Keep the reason under 500 characters' using errcode='22023'; end if;
  insert into public.platform_billing_exemptions(tenant_id,reason,created_by) values(t,reason,aid) on conflict(tenant_id) do nothing returning * into e;
  if not found then raise exception 'Payment is already waived for this business' using errcode='23505'; end if;
  insert into public.platform_audit(actor_account_id,action,target,changed) values(aid,'billing_exempt',t,to_jsonb(e));
  return jsonb_build_object('exempt',true);
 end if;
 if action='unexempt' then
  delete from public.platform_billing_exemptions where tenant_id=t returning * into e;
  if not found then raise exception 'Payment is not waived for this business' using errcode='P0002'; end if;
  insert into public.platform_audit(actor_account_id,action,target,changed) values(aid,'billing_exempt_removed',t,to_jsonb(e)||jsonb_build_object('note',left(reason,500)));
  return jsonb_build_object('exempt',false);
 end if;
 raise exception 'Unknown billing operation' using errcode='22023';
end $$;

revoke all on function sms_private.platform_billing(text,text,jsonb) from public,anon,authenticated,service_role;
grant execute on function sms_private.platform_billing(text,text,jsonb) to sms_api;
