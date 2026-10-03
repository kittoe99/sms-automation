const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');

export function mountTwilioConnection(container,business,{read,write,reload,onWorkspace}) {
 const reviewed=Boolean(business.setup?.reviewed_profile_id);
 const service=business.services?.find(s=>s.kind==='sms');
 container.innerHTML=`<section class="card twilio-connect-card"><div class="twilio-connect-heading"><div><span class="twilio-eyebrow">SMS CONNECTION</span><h3>Connect SMS</h3>
  <p>Connect an existing business profile and phone number from our Twilio account.</p></div><span class="twilio-status">${service?.phoneNumber?'Number connected':'Choose an existing sender'}</span></div>
  ${service?.phoneNumber?`<p class="twilio-connected-number">${esc(service.phoneNumber)}</p>`:''}
  <p>Each Twilio account is assigned to one CRM business. Connect the profile registered for <strong>${esc(business.name)}</strong>.</p>
  ${!reviewed?'<p class="profile-note">Save a reviewed business profile to connect Twilio.</p>':''}
  <button class="btn ghost" type="button" data-open-twilio ${!reviewed?'disabled':''}>${service?.phoneNumber?'Connection options':'Choose approved sender'}</button>
  ${service?.phoneNumber?'<button class="btn" type="button" data-activate-sms>Finish SMS activation</button>':''}<div data-twilio-editor></div></section>`;
 container.querySelector('[data-activate-sms]')?.addEventListener('click',()=>onWorkspace(business.tenant_id,'sms'));
 const open=container.querySelector('[data-open-twilio]'),editor=container.querySelector('[data-twilio-editor]');
 open.addEventListener('click',async()=>{
  open.disabled=true;editor.innerHTML='<p role="status">Loading connected Twilio accounts…</p>';
  try {
   const inventory=await read('twilio/accounts');
   editor.innerHTML=`<form class="compose twilio-connection-form"><label>Twilio account<select name="accountSid" required><option value="">Choose an account</option>
    ${inventory.accounts.map(a=>`<option value="${esc(a.sid)}" ${a.assignedBusiness&&a.assignedBusiness.tenantId!==business.tenant_id?'disabled':''}>${esc(a.name)}${a.isParent?' · Main account':''}${a.assignedBusiness?' · '+esc(a.assignedBusiness.businessName):''}</option>`).join('')}</select></label>
    ${!inventory.accounts.length?'<p>No active accounts were found. Check the platform Twilio connection.</p>':''}
    ${inventory.truncated?'<p role="status">The first 100 accounts are shown. More accounts need an administrator inventory review.</p>':''}
    <div data-twilio-profiles></div><p data-twilio-error class="login-error" role="alert"></p></form>`;
   const form=editor.querySelector('form'),select=form.elements.accountSid,target=form.querySelector('[data-twilio-profiles]'),error=form.querySelector('[data-twilio-error]');
   let options=[],connection=null,loading=0;
   const showProfiles=async()=>{
    const request=++loading;options=[];error.textContent='';
    if(!select.value){target.innerHTML='';return;}
    target.innerHTML='<p role="status">Checking approved profiles, registrations and phone numbers…</p>';
    try {
     const result=await read('twilio/profiles',{accountSid:select.value,tenantId:business.tenant_id});
     if(request!==loading)return;
     options=result.options;connection=result.connection;
     target.innerHTML=`<fieldset class="twilio-sender-list"><legend>Approved senders</legend>
      ${options.map((p,i)=>{const assignedElsewhere=p.assignedBusiness&&p.assignedBusiness.tenantId!==business.tenant_id;
       return `<label class="twilio-sender-option"><input type="radio" name="sender" value="${i}" required ${assignedElsewhere?'disabled':''}><span>
        <strong>${esc(p.profileName||p.legalBusinessName)}</strong><span class="twilio-sender-number">${esc(p.phoneNumber)}</span>
        <span class="twilio-status">${esc(p.approvalStatus)}</span><span>${esc(p.serviceName)}</span>
        ${assignedElsewhere?`<span>Assigned to ${esc(p.assignedBusiness.businessName)}</span>`:''}
        ${p.numberRegistrationNote?`<small>${esc(p.numberRegistrationNote)}</small>`:''}</span></label>`;
      }).join('')||'<p>No approved senders are available in this account.</p>'}</fieldset>
      ${result.unavailable.length?`<details class="twilio-unavailable"><summary>Other senders need attention (${result.unavailable.length})</summary>${result.unavailable.map(p=>`<p><strong>${esc(p.name)}${p.phoneNumber?' · '+esc(p.phoneNumber):''}</strong><br>${esc(p.reason)}</p>`).join('')}</details>`:''}
      ${result.truncated?'<p role="status">This account exceeds the inventory limit. Only the first 100 resources of each type are shown.</p>':''}
      <div data-twilio-review></div>`;
     form.querySelectorAll('[name="sender"]').forEach(radio=>radio.addEventListener('change',()=>{
      const p=options[Number(radio.value)],already=connection?.accountSid===p.accountSid&&connection?.phoneNumber===p.phoneNumber;
      target.querySelector('[data-twilio-review]').innerHTML=`<div class="twilio-review"><h4>${already?'Current connection':'Review connection'}</h4><dl class="twilio-details">
       <div><dt>CRM business</dt><dd>${esc(business.name)}</dd></div><div><dt>Twilio business profile</dt><dd>${esc(p.profileName||p.legalBusinessName)}</dd></div>
       <div><dt>Phone number</dt><dd>${esc(p.phoneNumber)}</dd></div></dl><details><summary>Technical connection details</summary><dl class="twilio-details"><div><dt>Twilio account</dt><dd>${esc(p.accountName)}<small>${esc(p.accountSid)}</small></dd></div>
       <div><dt>Messaging Service</dt><dd>${esc(p.serviceName)}<small>${esc(p.messagingServiceSid)}</small></dd></div>
       ${p.profileSid?`<div><dt>Profile reference</dt><dd>${esc(p.profileSid)}</dd></div>`:''}</dl></details>
       <p>Account credentials stay private. Connecting configures the CRM SMS webhooks and adds the SMS service. Customer visibility and SMS activation are separate.</p>
       ${already?'<p class="twilio-status">This number is already connected.</p>':`<label class="twilio-identity-confirm"><input type="checkbox" name="confirmedBusinessIdentity" required><span>I confirm this Twilio profile is registered for ${esc(business.name)}.</span></label>`}
       <button class="btn" type="${already?'button':'submit'}" ${already?'data-open-setup':''}>${already?'Open SMS setup':'Connect this profile and number'}</button></div>`;
      target.querySelector('[data-open-setup]')?.addEventListener('click',()=>onWorkspace(business.tenant_id,'sms'));
     }));
    }catch(e){if(request===loading){target.innerHTML='';error.textContent=e.message;}}
   };
   select.addEventListener('change',()=>void showProfiles());
   const preferred=inventory.accounts.find(a=>a.assignedBusiness?.tenantId===business.tenant_id)||inventory.accounts.find(a=>a.isParent&&!a.assignedBusiness);
   if(preferred){select.value=preferred.sid;await showProfiles();}
   form.addEventListener('submit',async event=>{
    event.preventDefault();error.textContent='';const p=options[Number(new FormData(form).get('sender'))];
    if(!p){error.textContent='Choose an approved sender.';return;}
    const controls=[...form.querySelectorAll('button,input,select')],disabled=controls.map(c=>c.disabled);controls.forEach(c=>c.disabled=true);
    try {
     await write('twilio/connect',{tenantId:business.tenant_id,revision:connection?.revision||0,accountSid:p.accountSid,
      messagingServiceSid:p.messagingServiceSid,phoneNumberSid:p.phoneNumberSid,registrationSid:p.registrationSid,confirmedBusinessIdentity:true});
     await reload();
    }catch(e){error.textContent=e.message;controls.forEach((c,i)=>c.disabled=disabled[i]);}
   });
  }catch(e){editor.innerHTML=`<p class="login-error" role="alert">${esc(e.message)}</p>`;}
  finally{open.disabled=false;}
 });
}
