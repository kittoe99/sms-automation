import {normalizePhoneInput,installPhoneFormatting} from './phoneInput.js?v=20261003-phone';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const approvedStates=['approved','webhook_verified','canary_pending','ready','active'];
export function smsSetupActionsHtml({staff=false,summary=null}={}) {
 if(!staff)return '';
 const active=summary?.messagingStatus==='active',ready=!active&&summary?.activationStatus==='ready';
 return `<section class="card"><h2>SMS setup & activation</h2><p>${active?'SMS is enabled. View your connected account and approved senders.':ready?'Your sender is approved and the delivery test has passed. One step remains: enable SMS.':'Choose an approved Twilio account and sender, then complete the delivery test and enable SMS.'}</p><div class="compose-actions"><button type="button" class="btn ghost" data-dashboard-twilio>Approved Twilio accounts</button><button type="button" class="btn" data-complete-business-setup>${active?'View SMS activation':ready?'Review and enable SMS':'Continue SMS activation'}</button></div></section>`;
}
export function activationView(provider={},registration={}) {
 const state=registration.state||'unknown',active=provider.sendingEnabled===true;
 return {state,active,approved:approvedStates.includes(state),test:!active&&state==='webhook_verified',pending:!active&&state==='canary_pending',enable:!active&&state==='ready',
  title:active?'SMS is active':state==='ready'?'Ready to enable SMS':state==='canary_pending'?'Waiting for test delivery':state==='webhook_verified'?'Test your business number':'Check your SMS connection'};
}
export function activationHtml({provider={},registration={},businessName=''}) {
 const p=provider.connectionDetails||{},v=activationView(provider,registration);
 const sender=p.senderType||registration.sender_type;
 return `<div class="setup-page sms-activation"><div class="setup-topbar"><button type="button" class="btn ghost" data-back>← Dashboard</button><span class="setup-status ${v.active?'ok':''}">${v.active?'SMS active':v.enable?'Awaiting activation':'Sending disabled'}</span></div>
 <section class="card twilio-connect-card"><span class="twilio-eyebrow">SMS FOR ${esc(businessName||'THIS BUSINESS')}</span><h2>${esc(v.title)}</h2>
 <p class="twilio-connected-number">${esc(provider.phoneNumber||'No number connected')}</p>
 <p>${esc(p.profileName||p.legalBusinessName||businessName||'Connected business')} · ${sender==='toll_free'?'Toll-free':sender==='local_a2p'?'A2P 10DLC':'Sender type unavailable'}</p>
 <ol class="sms-activation-steps" aria-label="SMS activation progress"><li class="${v.approved?'done':''}"><span>1</span>Approved sender</li><li class="${v.enable||v.active?'done':''}"><span>2</span>Delivery test</li><li class="${v.active?'done':''}"><span>3</span>Enable SMS</li></ol>
 ${v.test?`<form data-test><p>Your saved business details and Twilio approval are already in place. Enter a mobile number you control for one delivery test.</p><label>Test mobile number<input name="phone" type="tel" required autocomplete="tel" placeholder="(303) 555-0123" value="${esc(registration.canary_phone||'')}" /></label><p class="profile-note">US/Canada: +1 is added automatically. For other countries, include +country code.</p><p class="profile-note">One test SMS will be sent. Standard Twilio charges apply.</p><button class="btn" type="submit">Send test SMS</button></form>`:''}
 ${v.pending?'<p role="status">Your test SMS is on its way. Check delivery status to continue.</p>':''}
 ${v.enable?'<p>The test was delivered successfully. Enable SMS for this business when you are ready.</p><button class="btn" type="button" data-enable>Enable SMS</button>':''}
 ${v.active?'<p>This business can send SMS. Manage your messages and schedules in Forms.</p><button class="btn" type="button" data-forms>Open Forms</button>':''}
 ${!v.active&&!v.test&&!v.pending&&!v.enable?'<p>The sender needs an approval or connection check before activation. Check status, or review the approved Twilio accounts below.</p>':''}
 ${!v.active?'<button class="btn ghost" type="button" data-refresh>Check status</button>':''}
 <button class="btn ghost" type="button" data-business>Approved Twilio accounts</button>
 <p data-feedback role="status"></p><p data-error class="login-error" role="alert"></p>
 </section><details class="card sms-activation-details"><summary>Connection details & troubleshooting</summary><dl class="twilio-details"><div><dt>Profile</dt><dd>${esc(p.profileName||p.legalBusinessName||'Not available')}</dd></div><div><dt>Registration status</dt><dd>${esc(v.state.replaceAll('_',' '))}</dd></div><div><dt>Twilio account</dt><dd>${esc(p.accountName||'Not available')}<small>${esc(p.accountSid)}</small></dd></div><div><dt>Messaging service</dt><dd>${esc(p.serviceName||'Not available')}<small>${esc(p.messagingServiceSid)}</small></dd></div></dl>${registration.rejection_reason?`<p class="login-error">${esc(registration.rejection_reason)}</p>`:''}<p>Customer dashboard visibility is managed separately in Businesses.</p></details></div>`;
}
export function mountTwilioActivation(container,{provider,registration,apiFetch,onRefresh,onBack,onBusiness,onForms,businessName}) {
 installPhoneFormatting(container);
 container.innerHTML=activationHtml({provider,registration,businessName});
 container.querySelector('[data-back]').onclick=onBack;
 container.querySelector('[data-business]')?.addEventListener('click',onBusiness);
 container.querySelector('[data-forms]')?.addEventListener('click',onForms);
 const error=container.querySelector('[data-error]'),feedback=container.querySelector('[data-feedback]');
 async function perform(button,path,input) {
  error.textContent='';feedback.textContent='';button.disabled=true;
  try {
   const response=await apiFetch(`/api/twilio/${path}`,{method:'POST',body:JSON.stringify(input)}),result=await response.json();
   if(!response.ok)throw new Error(result.error||'SMS setup could not be updated.');
   if(path==='canary') {container.querySelector('[data-test]').hidden=true;feedback.textContent='Test queued. Use Check status to see delivery progress.';return;}
   if(path==='status-refresh'){feedback.textContent='Status check requested. Check again shortly for the result.';button.disabled=false;return;}
   await onRefresh();
  }catch(e){error.textContent=e.message;button.disabled=false;}
 }
 container.querySelector('[data-test]')?.addEventListener('submit',event=>{
  event.preventDefault();const phone=normalizePhoneInput(event.currentTarget.elements.phone.value);
  if(!/^\+[1-9]\d{7,14}$/.test(phone)){error.textContent='Enter a 10-digit US/Canada number, or an international number with +country code.';return;}
  if(!confirm(`Send one test SMS to ${phone}? Standard Twilio charges apply.`))return;
  void perform(event.currentTarget.querySelector('button'),'canary',{phone,confirmed:true});
 });
 container.querySelector('[data-enable]')?.addEventListener('click',event=>void perform(event.currentTarget,'activate',{}));
 container.querySelector('[data-refresh]')?.addEventListener('click',async event=>{
  const button=event.currentTarget;button.disabled=true;error.textContent='';
  try {
   const response=await apiFetch('/api/twilio/registration'),latest=await response.json();
   if(!response.ok)throw new Error(latest.error||'Could not load SMS status.');
   if(latest.state!==registration.state||latest.updated_at!==registration.updated_at){await onRefresh();return;}
   await perform(button,'status-refresh',{});
  }catch(e){error.textContent=e.message;}finally{button.disabled=false;}
 });
}
export function mountSmsSetupChoice(container,{businessName,serviceAdded,onBusiness,onRegister,onBack}) {
 container.innerHTML=`<div class="setup-page sms-activation"><button class="btn ghost" data-back>← Dashboard</button><section class="card twilio-connect-card"><span class="twilio-eyebrow">SMS SETUP</span><h2>Connect a number for ${esc(businessName||'your business')}</h2><p>Choose an approved Twilio profile and number. We reuse its registration and your saved business details.</p><ol class="sms-activation-steps"><li><span>1</span>Choose sender</li><li><span>2</span>Test delivery</li><li><span>3</span>Enable SMS</li></ol><button class="btn" data-business>Choose approved sender</button></section><details class="card sms-activation-details"><summary>Need a new number or registration?</summary><p>New senders need Twilio registration before they can send. Only use this option if you do not already have an approved sender.</p><button class="btn ghost" data-register>${serviceAdded?'Open new sender registration':'Open business services'}</button></details></div>`;
 container.querySelector('[data-back]').onclick=onBack;container.querySelector('[data-business]').onclick=onBusiness;container.querySelector('[data-register]').onclick=serviceAdded?onRegister:onBusiness;
}
