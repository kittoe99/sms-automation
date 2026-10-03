const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');

export function mountTwilioActivation(container,{provider,registration,apiFetch,onRefresh,onBack}) {
 const p=provider.connectionDetails||{},status=registration.state||'webhook_verified';
 const enabled=provider.sendingEnabled===true;
 container.innerHTML=`<div class="setup-page"><div class="setup-topbar"><button type="button" class="btn ghost" data-back>← Back to dashboard</button>
  <span class="setup-status ${enabled?'ok':''}">${enabled?'Sending enabled':'Sending disabled'}</span></div>
  <section class="card twilio-connect-card"><span class="twilio-eyebrow">CONNECTED TWILIO PROFILE</span><h2>${esc(p.profileName||p.legalBusinessName)}</h2>
   <p class="twilio-connected-number">${esc(provider.phoneNumber)}</p><p>This existing sender is connected to your business. Its credentials are stored privately.</p>
   <dl class="twilio-details"><div><dt>Sender type</dt><dd>${p.senderType==='toll_free'?'Verified toll-free':'A2P 10DLC'}</dd></div>
    <div><dt>Current registration</dt><dd>${esc(status.replaceAll('_',' '))}</dd></div>
    <div><dt>Twilio account</dt><dd>${esc(p.accountName)}<small>${esc(p.accountSid)}</small></dd></div>
    <div><dt>Messaging Service</dt><dd>${esc(p.serviceName)}<small>${esc(p.messagingServiceSid)}</small></dd></div>
    <div><dt>Business profile</dt><dd>${esc(p.profileSid||'Verified with toll-free registration')}</dd></div>
    <div><dt>Approval reference</dt><dd>${esc(p.registrationSid)}</dd></div></dl>
   <p>The registration and number already exist in Twilio. Activation needs a successful test delivery. Customer dashboard visibility is controlled in Businesses.</p>
  </section>
  <section class="card twilio-connect-card"><h3>${enabled?'SMS is active':'Finish SMS activation'}</h3>
   <p>Send a test to a phone you control, check that Twilio reports it delivered, then enable sending.</p>
   ${status==='webhook_verified'?'<label class="compose-label" for="twilio-canary">Test recipient</label><input id="twilio-canary" type="tel" placeholder="+15551234567" autocomplete="tel"><p class="profile-note">Sending the test requires a separate confirmation of the SMS charge.</p><button class="btn" type="button" data-canary>Send activation test</button>':''}
   ${status==='canary_pending'?'<p role="status">The activation test is awaiting delivery confirmation.</p>':''}
   ${status==='ready'&&!enabled?'<button class="btn" type="button" data-enable>Enable sending</button>':''}
   ${registration.rejection_reason?`<p class="login-error">${esc(registration.rejection_reason)}</p>`:''}
   <button class="btn ghost" type="button" data-refresh>Refresh Twilio status</button>
   <p data-feedback role="status"></p><p data-error class="login-error" role="alert"></p>
  </section></div>`;
 container.querySelector('[data-back]').addEventListener('click',onBack);
 const error=container.querySelector('[data-error]'),feedback=container.querySelector('[data-feedback]');
 async function perform(button,path,input,queued=false) {
  error.textContent='';feedback.textContent='';button.disabled=true;
  try {
   const response=await apiFetch(`/api/twilio/${path}`,{method:'POST',body:JSON.stringify(input)}),result=await response.json();
   if(!response.ok)throw new Error(result.error||'Twilio setup could not be updated.');
   if(queued){feedback.textContent='Status check queued. Refresh shortly to view the result.';button.disabled=false;return;}
   await onRefresh();
  }catch(e){error.textContent=e.message;button.disabled=false;}
 }
 container.querySelector('[data-canary]')?.addEventListener('click',event=>{
  const phone=container.querySelector('#twilio-canary').value.trim();
  if(!/^\+[1-9]\d{7,14}$/.test(phone)){error.textContent='Enter a test phone in international format, for example +13035550123.';return;}
  if(!confirm('Send one billable activation test SMS to this number?'))return;
  void perform(event.currentTarget,'canary',{phone,confirmed:true});
 });
 container.querySelector('[data-enable]')?.addEventListener('click',event=>void perform(event.currentTarget,'activate',{}));
 container.querySelector('[data-refresh]').addEventListener('click',async event=>{
  const button=event.currentTarget;button.disabled=true;error.textContent='';
  try {
  // Fetching a queued status result is independent of queuing another poll.
  const response=await apiFetch('/api/twilio/registration'),latest=await response.json();
  if(!response.ok){error.textContent=latest.error||'Could not load Twilio status.';return;}
  if(latest.state!==status||latest.updated_at!==registration.updated_at){await onRefresh();return;}
  await perform(button,'status-refresh',{},true);
  }catch(e){error.textContent=e.message;}
  finally{button.disabled=false;}
 });
}
