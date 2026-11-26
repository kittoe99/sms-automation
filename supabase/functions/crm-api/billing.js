import {env} from '../_shared/http.js';

// Staff billing tools. The business's Stripe customer comes from the database
// (sms_private.platform_billing, which also checks staff access); every Stripe
// object a staff member acts on is fetched first and must belong to that customer.
const API='https://api.stripe.com/v1/';
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const REFUND_REASONS=new Set(['requested_by_customer','duplicate','fraudulent']);
const SUBSCRIPTION_ACTIONS=new Set(['cancel_at_period_end','resume','cancel_now']);
const id=(prefix,value)=>typeof value==='string'&&new RegExp(`^${prefix}_[A-Za-z0-9]{1,250}$`).test(value);
const customerOf=value=>typeof value==='string'?value:value?.id;

export function encodeStripeForm(params,prefix='',out=new URLSearchParams()) {
 const add=(name,value)=>{
  if(value===undefined||value===null)return;
  if(Array.isArray(value))value.forEach((item,index)=>add(`${name}[${index}]`,item));
  else if(typeof value==='object')encodeStripeForm(value,name,out);
  else out.append(name,String(value));
 };
 for(const [key,value] of Object.entries(params))add(prefix?`${prefix}[${key}]`:key,value);
 return out;
}

export function createBilling({environment=env,fetchImpl=fetch}={}) {
 async function stripe(method,path,params={},idempotencyKey) {
  const key=environment('STRIPE_SECRET_KEY');
  if(!key)throw fail('Stripe is not configured for the CRM.',503);
  const body=encodeStripeForm(params),url=new URL(path,API);
  if(method==='GET')url.search=body.toString();
  const response=await fetchImpl(url,{method,headers:{Authorization:`Bearer ${key}`,...(method==='GET'?{}:{'Content-Type':'application/x-www-form-urlencoded'}),...(idempotencyKey?{'Idempotency-Key':idempotencyKey}:{})},
   body:method==='GET'?undefined:body,signal:AbortSignal.timeout(15000)});
  const value=await response.json().catch(()=>null);
  if(!response.ok)throw fail(value?.error?.message||'Stripe request failed.',response.status>=500?502:400);
  return value;
 }
 async function customer(db,user,tenantId) {
  const billing=await db.call('platform_billing',user,'read',{tenantId});
  return billing;
 }
 const owned=(object,billing)=>{if(!billing.customerId||customerOf(object?.customer)!==billing.customerId)throw fail('That Stripe record does not belong to this business.',403);return object;};

 // Live view from Stripe: subscriptions and recent payments.
 async function overview(db,user,tenantId) {
  const billing=await customer(db,user,tenantId),configured=Boolean(environment('STRIPE_SECRET_KEY'));
  const base={businessName:billing.businessName,customerId:billing.customerId,exemption:billing.exemption??null,stored:billing.subscriptions,configured,dashboardUrl:billing.customerId?`https://dashboard.stripe.com/customers/${billing.customerId}`:null};
  if(!configured||!billing.customerId)return {...base,subscriptions:[],payments:[]};
  const [subscriptions,charges]=await Promise.all([
   stripe('GET','subscriptions',{customer:billing.customerId,status:'all',limit:20}),
   stripe('GET','charges',{customer:billing.customerId,limit:25}),
  ]);
  return {...base,
   subscriptions:subscriptions.data.map(s=>({id:s.id,status:s.status,cancelAtPeriodEnd:Boolean(s.cancel_at_period_end),
    currentPeriodEnd:periodEnd(s),created:new Date(s.created*1000).toISOString(),
    items:s.items.data.map(item=>({product:customerOf(item.price.product),name:item.price.nickname||null,amount:item.price.unit_amount,currency:item.price.currency}))})),
   payments:charges.data.map(c=>({id:c.id,amount:c.amount,amountRefunded:c.amount_refunded,currency:c.currency,status:c.status,paid:c.paid,
    refunded:c.refunded,disputed:Boolean(c.disputed),description:c.description||null,created:new Date(c.created*1000).toISOString(),receiptUrl:c.receipt_url||null})),
  };
 }

 // Full or partial refund of one payment. The browser sends a request id so a
 // repeated click or retry reuses the same Stripe idempotency key.
 async function refund(db,user,input) {
  const billing=await customer(db,user,input.tenantId);
  if(!id('ch',input.chargeId))throw fail('Choose a payment.');
  if(typeof input.requestId!=='string'||!/^[0-9a-f-]{36}$/i.test(input.requestId))throw fail('Missing request id.');
  const reason=input.reason||'requested_by_customer';
  if(!REFUND_REASONS.has(reason))throw fail('Choose a refund reason.');
  const charge=owned(await stripe('GET',`charges/${input.chargeId}`),billing);
  const remaining=charge.amount-charge.amount_refunded;
  const amount=input.amountCents===undefined||input.amountCents===null?remaining:Number(input.amountCents);
  if(!Number.isInteger(amount)||amount<1||amount>remaining)throw fail(`Refund between $0.01 and ${(remaining/100).toFixed(2)}.`);
  if(!charge.paid||charge.status!=='succeeded')throw fail('Only successful payments can be refunded.');
  const result=await stripe('POST','refunds',{charge:charge.id,amount,reason,metadata:{tenant_id:input.tenantId,source:'e2-crm'}},`e2-crm-refund:${input.requestId}`);
  await db.call('platform_billing',user,'audit',{tenantId:input.tenantId,kind:'refund',details:{refundId:result.id,chargeId:charge.id,amount,currency:charge.currency,reason,status:result.status,note:String(input.note||'').slice(0,500)||null}});
  return {refund:{id:result.id,amount:result.amount,status:result.status}};
 }

 async function subscription(db,user,input) {
  const billing=await customer(db,user,input.tenantId);
  if(!id('sub',input.subscriptionId))throw fail('Choose a subscription.');
  if(!SUBSCRIPTION_ACTIONS.has(input.action))throw fail('Unknown subscription action.');
  const current=owned(await stripe('GET',`subscriptions/${input.subscriptionId}`),billing);
  if(['canceled','incomplete_expired'].includes(current.status))throw fail('This subscription has already ended.');
  const result=input.action==='cancel_now'
   ? await stripe('DELETE',`subscriptions/${current.id}`)
   : await stripe('POST',`subscriptions/${current.id}`,{cancel_at_period_end:input.action==='cancel_at_period_end'});
  await db.call('platform_billing',user,'audit',{tenantId:input.tenantId,kind:input.action,details:{subscriptionId:current.id,status:result.status,cancelAtPeriodEnd:Boolean(result.cancel_at_period_end),note:String(input.note||'').slice(0,500)||null}});
  return {subscription:{id:result.id,status:result.status,cancelAtPeriodEnd:Boolean(result.cancel_at_period_end)}};
 }

 // Waive payment for a business, or require it again. Database-only: Stripe is
 // untouched, and the database checks staff access, the reason and the audit.
 async function exemption(db,user,input) {
  if(typeof input.exempt!=='boolean')throw fail('Choose whether payment is waived.');
  const reason=String(input.reason??'').trim();
  if(input.exempt&&!reason)throw fail('Give a reason.');
  if(reason.length>500)throw fail('Keep the reason under 500 characters.');
  return db.call('platform_billing',user,input.exempt?'exempt':'unexempt',{tenantId:input.tenantId,reason});
 }
 return {overview,refund,subscription,exemption};
}

// Newer Stripe API versions keep the period end on each item.
export function periodEnd(subscription) {
 const ends=[subscription.current_period_end,...(subscription.items?.data||[]).map(item=>item.current_period_end)].filter(value=>typeof value==='number'&&value>0);
 return ends.length?new Date(Math.max(...ends)*1000).toISOString():null;
}
