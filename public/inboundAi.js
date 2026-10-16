const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

const reasonLabel=value=>({AI_BOOKED:'Booked',AI_DECLINED:'Enquiry declined',AI_STAFF_HANDOFF:'Passed to staff',CONVERSATION:'Conversation in progress',NEEDS_CLARIFICATION:'Clarification needed',PREPARING_BOOKING:'Preparing booking',CUSTOMER_REPLIED:'Customer replied'}[value]||value||'—');
export async function mountInboundAi(root,{apiFetch,onKnowledge,onAvailability,isCurrent=()=>true}) {

 const response=await apiFetch('/api/inbound-ai');const initial=await response.json();

 if(!response.ok)throw new Error(initial.error||'Could not load inbound AI');

 if(!isCurrent())return;

 let settings=initial;

 root.innerHTML=`<section class="card setup-body"><h2>AI replies for all SMS</h2><p>Use one set of business instructions for incoming texts and replies to form or contact messages. AI reads the customer’s recent SMS history across those sources.</p>

 <form data-inbound-ai><label class="availability-toggle"><input type="checkbox" name="enabled" ${initial.mode==='live'?'checked':''}> AI replies on</label>
 <p class="muted">When on, AI responds to new eligible incoming messages using Business Info. Turning it on does not reply to old messages. If a price is missing, it directs customers to your business phone or website.</p>
 <details><summary>Reply style (optional)</summary><label>Style instructions<textarea name="systemPrompt" rows="4" maxlength="6000">${esc(initial.systemPrompt)}</textarea></label></details>

 <label class="availability-toggle"><input type="checkbox" name="bookingEnabled" ${initial.bookingEnabled?'checked':''}> Allow new bookings after customer confirmation</label>

 <p>Cancellations and rescheduling go to staff. A manual reply pauses AI in that conversation.</p>

 <div class="compose-actions"><button class="btn" type="submit">Save settings</button><span data-result role="status" aria-live="polite"></span></div></form>

 <div class="compose-actions"><button type="button" class="btn ghost" data-knowledge>Business Info</button><button type="button" class="btn ghost" data-availability>Booking availability</button></div>

 </section><section class="card setup-body"><h2>Automations and replies</h2><p>${initial.coordinationEnabled?"Enabled":"Off"}${initial.mode==="shadow"?" · legacy preview mode; turn on AI replies to respond":""}. Form and contact follow-ups set to Continue wait 30 minutes after a customer reply or an accepted AI reply, including while AI replies are off. Paused follow-ups need a manual resume; booking reminders keep their own rules.</p>${initial.coordination?.length?`<div class="table-scroll"><table class="data"><thead><tr><th>Enquiry</th><th>Status</th><th>Association</th><th>Reason</th><th>${initial.mode==='shadow'?'Proposed quiet until':'Quiet until'}</th></tr></thead><tbody>${initial.coordination.map(c=>`<tr><td>${esc(c.title)}</td><td>${esc(c.status)}</td><td>${c.associated?'Linked to AI conversation':'Not linked'}</td><td>${esc(reasonLabel(c.reason))}</td><td>${c.quietUntil?esc(new Date(c.quietUntil).toLocaleString()):'—'}</td></tr>`).join('')}</tbody></table></div>`:'<p>No active enquiry sequences.</p>'}</section><section class="card setup-body"><h2>Recent AI replies</h2>${initial.runs?.length?`<div class="table-scroll"><table class="data"><thead><tr><th>Time</th><th>Mode</th><th>Reply</th><th>Enquiry outcome</th><th>Duration</th><th>Estimated cost</th></tr></thead><tbody>${initial.runs.map(r=>`<tr><td>${esc(new Date(r.created_at).toLocaleString())}</td><td>${esc(r.mode==='shadow'?'Review only — not sent':r.mode==='live'?'Automatic replies':r.mode)}</td><td>${esc(r.result.reply||r.result.code||'')}</td><td>${esc(r.result.coordination?.title||'—')}<br>${esc(reasonLabel(r.result.coordination?.reason))}${r.result.coordination?.simulated?' (proposed)':''}</td><td>${esc(r.result.latencyMs??'—')} ms</td><td>${r.result.estimatedCostMicros==null?'—':'$'+(r.result.estimatedCostMicros/1e6).toFixed(4)}</td></tr>`).join('')}</tbody></table></div>`:'<p>No runs yet.</p>'}</section>`;

 const form=root.querySelector('form');

 root.querySelector('[data-knowledge]').onclick=onKnowledge;root.querySelector('[data-availability]').onclick=onAvailability;

 form.onsubmit=async event=>{

  event.preventDefault();if(!isCurrent())return;const button=form.querySelector('button'),result=form.querySelector('[data-result]');button.disabled=true;result.textContent='Saving…';

  try {

   const response=await apiFetch('/api/inbound-ai',{method:'PUT',body:JSON.stringify({revision:settings.revision,mode:form.elements.enabled.checked?'live':'off',systemPrompt:form.elements.systemPrompt.value,bookingEnabled:form.elements.bookingEnabled.checked})});

   const data=await response.json();if(!response.ok)throw new Error(data.error||'Save failed');settings=data;result.textContent='Saved';

  }catch(error){result.textContent=error.message;}finally{button.disabled=false;}

 };

}

