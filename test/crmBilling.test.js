import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createBilling,encodeStripeForm,periodEnd} from '../supabase/functions/crm-api/billing.js';
import {billingSummary} from '../public/billingAdmin.js';

const requestId='6f1c2b9e-1111-4222-8333-944455556666';
function fixture({customerId='cus_1',charge={},subscription={},key='sk_test_x'}={}) {
 const calls=[],stripe=[];
 const objects={
  charge:{id:'ch_1',customer:'cus_1',amount:59700,amount_refunded:0,currency:'usd',status:'succeeded',paid:true,...charge},
  subscription:{id:'sub_1',customer:'cus_1',status:'active',cancel_at_period_end:false,...subscription},
 };
 const db={call:async(name,user,action,p)=>{calls.push([name,user,action,p]);
  if(action==='read')return {businessName:'Example Services',customerId,subscriptions:[]};
  return {audited:true};}};
 const fetchImpl=async(url,init)=>{
  const u=new URL(url),body=init.body?Object.fromEntries(new URLSearchParams(init.body.toString())):Object.fromEntries(u.searchParams);
  stripe.push({method:init.method,path:u.pathname.replace('/v1/',''),body,key:init.headers['Idempotency-Key']});
  const path=u.pathname.replace('/v1/','');
  const value=path==='subscriptions'?{data:[{...objects.subscription,created:1795000000,items:{data:[{price:{product:'e2_full_system',unit_amount:59700,currency:'usd'},current_period_end:1800000000}]}}]}
   :path==='charges'?{data:[{...objects.charge,created:1795000000,receipt_url:'https://pay.stripe.com/receipts/x'}]}
   :path.startsWith('charges/')?objects.charge
   :path==='refunds'?{id:'re_1',amount:Number(body.amount),status:'succeeded'}
   :path.startsWith('subscriptions/')?(init.method==='DELETE'?{...objects.subscription,status:'canceled'}:init.method==='POST'?{...objects.subscription,cancel_at_period_end:body.cancel_at_period_end==='true'}:objects.subscription)
   :{};
  return new Response(JSON.stringify(value),{status:200});
 };
 return {api:createBilling({environment:name=>name==='STRIPE_SECRET_KEY'?key:undefined,fetchImpl}),calls,stripe};
}

test('Stripe form encoding and period end',()=>{
 assert.equal(encodeStripeForm({charge:'ch_1',metadata:{tenant_id:'t'},skip:undefined}).toString(),'charge=ch_1&metadata%5Btenant_id%5D=t');
 assert.equal(periodEnd({items:{data:[{current_period_end:1800000000}]}}),new Date(1800000000*1000).toISOString());
});

test('overview: staff check first, live subscriptions and payments, Stripe link',async()=>{
 const x=fixture();const view=await x.api.overview({call:async(...a)=>{x.calls.push(a);return {businessName:'Example Services',customerId:'cus_1',subscriptions:[]};}},'staff','tenant-1');
 assert.deepEqual(x.calls[0],['platform_billing','staff','read',{tenantId:'tenant-1'}]);
 assert.equal(view.dashboardUrl,'https://dashboard.stripe.com/customers/cus_1');
 assert.equal(view.subscriptions[0].items[0].product,'e2_full_system');
 assert.equal(view.payments[0].amount,59700);
 assert.deepEqual(x.stripe.map(s=>[s.method,s.path,s.body.customer]),[['GET','subscriptions','cus_1'],['GET','charges','cus_1']]);
});

test('overview without a Stripe customer or key makes no Stripe calls',async()=>{
 let x=fixture({customerId:null});let view=await x.api.overview({call:async()=>({customerId:null,subscriptions:[]})},'staff','t');
 assert.equal(view.payments.length,0);assert.equal(x.stripe.length,0);
 x=fixture({key:''});view=await x.api.overview({call:async()=>({customerId:'cus_1',subscriptions:[]})},'staff','t');
 assert.equal(view.configured,false);assert.equal(x.stripe.length,0);
});

test('refund: full by default, partial within the remaining amount, idempotent and audited',async()=>{
 let x=fixture();
 let r=await x.api.refund({call:async(n,u,a,p)=>{x.calls.push([n,u,a,p]);return a==='read'?{customerId:'cus_1'}:{audited:true};}},'staff',{tenantId:'t',chargeId:'ch_1',requestId,reason:'duplicate'});
 assert.equal(r.refund.amount,59700);
 const post=x.stripe.find(s=>s.path==='refunds');
 assert.equal(post.body.amount,'59700');assert.equal(post.body.reason,'duplicate');assert.equal(post.key,`e2-crm-refund:${requestId}`);
 assert.equal(x.calls.at(-1)[2],'audit');assert.equal(x.calls.at(-1)[3].kind,'refund');assert.equal(x.calls.at(-1)[3].details.amount,59700);

 x=fixture({charge:{amount_refunded:50000}});
 const db={call:async(n,u,a)=>a==='read'?{customerId:'cus_1'}:{audited:true}};
 r=await x.api.refund(db,'staff',{tenantId:'t',chargeId:'ch_1',requestId,amountCents:9700});
 assert.equal(r.refund.amount,9700);
 await assert.rejects(x.api.refund(db,'staff',{tenantId:'t',chargeId:'ch_1',requestId,amountCents:9701}),/between/);
 await assert.rejects(x.api.refund(db,'staff',{tenantId:'t',chargeId:'ch_1',requestId,amountCents:0}),/between/);
 await assert.rejects(x.api.refund(db,'staff',{tenantId:'t',chargeId:'ch_1',requestId,reason:'because'}),/reason/);
 await assert.rejects(x.api.refund(db,'staff',{tenantId:'t',chargeId:'ch_1'}),/request id/);
});

test('refund and cancel refuse another business\'s Stripe records',async()=>{
 const x=fixture({charge:{customer:'cus_other'},subscription:{customer:'cus_other'}});
 const db={call:async(n,u,a)=>a==='read'?{customerId:'cus_1'}:assert.fail('must not audit')};
 await assert.rejects(x.api.refund(db,'staff',{tenantId:'t',chargeId:'ch_1',requestId}),e=>e.status===403);
 await assert.rejects(x.api.subscription(db,'staff',{tenantId:'t',subscriptionId:'sub_1',action:'cancel_now'}),e=>e.status===403);
 assert.equal(x.stripe.some(s=>s.method!=='GET'),false);
});

test('subscription: schedule, resume and cancel now',async()=>{
 const db={call:async(n,u,a)=>a==='read'?{customerId:'cus_1'}:{audited:true}};
 let x=fixture();let r=await x.api.subscription(db,'staff',{tenantId:'t',subscriptionId:'sub_1',action:'cancel_at_period_end'});
 assert.equal(r.subscription.cancelAtPeriodEnd,true);assert.deepEqual(x.stripe.at(-1),{method:'POST',path:'subscriptions/sub_1',body:{cancel_at_period_end:'true'},key:undefined});
 x=fixture({subscription:{cancel_at_period_end:true}});r=await x.api.subscription(db,'staff',{tenantId:'t',subscriptionId:'sub_1',action:'resume'});
 assert.equal(r.subscription.cancelAtPeriodEnd,false);
 x=fixture();r=await x.api.subscription(db,'staff',{tenantId:'t',subscriptionId:'sub_1',action:'cancel_now'});
 assert.equal(r.subscription.status,'canceled');assert.equal(x.stripe.at(-1).method,'DELETE');
 x=fixture({subscription:{status:'canceled'}});
 await assert.rejects(x.api.subscription(db,'staff',{tenantId:'t',subscriptionId:'sub_1',action:'cancel_now'}),/already ended/);
 await assert.rejects(x.api.subscription(db,'staff',{tenantId:'t',subscriptionId:'sub_1',action:'pause'}),/Unknown/);
});

test('business list billing summary',()=>{
 assert.equal(billingSummary(null),'No subscription');
 assert.equal(billingSummary({status:'active',plans:['website','sms_marketing'],cancelAtPeriodEnd:true}),'Website, SMS Marketing · Active · cancels at period end');
});

test('migrations: CRM staff function, E2 business-list wrapper',async()=>{
 const crm=await readFile(new URL('../supabase/migrations/20261125130000_crm_billing.sql',import.meta.url),'utf8');
 assert.match(crm,/platform_staff\(aid\)/);assert.doesNotMatch(crm,/alter function/);
 assert.match(crm,/grant execute on function sms_private\.platform_billing\(text,text,jsonb\) to sms_api/);
 const e2=await readFile(new URL('../../E2local-main/supabase/migrations/20261125140000_billing_business_list.sql',import.meta.url),'utf8');
 assert.match(e2,/rename to platform_read_before_billing/);
});
