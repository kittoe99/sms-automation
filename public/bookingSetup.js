const days=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function validateSchedule(weekly,exceptions){
 const check=(windows,label)=>{
  if(!Array.isArray(windows)||windows.length>8)throw new Error(`${label}: use at most eight windows.`);
  let end='';
  for(const w of [...windows].sort((a,b)=>a.start.localeCompare(b.start))){
   if(!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.start)||!/^([01]\d|2[0-3]):[0-5]\d$/.test(w.end)||w.start>=w.end)throw new Error(`${label}: start must precede end on the same day.`);
   if(w.start<end)throw new Error(`${label}: windows overlap.`);end=w.end;
  }
 };
 for(const [day,windows] of Object.entries(weekly)){if(!/^[0-6]$/.test(day))throw new Error('Invalid day.');check(windows,days[day]);}
 const seen=new Set();
 for(const x of exceptions){
  if(!/^\d{4}-\d{2}-\d{2}$/.test(x.date)||Number.isNaN(Date.parse(x.date))||new Date(x.date).toISOString().slice(0,10)!==x.date)throw new Error('Date exceptions: choose a valid calendar date.');
  if(seen.has(x.date))throw new Error('Date exceptions: duplicate date.');seen.add(x.date);check(x.windows,x.date);
 }
}
export function mountScheduleEditor(root,draft,onChange=()=>{}){
 draft.weeklyAvailability??=Object.fromEntries(days.map((_,i)=>[i,[]]));draft.dateExceptions??=[];
 const windowHtml=(windows,key)=>windows.map((w,i)=>`<div class="availability-window"><label>From<input type="time" aria-label="${esc(key)} window ${i+1} start" data-start="${i}" value="${esc(w.start)}"></label><label>Until<input type="time" aria-label="${esc(key)} window ${i+1} end" data-end="${i}" value="${esc(w.end)}"></label><button type="button" class="btn ghost" data-remove-window="${i}">Remove window</button></div>`).join('');
 const draw=()=>{
  root.innerHTML=`<h3>Weekly hours</h3>${days.map((day,i)=>`<fieldset data-day="${i}" class="availability-day"><legend>${day}</legend>${draft.weeklyAvailability[i]?.length?windowHtml(draft.weeklyAvailability[i],day):'<p class="muted">Closed</p>'}<button type="button" class="btn ghost" data-add-window ${draft.weeklyAvailability[i]?.length>=8?'disabled':''}>Add hours</button></fieldset>`).join('')}<h3>Date exceptions</h3><p class="muted">These hours replace the weekly hours for the selected date.</p>${draft.dateExceptions.map((x,i)=>`<fieldset data-exception="${i}" class="availability-day"><legend>Exception ${i+1}</legend><div class="availability-window"><label>Date<input type="date" data-date value="${esc(x.date)}"></label><label class="availability-toggle"><input type="checkbox" data-closed ${x.closed?'checked':''}> Closed all day</label><button type="button" class="btn ghost" data-remove-date>Remove date</button></div>${x.closed?'':windowHtml(x.windows,`Exception ${i+1}`)+`<button type="button" class="btn ghost" data-add-window ${x.windows.length>=8?'disabled':''}>Add hours</button>`}</fieldset>`).join('')}<button type="button" class="btn ghost" data-add-date ${draft.dateExceptions.length>=366?'disabled':''}>Add date exception</button>`;
  root.querySelectorAll('[data-day],[data-exception]').forEach(section=>{
   const exception=section.hasAttribute('data-exception')?draft.dateExceptions[section.dataset.exception]:null;
   const windows=exception?exception.windows:(draft.weeklyAvailability[section.dataset.day]??=[]);
   section.querySelectorAll('[data-start],[data-end]').forEach(input=>input.oninput=()=>{windows[Number(input.dataset.start??input.dataset.end)][input.hasAttribute('data-start')?'start':'end']=input.value;onChange();});
   section.querySelectorAll('[data-remove-window]').forEach(button=>button.onclick=()=>{windows.splice(Number(button.dataset.removeWindow),1);onChange();draw();});
   section.querySelector('[data-add-window]')?.addEventListener('click',()=>{if(windows.length<8)windows.push({start:'09:00',end:'17:00'});onChange();draw();});
   if(exception){
    section.querySelector('[data-date]').oninput=e=>{exception.date=e.target.value;onChange();};
    section.querySelector('[data-closed]').onchange=e=>{exception.closed=e.target.checked;onChange();draw();};
    section.querySelector('[data-remove-date]').onclick=()=>{draft.dateExceptions.splice(Number(section.dataset.exception),1);onChange();draw();};
   }
  });
  root.querySelector('[data-add-date]').onclick=()=>{draft.dateExceptions.push({date:'',closed:true,windows:[]});onChange();draw();};
 };
 draw();return {validate:()=>validateSchedule(draft.weeklyAvailability,draft.dateExceptions)};
}
const numberField=(key,label,min,max,value)=>`<label>${label}<input name="${key}" type="number" step="1" min="${min}" max="${max}" required value="${esc(value)}"></label>`;
const inputField=(key,label,value,extra='')=>`<label>${label}<input name="${key}" value="${esc(value)}" ${extra}></label>`;
async function request(apiFetch,path,body){const res=await apiFetch(path,{method:'POST',body:JSON.stringify(body)});const value=await res.json();if(!res.ok)throw new Error(value.error||'Availability could not be loaded.');return value;}
function mountPreview(root,{apiFetch,channel,draft,validate}){
 let revision=0;
 root.innerHTML='<h3>Slot preview</h3><label>Preview date<input type="date" data-preview-date></label><button type="button" class="btn ghost" data-preview>Preview availability</button><div data-preview-result role="status" aria-live="polite"></div>';
 root.querySelector('[data-preview]').onclick=async e=>{
  const output=root.querySelector('[data-preview-result]'),generation=revision;e.target.disabled=true;
  try{
   validate();const localDate=root.querySelector('[data-preview-date]').value;if(!localDate)throw new Error('Choose a preview date.');
   const value=await request(apiFetch,'/api/booking-availability/preview',{channel,localDate,[channel==='sms'?'settings':'rule']:draft});
   if(generation!==revision)return;
   output.innerHTML=`<p>${esc(value.timeZone)} · ${value.hypothetical?'Hypothetical preview; this schedule is inactive.':'Current capacity; a preview does not reserve a slot.'}</p><div class="availability-slots">${value.slots.map(s=>`<span class="availability-slot ${s.available?'open':''}">${esc(s.localTime)} · ${s.available?`${s.remainingCapacity} available`:'Unavailable'}</span>`).join('')||'<p>No openings within the configured hours.</p>'}</div>`;
  }catch(error){if(generation===revision)output.textContent=error.message;}finally{e.target.disabled=false;}
 };
 return ()=>{revision++;root.querySelector('[data-preview-result]').textContent='Settings changed. Preview again to see current availability.';};
}
function wireDraft(form,draft,onChange){
 form.querySelectorAll('[name]').forEach(input=>{
  input.addEventListener('input',()=>{draft[input.name]=input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value;onChange();});
 });
}
function freezeForm(form){
 const controls=[...form.querySelectorAll('input,select,button')].map(control=>[control,control.disabled]);
 controls.forEach(([control])=>{control.disabled=true;});
 return ()=>controls.forEach(([control,disabled])=>{control.disabled=disabled;});
}
function validateForm(form,draft){
 if(!form.reportValidity())throw new Error('Complete the highlighted fields.');
 validateSchedule(draft.weeklyAvailability,draft.dateExceptions);
}
function mountExtraFields(root,draft,changed){
 const draw=()=>{
  root.innerHTML=`<h3>Extra booking questions</h3>${(draft.extraFields||[]).map((f,i)=>`<fieldset data-question="${i}" class="availability-day"><legend>Question ${i+1}</legend><div class="automation-form-grid">${inputField('question','Question',f.question,'maxlength="240" required')}${inputField('key','Field key',f.key,'maxlength="40" pattern="[a-z][a-z0-9_]{0,39}" required')}<label>Type<select name="type">${['short_text','long_text','number','boolean','single_select'].map(t=>`<option ${t===f.type?'selected':''}>${t}</option>`).join('')}</select></label><label class="availability-toggle"><input name="required" type="checkbox" ${f.required?'checked':''}> Required</label>${f.type==='single_select'?inputField('options','Options, separated by commas',(f.options||[]).join(', '),'required'):''}</div><button type="button" class="btn ghost" data-remove-question>Remove question</button></fieldset>`).join('')}<button type="button" class="btn ghost" data-add-question ${(draft.extraFields||[]).length>=30?'disabled':''}>Add question</button>`;
  root.querySelectorAll('[data-question]').forEach(section=>{
   const f=draft.extraFields[section.dataset.question];
   section.querySelectorAll('[name]').forEach(input=>input.oninput=()=>{f[input.name]=input.name==='options'?input.value.split(',').map(v=>v.trim()).filter(Boolean):input.type==='checkbox'?input.checked:input.value;changed();if(input.name==='type')draw();});
   section.querySelector('[data-remove-question]').onclick=()=>{draft.extraFields.splice(Number(section.dataset.question),1);changed();draw();};
  });
  root.querySelector('[data-add-question]').onclick=()=>{draft.extraFields??=[];draft.extraFields.push({key:'',question:'',type:'short_text',required:false,options:[]});changed();draw();};
 };draw();
}
export function voiceDraft(row={}){
 return {id:row.id,service:row.service||'junk_removal',variant:row.variant||'',market:row.market||'',zipCodes:row.zip_codes||[],timeZone:row.time_zone||'',resourcePool:row.resource_pool||'',durationMinutes:row.duration_minutes??120,capacity:row.capacity??1,minimumNoticeMinutes:row.minimum_notice_minutes??120,maximumAdvanceDays:row.maximum_advance_days??90,weeklyAvailability:structuredClone(row.weekly_availability||Object.fromEntries(days.map((_,i)=>[i,[]]))),dateExceptions:structuredClone(row.date_exceptions||[]),enabled:row.enabled||false};
}
export function mountBookingSetup(root,{draft,voiceState,rules,apiFetch,timeZone,onProfile}){
 root.innerHTML=`<section class="card setup-body"><h2>Booking availability</h2><p>Staff manage separate SMS and voice schedules here. Saving hours does not connect or activate the phone agent.</p></section><form data-sms-form class="card setup-body"><h2>SMS schedule</h2><p role="status">Conversational SMS booking is inactive. These settings are retained for configuration only.</p><p>Business time zone: <strong>${esc(timeZone||'Unavailable')}</strong> <button type="button" class="btn ghost" data-profile>Edit business profile</button></p><div class="automation-form-grid">${numberField('slotDurationMinutes','Slot length (minutes)',15,480,draft.slotDurationMinutes)}${numberField('capacityPerSlot','Bookings per start time',1,100,draft.capacityPerSlot)}${numberField('minimumNoticeMinutes','Minimum notice (minutes)',0,43200,draft.minimumNoticeMinutes)}${numberField('maximumAdvanceDays','Maximum advance (days)',1,730,draft.maximumAdvanceDays)}</div><div data-sms-schedule></div><details><summary>Retained SMS questions and follow-up settings</summary><p>These controls do not reactivate conversational SMS or its follow-ups.</p><label class="availability-toggle"><input name="followUpEnabled" type="checkbox" ${draft.followUpEnabled?'checked':''}> Retain follow-up setting</label><div class="automation-form-grid">${numberField('followUpDelayHours','First follow-up after (hours)',1,720,draft.followUpDelayHours)}${numberField('followUpIntervalHours','Follow-up interval (hours)',1,720,draft.followUpIntervalHours)}${numberField('followUpMaxAttempts','Maximum follow-ups',1,5,draft.followUpMaxAttempts)}</div><div data-extra-fields></div></details><div data-sms-preview></div><div class="compose-actions"><button type="submit" class="btn">Save SMS settings</button><span data-sms-result role="status" aria-live="polite"></span></div></form><section class="card setup-body"><h2>Voice service schedules</h2><p>Services sharing staff or equipment must use the same resource pool and capacity. Phone booking also requires the separate agent connection to be enabled.</p><label>Service rule<select data-rule-select><option value="new">New service rule</option>${rules.map(r=>`<option value="${esc(r.id)}">${esc(r.service.replaceAll('_',' '))} · ${esc(r.market)}</option>`).join('')}</select></label><div data-voice-form></div></section>`;
 const form=root.querySelector('[data-sms-form]');root.querySelector('[data-profile]').onclick=onProfile;
 let invalidate=()=>{};const changed=()=>{draft._dirty=true;root.querySelector('[data-sms-result]').textContent='Unsaved changes';invalidate();};
 wireDraft(form,draft,changed);mountScheduleEditor(root.querySelector('[data-sms-schedule]'),draft,changed);
 mountExtraFields(root.querySelector('[data-extra-fields]'),draft,changed);
 invalidate=mountPreview(root.querySelector('[data-sms-preview]'),{apiFetch,channel:'sms',draft,validate:()=>validateForm(form,draft)});
 form.onsubmit=async e=>{
  e.preventDefault();const button=form.querySelector('[type=submit]'),status=root.querySelector('[data-sms-result]');let thaw=()=>{};
  try{validateForm(form,draft);thaw=freezeForm(form);const payload={...draft};delete payload._dirty;delete payload.version;
   const response=await apiFetch('/api/booking-settings',{method:'PUT',body:JSON.stringify(payload)}),data=await response.json();if(!response.ok)throw new Error(data.error||'Save failed');
   Object.assign(draft,data,{_dirty:false});
   mountScheduleEditor(root.querySelector('[data-sms-schedule]'),draft,changed);
   mountExtraFields(root.querySelector('[data-extra-fields]'),draft,changed);
   status.textContent='Saved';invalidate();
  }catch(error){status.textContent=error.message;}finally{thaw();}
 };
 voiceState.drafts??={};voiceState.selected??='new';
 const selector=root.querySelector('[data-rule-select]');selector.value=voiceState.selected;
 const drawVoice=()=>{
  const key=voiceState.selected;
  const v=voiceState.drafts[key]??=voiceDraft(rules.find(r=>r.id===key));
  const host=root.querySelector('[data-voice-form]');
  host.innerHTML=`<form><div class="automation-form-grid"><label>Service<select name="service">${['junk_removal','local_moving','property_cleanout','dumpster_rental'].map(s=>`<option value="${s}" ${v.service===s?'selected':''}>${s.replaceAll('_',' ')}</option>`).join('')}</select></label>${inputField('variant','Dumpster size (dumpster rental only)',v.variant,'maxlength="80"')}${inputField('market','Market',v.market,'required maxlength="100"')}${inputField('zipText','ZIP codes, separated by commas',v.zipCodes.join(', '),'required')}${inputField('timeZone','Local time zone',v.timeZone,'required placeholder="America/Denver"')}${inputField('resourcePool','Resource pool',v.resourcePool,'required maxlength="100"')}${numberField('durationMinutes','Job duration (minutes)',15,43200,v.durationMinutes)}${numberField('capacity','Overlapping jobs per pool',1,100,v.capacity)}${numberField('minimumNoticeMinutes','Minimum notice (minutes)',0,43200,v.minimumNoticeMinutes)}${numberField('maximumAdvanceDays','Maximum advance (days)',1,730,v.maximumAdvanceDays)}</div><div data-voice-schedule></div><label class="availability-toggle"><input name="enabled" type="checkbox" ${v.enabled?'checked':''}> Enable this service rule</label><p class="muted">Only enable after reviewing coverage, hours, time zone and real capacity.</p><div data-voice-preview></div><div class="compose-actions"><button type="submit" class="btn">Save voice rule</button><span data-voice-result role="status" aria-live="polite"></span></div></form>`;
  const vf=host.querySelector('form'),status=host.querySelector('[data-voice-result]');let invalidateVoice=()=>{};
  const change=()=>{status.textContent='Unsaved changes';invalidateVoice();};
  wireDraft(vf,v,change);vf.elements.zipText.oninput=()=>{v.zipCodes=vf.elements.zipText.value.split(',').map(s=>s.trim()).filter(Boolean);delete v.zipText;change();};
  const validate=()=>{validateForm(vf,v);try{new Intl.DateTimeFormat('en',{timeZone:v.timeZone});}catch{throw new Error('Time zone: enter a valid IANA time zone.');}if(!v.zipCodes.length||v.zipCodes.some(z=>!/^\d{5}$/.test(z)))throw new Error('ZIP codes must contain five digits.');if((v.service==='dumpster_rental')!==Boolean(v.variant.trim()))throw new Error('Specify a size only for dumpster rental.');};
  mountScheduleEditor(host.querySelector('[data-voice-schedule]'),v,change);
  invalidateVoice=mountPreview(host.querySelector('[data-voice-preview]'),{apiFetch,channel:'voice',draft:v,validate});
  vf.onsubmit=async e=>{e.preventDefault();const button=vf.querySelector('[type=submit]');let thaw=()=>{};try{validate();thaw=freezeForm(vf);selector.disabled=true;
   const response=await apiFetch('/api/voice-booking-rules',{method:'PUT',body:JSON.stringify(v)}),body=await response.json();if(!response.ok)throw new Error(body.error||'Save failed');
   const saved=body.rule;Object.assign(v,voiceDraft(saved));voiceState.drafts[saved.id]=v;
   if(key==='new')delete voiceState.drafts.new;voiceState.selected=saved.id;
   if(!rules.some(r=>r.id===saved.id)){rules.push(saved);const option=document.createElement('option');option.value=saved.id;selector.append(option);}else Object.assign(rules.find(r=>r.id===saved.id),saved);
   const option=[...selector.options].find(o=>o.value===saved.id);option.textContent=`${saved.service.replaceAll('_',' ')} · ${saved.market}`;selector.value=saved.id;
   drawVoice();host.querySelector('[data-voice-result]').textContent='Saved';
  }catch(error){status.textContent=error.message;}finally{thaw();selector.disabled=false;}};
 };
 selector.onchange=()=>{voiceState.selected=selector.value;drawVoice();};drawVoice();
}
