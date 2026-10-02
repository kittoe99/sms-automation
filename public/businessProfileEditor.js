const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const listFields=['services','locations','faqs','pricing','policies'];
const textFields=['businessName','timeZone','contactEmail','contactPhone','websiteUrl','summary','hours','bookingRules','handoff'];
const limits={services:30,locations:20,faqs:20,pricing:200,policies:100};
const rowLimits={services:160,locations:160,faqs:300,pricing:1000,policies:1000};
const hints={services:'A service you offer',locations:'City, neighborhood, or ZIP code',pricing:'Describe a price or how you prepare a quote',policies:'Write your actual customer policy'};
const faqTopics=['Do you offer estimates?','Which areas do you serve?','What items do you accept?','How can I pay?','How do I reschedule?'];
const hoursPresets=['Mon–Fri 9 AM–5 PM; weekends closed.','Mon–Sat 9 AM–5 PM; Sunday closed.','By appointment only.','Open 24 hours, every day.'];
const guidance={
 bookingRules:[['Contact and job details','Collect the customer’s name, contact details, service address, and job description before arranging an appointment.'],['Confirm the quote first','Confirm the price with the customer before finalizing the booking.'],['Ask for photos','Ask for photos of the items or work area before preparing a quote.'],['Request a preferred time','Ask for the customer’s preferred date and time. Availability must be checked before confirming.']],
 handoff:[['Customer asks for a person','A customer explicitly asks to speak with a person.'],['Complaints or disputed charges','A customer makes a complaint or disputes a charge.'],['Refund requests','A customer requests a refund or a payment exception.'],['Outside approved information','The request cannot be answered using approved business information.']],
};
export function profileFromForm(form,previous={}) {
 const profile={...previous};
 for(const name of textFields) profile[name]=String(form.get(name)||'').trim();
 for(const name of listFields) profile[name]=form.has('profileEditor')
  ? name==='faqs'
   ? form.getAll('faqQuestion').map((value,i)=>{const q=String(value).trim(),a=String(form.getAll('faqAnswer')[i]||'').trim();return q&&a?`${q}${/[?？]$/.test(q)?' ':' — '}${a}`:q||a;}).filter(Boolean)
   : form.getAll(`${name}Entry`).map(value=>String(value).trim()).filter(Boolean)
  : String(form.get(name)||'').split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
 profile.tone=String(form.get('tone')||'').trim();return profile;
}
export function priceEntry({service,method,amount,details}) {
 service=String(service||'').trim();details=String(details||'').trim();
 if(!service) throw new Error('Enter the service this pricing applies to.');
 if(!['quote','fixed','from','hourly','custom'].includes(method)) throw new Error('Choose a pricing method.');
 if(method==='custom') {if(!details)throw new Error('Describe how this service is priced.');return `${service}: ${details}`;}
 if(method==='quote')return `${service}: quoted individually${details?`; ${details}`:'.'}`;
 if(String(amount??'').trim()==='' || !Number.isFinite(Number(amount)) || Number(amount)<0)throw new Error('Enter a valid price of zero or more.');
 const price=Number(amount).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
 return `${service}: ${method==='from'?'from ':''}$${price}${method==='hourly'?' per hour':''}${details?`; ${details}`:'.'}`;
}
export function profileSummaryHtml(profile,{pendingPrice='',pendingPriceError=''}={}) {
 const value=text=>String(text??'').trim()?`<p class="profile-summary-text">${esc(text)}</p>`:'<p class="profile-summary-empty">Not provided</p>';
 const list=name=>{const items=(Array.isArray(profile[name])?profile[name]:[]).filter(item=>String(item).trim());return items.length?`<ul>${items.map(item=>`<li>${esc(item)}</li>`).join('')}</ul>`:value('');};
 const card=(title,body,target,wide=false)=>`<article class="profile-summary-card${wide?' profile-wide':''}"><div class="profile-summary-head"><h4>${title}</h4><button type="button" class="profile-summary-edit" data-summary-edit="${target}" aria-label="Edit ${title.toLowerCase()}">Edit</button></div>${body}</article>`;
 const basics=[['Business name','businessName'],['Time zone','timeZone'],['Email','contactEmail'],['Phone','contactPhone'],['Website','websiteUrl']].map(([label,name])=>`<div><dt>${label}</dt><dd>${String(profile[name]??'').trim()?esc(profile[name]):'<span class="profile-summary-empty">Not provided</span>'}</dd></div>`).join('');
 const tone={friendly:'Friendly — warm, approachable, and helpful.',professional:'Professional — clear, polished, and respectful.',casual:'Casual — relaxed, simple, and conversational.'}[profile.tone]||'Use the voice in AI instructions.';
 const pending=pendingPrice?`<div class="profile-summary-pending"><strong>Pricing detail in progress</strong>${value(pendingPrice)}<small>This completed detail will be included when you save.</small></div>`:pendingPriceError?`<div class="profile-summary-pending"><strong>Incomplete pricing detail</strong>${value(pendingPriceError)}<small>Complete or clear the pricing builder before saving.</small></div>`:'';
 return `<div class="profile-summary-grid">
 ${card('Business details',`<dl>${basics}</dl>`,'businessName')}
 ${card('Business description',value(profile.summary),'summary')}
 ${card('Services',list('services'),'services')}
 ${card('Service areas',list('locations'),'locations')}
 ${card('Opening hours',value(profile.hours),'hours')}
 ${card('Brand voice',value(tone),'tone')}
 ${card('Frequently asked questions',list('faqs'),'faqs',true)}
 ${card('Pricing',(pendingPrice&&!profile.pricing?.length?'':list('pricing'))+pending,'pricing',true)}
 ${card('Customer policies',list('policies'),'policies',true)}
 ${card('Booking rules',value(profile.bookingRules),'bookingRules')}
 ${card('When a person should step in',value(profile.handoff),'handoff')}
 </div>`;
}
function field(profile,name,label,hint,{max=200,type='text',multi=false,required=false}={}) {
 return `<label class="profile-field"><span>${label}${required?' <small>Required</small>':''}</span>${multi?`<textarea name="${name}" maxlength="${max}" rows="3" placeholder="${esc(hint)}">${esc(profile[name])}</textarea>`:`<input name="${name}" type="${type}" maxlength="${max}" value="${esc(profile[name])}" placeholder="${esc(hint)}" ${required?'required':''}/>`}<small>${hint}</small></label>`;
}
function section(number,title,description,body) {
 return `<fieldset class="profile-section"><legend><span class="profile-step">${number}</span>${title}</legend><p class="profile-section-hint">${description}</p>${body}</fieldset>`;
}
function entryRow(name,value='',placeholder=hints[name]) {
 return `<div class="profile-entry" data-entry="${name}"><label><span class="sr-only">${name==='locations'?'Service area':name==='services'?'Service':name==='pricing'?'Pricing detail':'Policy'}</span>${['services','locations'].includes(name)?`<input name="${name}Entry" maxlength="${rowLimits[name]}" value="${esc(value)}" placeholder="${esc(placeholder)}"/>`:`<textarea name="${name}Entry" maxlength="${Math.max(rowLimits[name],String(value).length)}" rows="2" placeholder="${esc(placeholder)}">${esc(value)}</textarea>`}</label><button type="button" class="profile-remove" data-remove aria-label="Remove ${name==='locations'?'service area':name==='services'?'service':name==='pricing'?'pricing detail':'policy'}">×</button></div>`;
}
function faqRow(value='',question='') {
 // Split only the exact format we write; retain other saved formats verbatim.
 const pair=!question&&(String(value).match(/^(.+?[?？]) (.+)$/s)||String(value).match(/^(.+?) — (.+)$/s));
 if(pair){question=pair[1];value=pair[2];}
 else if(!question&&/[?？]$/.test(value)){question=value;value='';}
 return `<div class="profile-faq" data-entry="faqs"><div class="profile-grid"><label class="profile-field"><span>Question</span><input name="faqQuestion" maxlength="300" value="${esc(question)}" placeholder="What do customers ask?"/></label><label class="profile-field"><span>Answer</span><textarea name="faqAnswer" maxlength="300" rows="2" placeholder="Your business’s actual answer">${esc(value)}</textarea></label></div><button type="button" class="profile-remove" data-remove aria-label="Remove FAQ">×</button></div>`;
}
function rows(profile,name) {return (profile[name]?.length?profile[name]:['']).map(value=>name==='faqs'?faqRow(value):entryRow(name,value)).join('');}
function list(profile,name,label,hint) {
 return `<div class="profile-list"><h4>${label}</h4><p class="profile-section-hint">${hint}</p><div data-entries="${name}">${rows(profile,name)}</div><button type="button" class="btn ghost" data-add-entry="${name}">+ Add ${name==='locations'?'service area':'service'}</button></div>`;
}
function guidanceField(profile,name,label,hint,max) {
 return `<div class="profile-guidance">${field(profile,name,label,hint,{multi:true,max})}<div class="profile-preset-row"><label class="profile-field"><span>Add a suggested rule</span><select data-guidance="${name}"><option value="">Choose a suggestion…</option>${guidance[name].map(([label],i)=>`<option value="${i}">${label}</option>`).join('')}</select></label><button type="button" class="btn ghost" data-apply-guidance="${name}">Add rule</button></div></div>`;
}
export function profileEditorHtml(profile) {
 profile={...profile};for(const name of listFields)if(!Array.isArray(profile[name]))profile[name]=String(profile[name]||'').split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
 const zones=[...new Set(['UTC',...(profile.timeZone?[profile.timeZone]:[]),...Intl.supportedValuesOf('timeZone')])];
 return `<input type="hidden" name="profileEditor" value="guided"/>
 <div class="profile-intro"><span class="eyebrow">Business setup</span><h3>Give your business a clear foundation.</h3><p>Add the facts customers need. Choose a suggestion to get started, then make it your own.</p><span class="profile-status" data-profile-progress></span></div>
 ${section('01','Business details','Start with your identity and the best ways for customers to reach you.',`<div class="profile-grid">
 ${field(profile,'businessName','Business name','Your real business or trading name.',{max:160,required:true})}
 <label class="profile-field"><span>Business time zone <small>Required</small></span><select name="timeZone" required><option value="">Choose a time zone…</option>${zones.map(zone=>`<option value="${esc(zone)}" ${profile.timeZone===zone?'selected':''}>${esc(zone.replaceAll('_',' ').replaceAll('/',' / '))}</option>`).join('')}</select><small>Used to interpret local appointment times.</small></label>
 ${field(profile,'contactEmail','Business email','An email customers can use to contact you.',{max:254,type:'email'})}
 ${field(profile,'contactPhone','Business phone','Include the country code, for example +1.',{max:32,type:'tel'})}
 <div class="profile-wide">${field(profile,'websiteUrl','Website','Your public website, starting with https://.',{max:500,type:'url'})}</div>
 <div class="profile-wide">${field(profile,'summary','What does your business do?','Describe what you offer and who you help in two or three sentences.',{max:2000,multi:true})}</div></div>`)}
 ${section('02','Services & availability','Tell customers what you offer, where you work, and when you are open.',`<div class="profile-grid">${list(profile,'services','Services','Add each service separately. At least one is needed for review.')}${list(profile,'locations','Service areas','Add each city, neighborhood, or ZIP code separately. At least one is needed for review.')}</div>
 <div class="profile-hours">${field(profile,'hours','Opening hours','Include closed days or appointment-only hours. Use your business time zone.')}
 <div class="profile-preset-row"><label class="profile-field"><span>Start with an hours preset</span><select data-hours-preset><option value="">Choose a schedule…</option>${hoursPresets.map((value,i)=>`<option value="${i}">${esc(value)}</option>`).join('')}</select></label><button type="button" class="btn ghost" data-apply-hours>Use schedule</button></div><small>Written hours describe your business. Set bookable times in Booking configuration.</small></div>`)}
 ${section('03','Customer questions & pricing','Give clear answers and real prices. These details are optional; add only what you know.',`<div class="profile-list"><h4>Frequently asked questions</h4><p class="profile-section-hint">One question and answer per card. Up to 20, with 300 characters combined per card.</p><div data-entries="faqs">${rows(profile,'faqs')}</div><div class="profile-preset-row"><label class="profile-field"><span>Common question</span><select data-faq-topic><option value="">Choose a topic…</option>${faqTopics.map((q,i)=>`<option value="${i}">${esc(q)}</option>`).join('')}</select></label><button type="button" class="btn ghost" data-add-entry="faqs">+ Add FAQ</button></div></div>
 <div class="profile-list"><h4>Pricing</h4><p class="profile-section-hint">Add a price, a starting rate, or an explanation of how you quote.</p><div data-entries="pricing">${(profile.pricing||[]).map(value=>entryRow('pricing',value)).join('')}</div>
 <div class="profile-price-builder"><div class="profile-grid"><label class="profile-field"><span>Service</span><input data-price-service maxlength="160" placeholder="Which service is this for?"/></label><label class="profile-field"><span>Pricing method</span><select data-price-method><option value="quote">Custom quote</option><option value="fixed">Fixed price</option><option value="from">Starting price</option><option value="hourly">Hourly rate</option><option value="custom">Other / explain pricing</option></select></label><label class="profile-field" data-price-amount-wrap hidden><span>Price (USD)</span><input data-price-amount type="number" min="0" step="0.01" placeholder="0.00"/></label><label class="profile-field"><span>Details <small data-price-details-label>Optional</small></span><input data-price-details maxlength="700" placeholder="What affects the price? What is included?"/></label></div><p data-price-error class="login-error" role="alert"></p><button type="button" class="btn ghost" data-add-price>+ Add pricing detail</button></div></div>`)}
 ${section('04','Policies & booking guidance','Help customers know what to expect before they commit.',`<div class="profile-list"><h4>Customer policies</h4><p class="profile-section-hint">Choose a topic, then enter your actual policy. No policy is assumed.</p><div data-entries="policies">${(profile.policies||[]).map(value=>entryRow('policies',value)).join('')}</div><div class="profile-preset-row"><label class="profile-field"><span>Policy topic</span><select data-policy-topic><option value="">Custom policy</option><option>Cancellation & rescheduling</option><option>Payment methods</option><option>Refunds</option><option>Items or jobs you cannot accept</option></select></label><button type="button" class="btn ghost" data-add-entry="policies">+ Add policy</button></div></div>
 ${guidanceField(profile,'bookingRules','Booking rules','Describe the information and notice needed before arranging an appointment.',2000)}
 <p class="profile-note">These are written instructions. Configure availability, required booking fields, and booking limits separately in Booking configuration.</p>
 ${guidanceField(profile,'handoff','When should a person step in?','Describe situations that need staff attention. This field does not configure notifications or routing.',1000)}`)}
 ${section('05','Brand voice','Choose how your business should sound in written replies.',`<div class="profile-voices">${[['','Use AI instructions','Keep the voice specified in your AI instructions.'],['friendly','Friendly','Warm, approachable, and helpful.'],['professional','Professional','Clear, polished, and respectful.'],['casual','Casual','Relaxed, simple, and conversational.']].map(([value,label,hint])=>`<label class="profile-voice"><input type="radio" name="tone" value="${value}" ${String(profile.tone||'')===value?'checked':''}/><span><strong>${label}</strong><small>${hint}</small></span></label>`).join('')}</div>`)}
 <section class="profile-summary-section" aria-label="Detailed business profile summary"><h3><span class="profile-step">06</span>Review your business profile</h3><p class="profile-section-hint">A detailed summary of your current entries. Check the information below before saving. Use Edit to return to a field.</p><div data-profile-summary>${profileSummaryHtml(profile)}</div></section>
 <p class="profile-note">This profile supports general business conversations. Each automation group uses its own AI instructions and business details.</p><p data-editor-notice role="status" class="profile-editor-notice"></p>`;
}
export function bindProfileEditor(form) {
 const notice=form.querySelector('[data-editor-notice]');
 const announce=message=>{notice.textContent=message;};
 const entries=name=>form.querySelector(`[data-entries="${name}"]`);
 const changed=()=>{form.dataset.dirty='true';form.dispatchEvent(new Event('input',{bubbles:true}));};
 function add(name,html) {
  if(entries(name).children.length>=limits[name]) {announce(`You can add up to ${limits[name]} ${name==='locations'?'service areas':name}.`);return false;}
  entries(name).insertAdjacentHTML('beforeend',html);entries(name).lastElementChild.querySelector('input,textarea').focus();changed();return true;
 }
 form.addEventListener('click',event=>{
  const edit=event.target.closest('[data-summary-edit]');if(edit){const name=edit.dataset.summaryEdit;const target=listFields.includes(name)?entries(name).querySelector('input,textarea')||form.querySelector(name==='pricing'?'[data-price-service]':`[data-add-entry="${name}"]`):form.querySelector(name==='tone'?'[name="tone"]:checked':`[name="${name}"]`);if(target){target.scrollIntoView({behavior:'auto',block:'center'});target.focus({preventScroll:true});}return;}
  const remove=event.target.closest('[data-remove]');if(remove){const row=remove.closest('[data-entry]');const list=row.parentElement;row.remove();(list.lastElementChild?.querySelector('input,textarea')||list.parentElement.querySelector('[data-add-entry]')||list.parentElement.querySelector('[data-add-price]'))?.focus();changed();announce('Entry removed. Save to keep this change.');}
  const button=event.target.closest('[data-add-entry]');if(!button)return;
  const name=button.dataset.addEntry;
  if(name==='faqs') {
   const select=form.querySelector('[data-faq-topic]'),question=select.value===''?'':faqTopics[Number(select.value)];
   const blank=[...entries(name).children].find(row=>![...row.querySelectorAll('input,textarea')].some(input=>input.value.trim()));
   if(blank){blank.querySelector('[name="faqQuestion"]').value=question;blank.querySelector(question?'textarea':'input').focus();changed();}else if(!add(name,faqRow('',question)))return;
   select.value='';
  }else if(name==='policies') {
   const topic=form.querySelector('[data-policy-topic]').value;add(name,entryRow(name,'',topic?`Describe your ${topic.toLowerCase()} policy` : hints.policies));
  }else add(name,entryRow(name));
 });
 form.querySelector('[data-apply-hours]').addEventListener('click',()=>{
  const select=form.querySelector('[data-hours-preset]');if(select.value===''){announce('Choose an hours preset first.');select.focus();return;}
  const input=form.elements.hours;
  input.value=hoursPresets[Number(select.value)];input.focus();changed();announce('Hours preset added. Adjust it to match your business.');
 });
 for(const name of Object.keys(guidance))form.querySelector(`[data-apply-guidance="${name}"]`).addEventListener('click',()=>{
  const select=form.querySelector(`[data-guidance="${name}"]`);if(select.value===''){announce('Choose a suggested rule first.');select.focus();return;}
  const input=form.elements[name],text=guidance[name][Number(select.value)][1];
  if(input.value.includes(text)){announce('That rule is already included.');return;}
  const value=[input.value.trim(),text].filter(Boolean).join('\n');if(value.length>input.maxLength){announce('This rule would exceed the field limit. Shorten the existing text first.');return;}
  input.value=value;select.value='';input.focus();changed();announce('Suggested rule added. Review it before saving.');
 });
 const method=form.querySelector('[data-price-method]');
 const updatePriceMethod=()=>{const needsAmount=!['quote','custom'].includes(method.value);form.querySelector('[data-price-amount-wrap]').hidden=!needsAmount;form.querySelector('[data-price-amount]').disabled=!needsAmount;if(!needsAmount)form.querySelector('[data-price-amount]').value='';form.querySelector('[data-price-details-label]').textContent=method.value==='custom'?'Required':'Optional';};
 method.addEventListener('change',updatePriceMethod);updatePriceMethod();
 const priceInputs=['service','amount','details'].map(name=>form.querySelector(`[data-price-${name}]`));
 function addPrice() {
  const error=form.querySelector('[data-price-error]');error.textContent='';
  try{const value=priceEntry({service:priceInputs[0].value,method:method.value,amount:priceInputs[1].value,details:priceInputs[2].value});if(!add('pricing',entryRow('pricing',value)))return false;priceInputs.forEach(input=>input.value='');changed();announce('Pricing detail added.');return true;}catch(e){error.textContent=e.message;return false;}
 }
 form.querySelector('[data-add-price]').addEventListener('click',addPrice);
 const progress=()=>{
  const profile=profileFromForm(new FormData(form));const count=[Boolean(profile.businessName&&profile.timeZone),Boolean(profile.services.length&&profile.locations.length),Boolean(profile.faqs.length||profile.pricing.length),Boolean(profile.policies.length||profile.bookingRules||profile.handoff),Boolean(profile.tone)].filter(Boolean).length;form.querySelector('[data-profile-progress]').textContent=`${count} of 5 sections have details · optional sections can be left blank`;
  let pendingPrice='',pendingPriceError='';if(priceInputs.some(input=>input.value.trim()))try{pendingPrice=priceEntry({service:priceInputs[0].value,method:method.value,amount:priceInputs[1].value,details:priceInputs[2].value});}catch(error){pendingPriceError=error.message;}
  form.querySelector('[data-profile-summary]').innerHTML=profileSummaryHtml(profile,{pendingPrice,pendingPriceError});
 };
 form.addEventListener('input',progress);form.addEventListener('change',progress);progress();
 return {prepare(review){
  // Include a completed pending pricing detail; never silently discard a half-filled builder.
  if(priceInputs.some(input=>input.value.trim())&&!addPrice())throw new Error('Complete the pricing detail, or clear its fields before saving.');
  if(!review)return;
  const profile=profileFromForm(new FormData(form));
  if(!profile.services.length||!profile.locations.length)throw new Error('Add at least one service and one service area before reviewing.');
  if(profile.summary&&profile.summary.length<20)throw new Error('Use at least 20 characters for the business description, or leave it blank.');
  for(const row of entries('faqs').children)if(row.querySelector('input').value.trim()&&!row.querySelector('textarea').value.trim()){row.querySelector('textarea').focus();throw new Error('Add an answer to each FAQ question before reviewing.');}
  if(profile.faqs.some(value=>value.length>300))throw new Error('Keep each FAQ question and answer within 300 characters combined.');
  for(const [name,max] of Object.entries(limits))if(profile[name].length>max)throw new Error(`Too many ${name}; the limit is ${max}.`);
 }};
}
