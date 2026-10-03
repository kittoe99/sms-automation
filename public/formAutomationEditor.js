import { BUILTIN_PRESETS, emptySequence, newMessage, TIME_UNITS, validateSequence, sequenceSummary } from './formAutomation.js?v=20261003-forms';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const units=(name,value)=>`<select data-key="${name}">${TIME_UNITS.map(u=>`<option ${u===value?'selected':''}>${u}</option>`).join('')}</select>`;
export async function renderFormAutomation({root,form,apiFetch,canManage}) {
  const request=async(path,options)=>{const res=await apiFetch(path,options);const data=await res.json();if(!res.ok)throw new Error(data.error||'Could not load automation');return data;};
  let saved=await request(`/api/web-forms/${form.public_id}/automation`);
  let sequence=structuredClone(saved.draft?.steps?.length?saved.draft:emptySequence());
  const library=await request('/api/automation-presets');
  const presets=[...BUILTIN_PRESETS,...(library.presets||[])];
  let notice='';
  const tokens=['first_name','name','business_name','phone','email',...(form.preset==='bookings'?['appointment_at']:[]),...form.fields.map(f=>`field.${f.key}`)];
  const preview=()=>{
    const summary=root.querySelector('[data-summary]');if(summary)summary.textContent=sequence.steps.length?sequenceSummary(sequence):'Add a message or choose a preset to see the schedule.';
    root.querySelectorAll('[data-message]').forEach(card=>{
      const s=sequence.steps[Number(card.dataset.message)];
      card.querySelector('[data-preview]').textContent=s.body.replace(/\{\{([^{}]+)\}\}/g,(_,key)=>key==='business_name'?'[Your business]':key==='first_name'?'Alex':`[${key}]`);
      // Unicode messages use 70/67 UTF-16 units; GSM estimates include extended characters.
      const basic="@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
      let n=0,gsm=true;for(const c of s.body){if(basic.includes(c))n++;else if('^{}\\[~]|€'.includes(c))n+=2;else{gsm=false;break;}}
      if(!gsm)n=s.body.length;const one=gsm?160:70,many=gsm?153:67;
      card.querySelector('[data-length]').textContent=`${s.body.length} characters · about ${n<=one?1:Math.ceil(n/many)} SMS segment(s), before personalization`;
    });
  };
  const render=()=>{
    root.innerHTML=`<section class="card form-automation"><div class="card-head"><div><h2>Messages & timing</h2><p class="muted">${saved.enabled?'Active for new submissions':'Not enrolling new submissions'} · ${saved.publishedVersion?`Published version ${saved.publishedVersion}`:'Draft only'}</p></div></div>
      <div class="web-builder-body"><p>Each message finishes its repeats before the next message starts. Existing runs keep their published version.</p>
      <fieldset ${canManage?'':'disabled'}><legend class="form-visually-hidden">Automation configuration</legend>
      <label>Start with a preset<select data-preset><option value="">Choose a starting point</option>${presets.map((p,i)=>`<option value="${i}">${esc(p.name)}</option>`).join('')}</select></label>
      <div class="form-rule-grid"><label>Start sequence<select data-setting="trigger"><option value="submission" ${sequence.trigger==='submission'?'selected':''}>After submission</option>${form.preset==='bookings'?`<option value="appointment" ${sequence.trigger==='appointment'?'selected':''}>Before confirmed appointment</option>`:''}</select></label>
      ${sequence.trigger==='appointment'?`<label>Hours before appointment<input type="number" min="1" max="8760" data-setting="leadHours" value="${sequence.leadHours}" /></label>`:''}
      <label>When someone replies<select data-setting="replyPolicy"><option value="pause" ${sequence.replyPolicy==='pause'?'selected':''}>Pause for manual follow-up</option><option value="continue" ${sequence.replyPolicy==='continue'?'selected':''}>Continue scheduled messages</option></select></label>
      <label>Send from (business hour)<input type="number" min="0" max="23" data-setting="startHour" value="${sequence.startHour}" /></label><label>Until (exclusive)<input type="number" min="1" max="24" data-setting="endHour" value="${sequence.endHour}" /></label></div>
      <div class="form-messages">${sequence.steps.map((s,i)=>`<article class="form-message" data-message="${i}"><div class="form-message-heading"><h3>Message ${i+1}</h3><div><button type="button" class="btn ghost" data-step-action="up" ${i?'':'disabled'} aria-label="Move message ${i+1} up">↑</button><button type="button" class="btn ghost" data-step-action="down" ${i<sequence.steps.length-1?'':'disabled'} aria-label="Move message ${i+1} down">↓</button><button type="button" class="btn ghost" data-step-action="duplicate">Duplicate</button><button type="button" class="btn ghost" data-step-action="remove">Remove</button></div></div>
      <label>Use prewritten text<select data-copy><option value="">Choose message text</option>${BUILTIN_PRESETS.filter(p=>p.sequence.trigger!=='appointment'||sequence.trigger==='appointment').flatMap(p=>p.sequence.steps.map((step,i)=>`<option value="${esc(step.body)}">${esc(p.name)}${p.sequence.steps.length>1?` · Message ${i+1}`:''}</option>`)).join('')}</select></label><label>Message text<textarea rows="4" maxlength="1600" data-key="body" placeholder="Write the message your customer will receive…">${esc(s.body)}</textarea></label>
      <label>Insert a field<select data-token><option value="">Choose a field</option>${tokens.map(t=>`<option value="${esc(t)}">${esc(t.replace('field.','Form: '))}</option>`).join('')}</select></label>
      <small class="muted" data-length></small><div class="form-rule-grid">
      <label>Wait before this message<input type="number" min="0" max="365" data-key="delayCount" value="${s.delayCount}" />${units('delayUnit',s.delayUnit)}</label>
      <label>Send this message N times total<input type="number" min="1" max="1000" data-key="sendCount" value="${s.sendCount}" /><small>Includes the first send</small></label>
      <label>Time between repeats<input type="number" min="1" max="365" data-key="intervalCount" value="${s.intervalCount}" />${units('intervalUnit',s.intervalUnit)}</label></div>
      <div class="form-message-preview"><strong>Message preview</strong><p data-preview></p></div></article>`).join('')}</div>
      <button type="button" class="btn ghost" data-action="add">+ Add message</button></fieldset>
      <aside class="form-sequence-summary"><h3>Sequence summary</h3><p data-summary></p><p class="muted">Opt-outs always stop sending. Publishing does not enable Twilio sending.</p></aside>
      <p role="status" data-status>${esc(notice)}</p>${canManage?`<div class="form-editor-actions"><button class="btn ghost" data-action="draft">Save draft</button><button class="btn" data-action="publish">Publish version</button><button class="btn ghost" data-action="state">${saved.enabled?'Pause automation':'Enable published version'}</button></div><div class="form-preset-save"><label>Preset name<input data-preset-name maxlength="100" placeholder="Save these rules for another form" /></label><button class="btn ghost" data-action="preset-save">Save as preset</button></div>`:'<p class="muted">Staff manage this automation.</p>'}</div></section>`;
    preview();
  };
  root.oninput=e=>{
    const input=e.target;
    if(input.dataset.setting)sequence[input.dataset.setting]=input.type==='number'?Number(input.value):input.value;
    if(input.dataset.key){const s=sequence.steps[Number(input.closest('[data-message]').dataset.message)];s[input.dataset.key]=input.type==='number'?Number(input.value):input.value;}
    preview();
  };
  root.onchange=e=>{
    if(e.target.matches('[data-preset]')&&e.target.value!==''){
      const preset=presets[Number(e.target.value)];
      if(preset.sequence.trigger==='appointment'&&form.preset!=='bookings'){root.querySelector('[data-status]').textContent='This preset requires a booking form.';return;}
      sequence=structuredClone(preset.sequence);notice='Preset copied. Customize and publish when ready.';render();
    } else if(e.target.dataset.setting==='trigger')render();
    else if(e.target.matches('[data-copy]')&&e.target.value){const card=e.target.closest('[data-message]');sequence.steps[Number(card.dataset.message)].body=e.target.value;card.querySelector('textarea').value=e.target.value;e.target.value='';preview();}
    else if(e.target.matches('[data-token]')&&e.target.value){
      const card=e.target.closest('[data-message]'),text=card.querySelector('textarea');
      const token=`{{${e.target.value}}}`,start=text.selectionStart,end=text.selectionEnd;
      text.value=text.value.slice(0,start)+token+text.value.slice(end);sequence.steps[Number(card.dataset.message)].body=text.value;
      e.target.value='';text.focus();text.setSelectionRange(start+token.length,start+token.length);preview();
    }
  };
  root.onclick=async e=>{
    const button=e.target.closest('button');if(!button||!canManage)return;
    const action=button.dataset.action,stepAction=button.dataset.stepAction;
    if(stepAction){const i=Number(button.closest('[data-message]').dataset.message);
      if(stepAction==='remove')sequence.steps.splice(i,1);else if(stepAction==='duplicate')sequence.steps.splice(i+1,0,structuredClone(sequence.steps[i]));
      else {const j=i+(stepAction==='up'?-1:1);[sequence.steps[i],sequence.steps[j]]=[sequence.steps[j],sequence.steps[i]];}render();return;
    }
    if(action==='add'){sequence.steps.push(newMessage());render();root.querySelector('.form-message:last-child textarea')?.focus();return;}
    if(!action)return;button.disabled=true;
    try{
      const payload=action==='state'?{enabled:!saved.enabled}:{sequence:validateSequence(sequence,form.fields,{appointmentAllowed:form.preset==='bookings'}),revision:saved.revision,name:root.querySelector('[data-preset-name]')?.value};
      saved=await request(`/api/web-forms/${form.public_id}/automation/${action}`,{method:'PUT',body:JSON.stringify(payload)});
      notice=action==='publish'?'Published. Existing runs keep their previous version.':action==='state'?(saved.enabled?'Automation enabled for new submissions.':'Automation paused. Existing runs can be resumed individually.'):'Saved.';
      render();
    }catch(error){root.querySelector('[data-status]').textContent=error.message;button.disabled=false;}
  };
  render();
}
