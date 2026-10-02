const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const fields=[
 ['businessName','Business name',160],['timeZone','Business time zone',100],
 ['contactEmail','Business email',254],['contactPhone','Business phone',32],['websiteUrl','Website',500],
 ['summary','Business description',2000,true],['services','Services · one per line',6000,true],
 ['locations','Service areas · one per line',4000,true],['hours','Hours',200],
 ['faqs','FAQs · one per line',6500,true],['pricing','Pricing · one per line',10000,true],
 ['policies','Policies · one per line',10000,true],['bookingRules','Booking rules',2000,true],
 ['handoff','When to hand off to a person',1000,true],
];
const lists=new Set(['services','locations','faqs','pricing','policies']);
export function profileFromForm(form,previous={}) {
 const profile={...previous};
 for(const [name] of fields){const value=String(form.get(name)||'').trim();profile[name]=lists.has(name)?value.split(/\r?\n/).map(x=>x.trim()).filter(Boolean):value;}
 profile.tone=String(form.get('tone')||'').trim();return profile;
}
export function mountBusinessSetup(container,row,{write,reload,onCreateWebsite,onWebsite,onWorkspace,lookup}) {
 const setup=row.setup||{revision:0,draft:{}},profile={...row.registration?.profile,...setup.draft};
 const services=row.services||[],reviewed=Boolean(setup.reviewed_profile_id);
 container.innerHTML=`<section class="card"><h3>${reviewed?'Reviewed business profile':'Awaiting admin setup'}</h3>
   <p>Review the customer’s information, add service details, then choose which services they can see.</p>
   ${row.registration?`<details><summary>Original customer registration</summary><pre>${esc(JSON.stringify(row.registration.profile,null,2))}</pre></details>`:''}
   <form class="compose" data-profile><p data-profile-error class="login-error" role="alert"></p>
   ${fields.map(([name,label,max,multi])=>`<label class="compose-label">${label}${multi?`<textarea name="${name}" maxlength="${max}" rows="3">${esc(Array.isArray(profile[name])?profile[name].join('\n'):profile[name])}</textarea>`:`<input name="${name}" value="${esc(profile[name])}" maxlength="${max}" ${['businessName','timeZone'].includes(name)?'required':''}/>`}</label>`).join('')}
   <label>Brand voice<select name="tone">${['','friendly','professional','casual'].map(value=>`<option value="${value}" ${profile.tone===value?'selected':''}>${value||'Choose a voice (optional)'}</option>`).join('')}</select></label>
   <div class="compose-actions"><button class="btn ghost" type="submit" name="intent" value="draft" formnovalidate>Save draft</button><button class="btn" type="submit" name="intent" value="review">Save reviewed profile</button></div>
   <p>${reviewed?'Reviewed '+esc(new Date(setup.reviewed_at).toLocaleString())+'. Draft edits take effect after review.':'Services can be added after the profile is reviewed.'}</p></form></section>
   <section class="card"><h3>Services</h3><p>Set live makes a service visible in the customer dashboard. Publishing a website and activating SMS are separate controls.</p>
   <p data-service-error class="login-error" role="alert"></p>
   ${services.map(s=>`<article class="card"><h4>${esc(s.kind==='website'?s.siteName||'Website':({sms:'SMS',enquiries:'Website enquiries',bookings:'Bookings'}[s.kind]))}</h4>
    <p>${s.visibility==='live'?'Live · visible to customer':'Draft · hidden from customer'}${s.kind==='sms'?` · Setup: ${esc(s.providerState||'pending')}${s.phoneNumber?' · '+esc(s.phoneNumber):''}`:''}</p>
    <button type="button" class="btn" data-release="${esc(s.id)}" ${!reviewed&&s.visibility!=='live'?'disabled':''}>${s.visibility==='live'?'Hide from customer':'Set live'}</button>
    ${s.kind==='website'?`<button type="button" class="btn ghost" data-site="${esc(s.site_id)}">Manage website</button>`:`<button type="button" class="btn ghost" data-configure="${s.kind}">Configure ${s.kind==='sms'?'SMS':s.kind}</button>`}</article>`).join('')||'<p>No services added.</p>'}
   <div class="compose-actions">${['sms','enquiries','bookings'].filter(kind=>!services.some(s=>s.kind===kind)).map(kind=>`<button type="button" class="btn ghost" data-add="${kind}" ${!reviewed?'disabled':''}>Add ${kind==='sms'?'SMS':kind}</button>`).join('')}
   <button type="button" class="btn ghost" data-new-site ${!reviewed?'disabled':''}>Create website</button>
   <button type="button" class="btn ghost" data-link-site ${!reviewed?'disabled':''}>Link existing website</button></div><div data-site-link></div></section>`;
 async function perform(button,error,action){if(button)button.disabled=true;error.textContent='';try{await action();await reload();}catch(e){error.textContent=e.message;if(button)button.disabled=false;}}
 container.querySelector('[data-profile]').addEventListener('submit',event=>{
  event.preventDefault();const form=event.currentTarget,button=event.submitter;
  const intent=button?.value==='draft'?'draft':'review';
  void perform(button,form.querySelector('[data-profile-error]'),()=>write(`business-profile/${intent}`,{
    tenantId:row.tenant_id,revision:setup.revision,profile:profileFromForm(new FormData(form),profile),
  }));
 });
 const error=container.querySelector('[data-service-error]');
 container.querySelectorAll('[data-add]').forEach(button=>button.addEventListener('click',()=>void perform(button,error,()=>write('services',{tenantId:row.tenant_id,kind:button.dataset.add}))));
 container.querySelectorAll('[data-release]').forEach(button=>button.addEventListener('click',()=>{
  const service=services.find(s=>s.id===button.dataset.release);
  void perform(button,error,()=>write('services/visibility',{tenantId:row.tenant_id,serviceId:service.id,revision:service.revision,visibility:service.visibility==='live'?'draft':'live'}));
 }));
 container.querySelectorAll('[data-site]').forEach(button=>button.addEventListener('click',()=>onWebsite(button.dataset.site)));
 container.querySelectorAll('[data-configure]').forEach(button=>button.addEventListener('click',()=>onWorkspace(row.tenant_id,button.dataset.configure)));
 container.querySelector('[data-new-site]').addEventListener('click',()=>onCreateWebsite(row.tenant_id));
 container.querySelector('[data-link-site]').addEventListener('click',async()=>{
  const target=container.querySelector('[data-site-link]');target.innerHTML='<form class="compose"><div data-lookup></div><button class="btn">Link website</button></form>';
  try {
   const select=await lookup(target.querySelector('[data-lookup]'),'websites','Website');
   target.querySelector('form').addEventListener('submit',event=>{event.preventDefault();void perform(event.submitter,error,async()=>{
    if(!select.value)throw new Error('Choose a website.');
    await write('services',{tenantId:row.tenant_id,kind:'website',siteId:select.value,siteRevision:Number(select.selectedOptions[0].dataset.revision)});
   });});
  }catch(e){error.textContent=e.message;}
 });
}
