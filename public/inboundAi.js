const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export async function mountInboundAi(root,{apiFetch,onKnowledge,onAvailability,isCurrent=()=>true}) {
 const response=await apiFetch('/api/inbound-ai');const initial=await response.json();
 if(!response.ok)throw new Error(initial.error||'Could not load inbound AI');
 if(!isCurrent())return;
 let settings=initial;
 root.innerHTML=`<section class="card setup-body"><h2>Inbound AI</h2><p>GPT 6.1 Sol answers inbound texts and can book using shared service availability.</p>
 <p>${initial.pilot?'Opek pilot.':'Pilot access is limited to Opek.'} Shadow mode records proposed replies without sending messages or creating bookings.</p>
 <form data-inbound-ai><label>Mode<select name="mode"><option value="off">Off</option><option value="shadow" ${!initial.pilot?'disabled':''}>Shadow</option><option value="live" ${!initial.pilot||!initial.liveValidated?'disabled':''}>Live</option></select></label>
 <label>Business instructions<textarea name="systemPrompt" rows="7" maxlength="6000">${esc(initial.systemPrompt)}</textarea></label>
 <label class="availability-toggle"><input type="checkbox" name="bookingEnabled" ${initial.bookingEnabled?'checked':''}> Allow new bookings after customer confirmation</label>
 <p>Cancellations and rescheduling go to staff. A manual reply pauses AI in that conversation.</p>
 <div class="compose-actions"><button class="btn" type="submit">Save settings</button><span data-result role="status" aria-live="polite"></span></div></form>
 <div class="compose-actions"><button type="button" class="btn ghost" data-knowledge>Approved knowledge</button><button type="button" class="btn ghost" data-availability>Service availability</button></div>
 </section><section class="card setup-body"><h2>Recent runs</h2>${initial.runs?.length?`<div class="table-scroll"><table><thead><tr><th>Time</th><th>Mode</th><th>Reply</th><th>Duration</th><th>Estimated cost</th></tr></thead><tbody>${initial.runs.map(r=>`<tr><td>${esc(new Date(r.created_at).toLocaleString())}</td><td>${esc(r.mode)}</td><td>${esc(r.result.reply||r.result.code||'')}</td><td>${esc(r.result.latencyMs??'—')} ms</td><td>${r.result.estimatedCostMicros==null?'—':'$'+(r.result.estimatedCostMicros/1e6).toFixed(4)}</td></tr>`).join('')}</tbody></table></div>`:'<p>No runs yet.</p>'}</section>`;
 const form=root.querySelector('form');form.elements.mode.value=initial.mode;
 root.querySelector('[data-knowledge]').onclick=onKnowledge;root.querySelector('[data-availability]').onclick=onAvailability;
 form.onsubmit=async event=>{
  event.preventDefault();if(!isCurrent())return;const button=form.querySelector('button'),result=form.querySelector('[data-result]');button.disabled=true;result.textContent='Saving…';
  try {
   const response=await apiFetch('/api/inbound-ai',{method:'PUT',body:JSON.stringify({revision:settings.revision,mode:form.elements.mode.value,systemPrompt:form.elements.systemPrompt.value,bookingEnabled:form.elements.bookingEnabled.checked})});
   const data=await response.json();if(!response.ok)throw new Error(data.error||'Save failed');settings=data;result.textContent='Saved';
  }catch(error){result.textContent=error.message;}finally{button.disabled=false;}
 };
}
