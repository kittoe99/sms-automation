import {businessInfoEditorHtml,bindBusinessInfo} from './businessInfo.js';
import {normalizePhoneInput,installPhoneFormatting} from './phoneInput.js?v=20261003-phone';
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
 if(form.get('profileEditor')==='document'){
  for(const name of ['businessName','timeZone','contactEmail','contactPhone','websiteUrl','businessInfo'])profile[name]=String(form.get(name)||'').trim();
  profile.contactPhone=normalizePhoneInput(profile.contactPhone);return profile;
 }
 for(const name of textFields) profile[name]=String(form.get(name)||'').trim();
 for(const name of listFields) profile[name]=form.has('profileEditor')
  ? name==='faqs'
   ? form.getAll('faqQuestion').map((value,i)=>{const q=String(value).trim(),a=String(form.getAll('faqAnswer')[i]||'').trim();return q&&a?`${q}${/[?？]$/.test(q)?' ':' — '}${a}`:q||a;}).filter(Boolean)
   : form.getAll(`${name}Entry`).map(value=>String(value).trim()).filter(Boolean)
  : String(form.get(name)||'').split(/\r?\n/).map(value=>value.trim()).filter(Boolean);
 profile.contactPhone=normalizePhoneInput(profile.contactPhone);
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
export function profileEditorHtml(profile) {return businessInfoEditorHtml(profile);}
export function bindProfileEditor(form) {
 installPhoneFormatting(form);return bindBusinessInfo(form);
}
