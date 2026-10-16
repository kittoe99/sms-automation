const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// Existing facts are assembled without inventing, dropping or saving anything.
export function businessInfoText(profile={}) {
 if(typeof profile.businessInfo==='string')return profile.businessInfo;
 return [['Business',profile.businessName],['About',profile.summary],['Services',profile.services],['Service areas',profile.locations],['Hours',profile.hours],['FAQs',profile.faqs],['Pricing',profile.pricing],['Policies',profile.policies],['Booking',profile.bookingRules],['Staff help',profile.handoff],['Tone',profile.tone],['Phone',profile.contactPhone],['Email',profile.contactEmail],['Website',profile.websiteUrl]]
  .filter(([,v])=>Array.isArray(v)?v.length:String(v??'').trim()).map(([name,v])=>`${name}\n${Array.isArray(v)?v.map(x=>`- ${x}`).join('\n'):v}`).join('\n\n');
}
export function businessInfoEditorHtml(profile={}) {
 const field=(name,label,type='text',max=254)=>`<label class="profile-field"><span>${label}</span><input name="${name}" type="${type}" maxlength="${max}" value="${esc(profile[name])}" ${['businessName','timeZone'].includes(name)?'required':''}/></label>`;
 return `<input type="hidden" name="profileEditor" value="document"/>
 <label class="profile-field"><span>Business Info</span><textarea name="businessInfo" rows="20" maxlength="20000" placeholder="Write or paste everything customers should know about this business: services, areas, hours, FAQs, policies, or anything else useful.">${esc(businessInfoText(profile))}</textarea></label>
 <p>Pricing is optional. When a price is unavailable, AI directs customers to your saved phone number or website for an accurate quote.</p>
 <p data-profile-progress role="status"></p>
 <details class="profile-registration" ${!profile.businessName||!profile.timeZone?'open':''}><summary>Business identity and contact details</summary><p>Used for the account, local times, and quote enquiries. Keep these consistent with your document.</p><div class="profile-grid">${field('businessName','Business name','text',160)}${field('timeZone','Time zone','text',100)}${field('contactPhone','Quote phone','tel',32)}${field('contactEmail','Email','email')}${field('websiteUrl','Quote website','url',500)}</div></details>`;
}
export function bindBusinessInfo(form) {
 const field=form.elements.businessInfo,status=form.querySelector('[data-profile-progress]');
 const update=()=>{if(status)status.textContent=`${field.value.length.toLocaleString()} / 20,000 characters`;};update();
 form.addEventListener('input',()=>{form.dataset.dirty='true';update();});
 return {prepare(review){if(field.value.length>20000)throw new Error('Business Info must be no longer than 20,000 characters. Your existing information has not been shortened.');if(review&&!field.value.trim())throw new Error('Add your business information before saving.');}};
}
