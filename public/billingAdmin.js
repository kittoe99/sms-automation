const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
// Plan codes and Stripe products sold on the E2 dashboard (E2 lib/billing-plans.ts).
const PLAN_NAMES={full_system:'Full System',website:'Website',sales_closer:'Sales Closer',sms_marketing:'SMS Marketing'};
const PRODUCT_NAMES={e2_full_system:'Full System',e2_website:'Website',e2_sales_closer:'Sales Closer',e2_sms_marketing:'SMS Marketing'};
const STATUS={incomplete:'Payment pending',incomplete_expired:'Checkout expired',trialing:'Trial',active:'Active',past_due:'Payment overdue',canceled:'Canceled',unpaid:'Unpaid',paused:'Paused'};
const REASONS={requested_by_customer:'Requested by customer',duplicate:'Duplicate payment',fraudulent:'Fraudulent'};
const money=(cents,currency='usd')=>(cents/100).toLocaleString('en-US',{style:'currency',currency:currency.toUpperCase()});
const day=value=>value?new Date(value).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'}):'—';
const ended=status=>['canceled','incomplete_expired'].includes(status);

// One line for the Business setup list. Exempt businesses open the E2 dashboard
// without paying (E2 platform_billing_exemptions).
export function billingSummary(billing,exempt=false) {
 const waived=exempt?' · payment waived':'';
 if(!billing)return `No subscription${waived}`;
 const plans=(billing.plans||[]).map(code=>PLAN_NAMES[code]||code).join(', ')||'Subscription';
 return `${plans} · ${STATUS[billing.status]||billing.status}${billing.cancelAtPeriodEnd&&!ended(billing.status)?' · cancels at period end':''}${waived}`;
}

// Whether the customer must pay before their E2 dashboard opens.
function requirementSection(exemption) {
 return `<section data-exemption><h4>Payment requirement</h4>${exemption
  ?`<p><strong>Payment waived.</strong> ${esc(exemption.reason)} · ${esc(exemption.createdBy||'E2 Local')}${exemption.createdAt?` · ${esc(day(exemption.createdAt))}`:''}</p>
   <p>The customer's dashboard opens without a subscription.</p>
   <div class="compose-actions"><button type="button" class="btn ghost" data-require-payment>Require payment</button></div>`
  :`<p>The customer must have an active, trial or overdue subscription before their dashboard opens.</p>
   <form class="compose" data-waive><label class="compose-label">Reason (required)<input name="reason" maxlength="500" required placeholder="Comped partner, invoiced offline…"></label>
   <div class="compose-actions"><button class="btn ghost">Waive payment</button></div></form>`}</section>`;
}

// Staff billing card for one business: live Stripe subscriptions and payments,
// refunds, cancel/resume, and a link to the customer in Stripe.
export async function mountBillingAdmin(container,{tenantId,read,write,confirm=message=>window.confirm(message),notice=''}) {
 if(!container)return;
 container.innerHTML='<section class="card billing-admin"><h3>Billing</h3><p>Loading billing…</p></section>';
 let data;
 try{data=await read('billing',{tenantId});}
 catch(error){container.innerHTML=`<section class="card billing-admin"><h3>Billing</h3><p class="login-error" role="alert">${esc(error.message)}</p></section>`;return;}
 const subs=data.subscriptions||[],payments=data.payments||[];
 const intro=!data.configured?'<p>Stripe is not configured for the CRM (set <code>STRIPE_SECRET_KEY</code> on the crm-api function).</p>'
  :!data.customerId?'<p>This business has not started a subscription. Owners subscribe from Account → Billing in their E2 dashboard.</p>'
  :`<p><a class="btn ghost" href="${esc(data.dashboardUrl)}" target="_blank" rel="noopener noreferrer">Open in Stripe</a> Plan changes, coupons and disputes are handled in Stripe.</p>`;
 container.innerHTML=`<section class="card billing-admin"><h3>Billing</h3>${intro}<p data-billing-error class="login-error" role="alert"></p><p data-billing-status role="status">${esc(notice)}</p>${requirementSection(data.exemption)}
  ${subs.length?`<h4>Subscriptions</h4>${subs.map(s=>`<article class="card" data-subscription="${esc(s.id)}">
   <p><strong>${esc(s.items.map(i=>PRODUCT_NAMES[i.product]||i.name||i.product).join(', '))}</strong> · ${esc(STATUS[s.status]||s.status)}
    · ${esc(money(s.items.reduce((sum,i)=>sum+(i.amount||0),0),s.items[0]?.currency))}/month</p>
   <p>${ended(s.status)?'Ended':s.cancelAtPeriodEnd?`Cancels ${esc(day(s.currentPeriodEnd))}`:`Renews ${esc(day(s.currentPeriodEnd))}`} · started ${esc(day(s.created))} · <code>${esc(s.id)}</code></p>
   ${ended(s.status)?'':`<div class="compose-actions">${s.cancelAtPeriodEnd?'<button type="button" class="btn ghost" data-sub-action="resume">Keep subscription</button>'
     :'<button type="button" class="btn ghost" data-sub-action="cancel_at_period_end">Cancel at period end</button>'}
    <button type="button" class="btn ghost" data-sub-action="cancel_now">Cancel now</button></div>`}</article>`).join('')}`:''}
  ${payments.length?`<h4>Payments</h4>${payments.map(p=>{const remaining=p.amount-p.amountRefunded,refundable=p.paid&&p.status==='succeeded'&&remaining>0;
   return `<article class="card" data-payment="${esc(p.id)}"><p><strong>${esc(money(p.amount,p.currency))}</strong> · ${esc(day(p.created))} · ${esc(p.status)}
    ${p.amountRefunded?` · refunded ${esc(money(p.amountRefunded,p.currency))}`:''}${p.disputed?' · <strong>disputed</strong>':''}</p>
    ${p.description?`<p>${esc(p.description)}</p>`:''}
    <div class="compose-actions">${p.receiptUrl?`<a class="btn ghost" href="${esc(p.receiptUrl)}" target="_blank" rel="noopener noreferrer">Receipt</a>`:''}
     ${refundable?'<button type="button" class="btn ghost" data-refund-open>Refund…</button>':''}</div>
    ${refundable?`<form class="compose" data-refund hidden>
     <label class="compose-label">Amount (USD)<input name="amount" type="number" step="0.01" min="0.01" max="${(remaining/100).toFixed(2)}" value="${(remaining/100).toFixed(2)}" required></label>
     <label class="compose-label">Reason<select name="reason">${Object.entries(REASONS).map(([value,label])=>`<option value="${value}">${esc(label)}</option>`).join('')}</select></label>
     <label class="compose-label">Internal note (optional)<input name="note" maxlength="500"></label>
     <div class="compose-actions"><button class="btn">Refund payment</button><button type="button" class="btn ghost" data-refund-cancel>Cancel</button></div></form>`:''}
   </article>`;}).join('')}`:data.customerId&&data.configured?'<p>No payments yet.</p>':''}
 </section>`;
 const error=container.querySelector('[data-billing-error]'),status=container.querySelector('[data-billing-status]');
 async function perform(button,action,done){
  button.disabled=true;error.textContent='';status.textContent='';
  try{await action();}catch(e){error.textContent=e.message;button.disabled=false;return;}
  await mountBillingAdmin(container,{tenantId,read,write,confirm,notice:done});
 }
 container.querySelector('[data-require-payment]')?.addEventListener('click',event=>{
  if(!confirm('Require payment again? Unless this business has an active, trial or overdue subscription, its users are sent to the plan step until the owner pays.'))return;
  void perform(event.currentTarget,()=>write('billing/exemption',{tenantId,exempt:false}),'Payment is required again.');
 });
 container.querySelector('[data-waive]')?.addEventListener('submit',event=>{
  event.preventDefault();const reason=String(new FormData(event.currentTarget).get('reason')||'').trim();
  if(!reason)return;
  if(!confirm('Waive payment? This business’s dashboard opens without a subscription until payment is required again.'))return;
  void perform(event.submitter,()=>write('billing/exemption',{tenantId,exempt:true,reason}),'Payment waived.');
 });
 container.querySelectorAll('[data-sub-action]').forEach(button=>button.addEventListener('click',()=>{
  const subscriptionId=button.closest('[data-subscription]').dataset.subscription,action=button.dataset.subAction;
  const message={cancel_at_period_end:'Cancel this subscription at the end of the current billing period? The customer keeps access until then.',
   resume:'Keep this subscription and remove the scheduled cancellation?',
   cancel_now:'Cancel this subscription immediately? Billing stops now and no refund is made automatically.'}[action];
  if(!confirm(message))return;
  void perform(button,()=>write('billing/subscription',{tenantId,subscriptionId,action}),
   {cancel_at_period_end:'Cancellation scheduled.',resume:'Cancellation removed.',cancel_now:'Subscription canceled.'}[action]);
 }));
 container.querySelectorAll('[data-payment]').forEach(card=>{
  const form=card.querySelector('[data-refund]');if(!form)return;
  const requestId=crypto.randomUUID();
  card.querySelector('[data-refund-open]').addEventListener('click',()=>{form.hidden=false;form.querySelector('input').focus();});
  form.querySelector('[data-refund-cancel]').addEventListener('click',()=>{form.hidden=true;});
  form.addEventListener('submit',event=>{
   event.preventDefault();const values=new FormData(form),amountCents=Math.round(Number(values.get('amount'))*100);
   if(!confirm(`Refund ${money(amountCents)} to the customer? This sends money back and cannot be undone.`))return;
   void perform(event.submitter,()=>write('billing/refund',{tenantId,chargeId:card.dataset.payment,amountCents,reason:values.get('reason'),note:values.get('note'),requestId}),'Refund sent.');
  });
 });
}
