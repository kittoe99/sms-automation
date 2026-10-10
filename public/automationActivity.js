const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function activityQuery(filters) {return new URLSearchParams(Object.entries(filters).filter(([,v])=>v!==''&&v!=null)).toString();}
export function activityRate(value) {return value==null?'—':`${value}%`;}
const label=value=>String(value??'').replaceAll('_',' ');
export function activityEventText(event) {
 const d=event.details||{};
 if(d.body)return d.body;
 if(event.kind==='sequence_started')return 'Follow-up sequence started.';
 if(event.kind==='submission')return 'Customer enquiry submitted.';
 if(event.kind==='message_delivered')return 'Provider reported delivery.';
 if(event.kind==='sequence_state'||event.kind==='historical_status_snapshot')return `${label(d.status)}${d.reason?` · ${label(d.reason).toLowerCase()}`:''}`;
 if(event.kind==='ai_state')return d.paused?'AI paused. Staff must resume it.':'AI resumed.';
 if(event.kind==='staff_sequence')return `Staff ${d.operation==='resume'?'resumed':'paused'} this sequence.`;
 if(event.kind==='staff_tag_assignment')return d.present?'Staff added an enquiry tag.':'Staff removed an enquiry tag.';
 if(event.kind==='booking_state')return `Booking ${d.bookingId}: ${label(d.from)} → ${label(d.status)}`;
 if(event.kind==='booking_link'||event.kind==='staff_booking_link')return `Booking ${d.bookingId} linked as the primary enquiry attribution.`;
 if(event.kind==='booking_attribution_removed')return `Booking ${d.bookingId} attribution moved to another enquiry.`;
 if(event.kind==='response_attribution_removed')return 'Response attribution moved to another enquiry.';
 if(event.kind==='staff_activity_link')return 'Staff explicitly attributed this AI activity.';
 if(event.kind==='staff_response_link')return 'Staff explicitly attributed this customer response.';
 if(event.kind==='handoff_state')return `Staff handoff: ${label(d.status)}`;
 if(event.kind==='ai_action')return `${label(d.name)}${d.result?.customerReply?`: ${d.result.customerReply}`:''}`;
 if(event.kind==='ai_run')return d.result?.reply||'AI run recorded.';
 return label(event.kind);
}
export async function mountAutomationActivity(root,{apiFetch,identity,isCurrent,onConversation,onForm,onBookings,onHandoffs}) {
 const key=`automation-activity:${identity}`;let filters={page:1},data,detail,controller,timer,closed=false,revision=0;
 try{filters={...filters,...JSON.parse(sessionStorage.getItem(key)||'{}')};}catch{}
 const active=()=>!closed&&isCurrent();
 const save=()=>{try{sessionStorage.setItem(key,JSON.stringify(filters));}catch{}};
 const time=value=>value?new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:data?.timeZone||'UTC'}).format(new Date(value)):'Unknown time';
 const badge=(text,kind='')=>`<span class="aa-badge ${esc(kind)}">${esc(text)}</span>`;
 const option=(value,text,current)=>`<option value="${esc(value)}" ${String(current??'')===String(value)?'selected':''}>${esc(text)}</option>`;
 const field=(name,title,choices)=>`<label>${title}<select name="${name}">${option('','All',filters[name])}${choices.map(([v,l])=>option(v,l,filters[name])).join('')}</select></label>`;
 async function request(path,options={}) {
  const response=await apiFetch(`/api/automation-activity/${path}`,options);const body=await response.json();
  if(!response.ok)throw new Error(body.error||'Activity could not be loaded.');return body;
 }
 async function mutate(action,p) {
  const error=root.querySelector('[data-error]');if(error)error.textContent='';
  try{await request(action,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(p)});await load();}
  catch(e){if(active()&&error)error.textContent=e.message;}
 }
 function shell() {
  root.innerHTML=`<section class="aa" aria-label="Automation activity">
   <style>.aa{display:grid;gap:18px;min-width:0;width:100%}.aa>*{min-width:0}.aa-head,.aa-actions,.aa-quick{display:flex;gap:8px;align-items:center;flex-wrap:wrap}.aa-head{justify-content:space-between}.aa h2,.aa h3{margin:0}.aa-filters{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.aa label{min-width:0;display:grid;gap:5px;font-size:13px}.aa input,.aa select{width:100%;min-width:0}.aa-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px}.aa-card{border:1px solid var(--border,#d9dfe5);border-radius:10px;padding:14px;background:var(--panel,#fff)}.aa-card strong{display:block;font-size:24px;margin-top:7px}.aa-muted{color:var(--muted,#52616d);font-size:13px}.aa-badge{display:inline-block;border-radius:20px;padding:3px 8px;margin:2px;background:#eaf0f5;font-size:12px;color:#243847}.aa-badge.attention{background:#fff0d5;color:#7a4900}.aa-badge.shadow{background:#f0e7ff;color:#623894}.aa .table-scroll{overflow:auto;max-width:100%}.aa table{min-width:1050px}.aa button:focus-visible,.aa input:focus-visible,.aa select:focus-visible{outline:3px solid #0879c9;outline-offset:2px}.aa button[aria-pressed=true]{background:#173d58;color:white}.aa-timeline{list-style:none;padding:0;display:grid;gap:12px}.aa-timeline li{border-left:3px solid #d3e2ec;padding:8px 14px}.aa pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.aa-dialog{border:1px solid #d9dfe5;border-radius:12px;padding:20px}.aa [data-error]{color:#a02020}.aa-tags{display:flex;gap:8px;flex-wrap:wrap}.aa-tags label{display:flex;align-items:center}.aa-tags input{width:auto}@media(max-width:640px){.aa-filters{grid-template-columns:repeat(2,minmax(0,1fr))}.aa-dialog{padding:12px}}</style>
   <div class="aa-head"><div><h2>Automation activity</h2><p class="aa-muted">Follow enquiries from first contact to response and booking.</p></div><button class="btn ghost" data-refresh>Refresh</button></div>
   <div data-error role="alert"></div><div data-content role="status">Loading automation activity…</div><div data-detail></div>
  </section>`;
  root.querySelector('[data-refresh]').onclick=()=>load();
 }
 function render() {
  const content=root.querySelector('[data-content]');content.removeAttribute('role');
  const unlinked=filters.quick==='unlinked',shadow=filters.scope==='shadow';
  const cards=(entries)=>`<div class="aa-cards">${entries.map(([title,value])=>`<div class="aa-card"><span class="aa-muted">${title}</span><strong>${esc(value)}</strong></div>`).join('')}</div>`;
  content.innerHTML=`<form data-filters class="aa-filters">
   <label>From<input type="date" name="from" value="${esc(filters.from||data.from)}"></label><label>Through<input type="date" name="to" value="${esc(filters.to||data.to)}"></label>
   ${field('form','Form',data.forms.map(f=>[f.id,f.title]))}${field('status','Sequence status',[['active','Active'],['paused','Paused'],['completed','Completed'],['stopped','Stopped']])}
   ${field('response','Response',[['responded','Responded'],['none','No attributed reply']])}${field('booking','Booking',[['booked','Confirmed'],['cancelled','Cancelled'],['none','No confirmed booking']])}
   ${field('handoff','Handoff',[['unresolved','Unresolved'],['any','Any handoff'],['none','None']])}
   <label>Activity type<select name="scope">${[['enquiry','Enquiries'],['appointment','Appointment reminders'],['test','Test runs'],['shadow','Shadow proposals']].map(([v,l])=>option(v,l,filters.scope||'enquiry')).join('')}</select></label>
   <label>Customer name or phone<input name="search" type="search" value="${esc(filters.search)}" placeholder="Search customers"></label>
   <label>Tags · match any<select name="tags" multiple size="2" aria-label="Filter by tags">${data.tags.filter(t=>!t.archived).map(t=>`<option value="${t.id}" ${(filters.tags||'').split(',').includes(t.id)?'selected':''}>${esc(t.name)}</option>`).join('')}</select></label>
   <div class="aa-actions"><button class="btn" type="submit">Apply filters</button><button class="btn ghost" type="button" data-clear>Clear</button></div></form>
   <div class="aa-quick" aria-label="Quick filters">${[['','All enquiries'],['attention','Needs attention'],['paused','Paused'],['responded','Responded'],['booked','Booked'],['unlinked','Unlinked activity']].map(([v,l])=>`<button class="btn ghost" data-quick="${v}" aria-pressed="${(filters.quick||'')===v}">${l}</button>`).join('')}</div>
   <p class="aa-muted">Reporting through ${esc(time(data.reportingAt))} · ${esc(data.timeZone)} · Refreshes every 30 seconds while visible.</p>
   ${unlinked||shadow?`<p>${shadow?'Shadow proposals are simulated and excluded from actual results.':'Unlinked activity is excluded from enquiry response and conversion totals until explicitly attributed.'}</p><div data-special>Loading…</div>`:`
   <h3>Message activity in selected dates</h3>${cards([['Provider accepted',data.activity.accepted],['Delivered',data.activity.delivered],['Customer responses',data.activity.responses],['AI replies sent',data.activity.aiSent],['Linked bookings · cohort',data.outcomes.linkedBookings],['Handoffs · cohort',data.outcomes.handoffs]])}
   <p class="aa-muted">${esc(data.definitions.activity)}</p><h3>Enquiry conversion</h3>${cards([['Contacted',data.funnel.contacted],['Responded',data.funnel.responded],['Currently booked',data.funnel.booked],['Response rate',activityRate(data.funnel.responseRate)],['Conversion rate',activityRate(data.funnel.conversionRate)],['Cancelled · cohort',data.funnel.cancelled]])}
   <p class="aa-muted">${esc(data.definitions.cohort)} ${esc(data.definitions.conversion)}</p>
   <h3>Current workload</h3>${cards([['Active sequences',data.workload.active],['Quiet-window holds',data.workload.quiet],['Paused sequences',data.workload.paused],['Paused AI conversations',data.workload.aiPaused],['Unresolved handoffs',data.workload.unresolvedHandoffs]])}<p class="aa-muted">${esc(data.definitions.workload)}</p>
   <div class="table-scroll"><table class="data"><thead><tr>${['Customer','Form / version','Status','Tags','Latest response','Booking','Handoff','Next action'].map(x=>`<th>${x}</th>`).join('')}</tr></thead><tbody>${data.rows.map(r=>`<tr><td><button class="btn ghost" data-run="${r.id}">${esc(r.customer)}</button><div class="aa-muted">${esc(r.phone)}</div></td><td>${esc(r.form_title)}<div class="aa-muted">Version ${esc(r.version??'Test')}</div></td><td>${badge(r.status,r.status==='paused'?'attention':'')}${r.ai_paused?badge('AI paused','attention'):''}${r.status==='active'&&r.quiet_until&&new Date(r.quiet_until)>new Date(data.reportingAt)?badge('Quiet window'):''}${r.opted_out?badge('STOP','attention'):''}</td><td>${r.tags.map(t=>badge(t.name)).join('')||'—'}</td><td>${esc(r.latest_response||'No attributed reply')}</td><td>${r.confirmed_bookings?badge(`${r.confirmed_bookings} confirmed`):'—'}${r.cancelled_bookings?badge(`${r.cancelled_bookings} cancelled`):''}</td><td>${r.unresolved_handoffs?badge(`${r.unresolved_handoffs} unresolved`,'attention'):r.handoffs?'Resolved':'—'}</td><td>${r.status==='active'?esc(time(r.quiet_until&&new Date(r.quiet_until)>new Date(r.next_run_at)?r.quiet_until:r.next_run_at)):r.status==='paused'?'Staff action required':'No pending action'}</td></tr>`).join('')||'<tr><td colspan="8">No enquiries match these filters.</td></tr>'}</tbody></table></div>
   <div class="aa-actions"><button class="btn ghost" data-page="${Number(filters.page)-1}" ${Number(filters.page)<=1?'disabled':''}>Previous</button><span>Page ${esc(filters.page)} · ${data.total} enquiries</span><button class="btn ghost" data-page="${Number(filters.page)+1}" ${Number(filters.page)*data.pageSize>=data.total?'disabled':''}>Next</button></div>`}
   ${data.canManage?`<details><summary>Manage enquiry tags</summary><p class="aa-muted">Tags organize enquiries. They do not send messages or change automation behavior.</p><form data-new-tag class="aa-actions"><label>New tag<input name="name" required maxlength="40"></label><button class="btn">Create tag</button></form>${data.tags.map(t=>`<form data-tag="${t.id}" class="aa-actions"><label>Tag name<input name="name" value="${esc(t.name)}" maxlength="40" required ${t.archived?'disabled':''}></label><button class="btn ghost" ${t.archived?'disabled':''}>Rename</button><button class="btn ghost" type="button" data-archive="${t.id}" ${t.archived?'disabled':''}>${t.archived?'Archived':'Archive'}</button></form>`).join('')}</details>`:''}`;
  content.querySelector('[data-filters]').onsubmit=e=>{e.preventDefault();const fd=new FormData(e.currentTarget);filters={...filters,...Object.fromEntries(fd),tags:fd.getAll('tags').join(','),page:1};save();load();};
  content.querySelector('[data-clear]').onclick=()=>{filters={page:1};save();load();};
  content.querySelectorAll('[data-quick]').forEach(b=>b.onclick=()=>{filters.quick=b.dataset.quick;filters.page=1;save();load();});
  content.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>{filters.page=Number(b.dataset.page);save();load();});
  content.querySelectorAll('[data-run]').forEach(b=>{b.onclick=()=>{detail=b.dataset.run;loadDetail({focus:true});};b.closest('tr').onclick=e=>{if(!e.target.closest('button'))b.click();};});
  content.querySelector('[data-new-tag]')?.addEventListener('submit',e=>{e.preventDefault();mutate('tag',{name:new FormData(e.currentTarget).get('name')});});
  content.querySelectorAll('[data-tag]').forEach(f=>f.onsubmit=e=>{e.preventDefault();const t=data.tags.find(t=>t.id===f.dataset.tag);mutate('tag',{id:t.id,revision:t.revision,name:new FormData(f).get('name')});});
  content.querySelectorAll('[data-archive]').forEach(b=>b.onclick=()=>{const t=data.tags.find(t=>t.id===b.dataset.archive);mutate('tag',{id:t.id,revision:t.revision,archived:true});});
 }
 async function loadSpecial(signal) {
  const result=await request(`unlinked?${activityQuery({...filters,shadow:filters.scope==='shadow'?'true':''})}`,{signal});if(!active()||signal.aborted)return;
  const target=root.querySelector('[data-special]');if(!target)return;
  target.innerHTML=`<ul class="aa-timeline">${result.rows.map(e=>`<li>${e.simulated?badge('Shadow','shadow'):''}<strong>${esc(label(e.kind))}</strong> <span class="aa-muted">${esc(time(e.occurred_at||e.recorded_at))}</span><p>${esc(e.details.body||e.details.name||e.details.result?.reply||'AI activity')}</p>${e.details.conversationId?`<button class="btn ghost" data-conversation="${esc(e.details.conversationId)}">Open conversation</button>`:''}${data.canManage&&e.candidates?.length?`<form data-link-response="${esc(e.details.messageId||'')}" data-event="${e.id}" data-revision="${e.revision}" data-kind="${e.kind}"><label>Attribute to enquiry<select name="runId" required><option value="">Choose the relevant enquiry</option>${(e.candidates||[]).map(r=>option(r.id,`${r.title} · ${r.id.slice(0,8)}`)).join('')}</select></label><button class="btn ghost">${e.kind==='customer_response'?'Link response':'Link AI activity'}</button></form>`:''}</li>`).join('')||'<li>No activity matches these filters.</li>'}</ul><div class="aa-actions"><button class="btn ghost" data-special-page="${Number(filters.page)-1}" ${filters.page<=1?'disabled':''}>Previous</button><span>${result.total} records</span><button class="btn ghost" data-special-page="${Number(filters.page)+1}" ${filters.page*25>=result.total?'disabled':''}>Next</button></div>`;
  target.querySelectorAll('[data-conversation]').forEach(b=>b.onclick=()=>onConversation(b.dataset.conversation));
  target.querySelectorAll('[data-special-page]').forEach(b=>b.onclick=()=>{filters.page=Number(b.dataset.specialPage);save();load();});
  target.querySelectorAll('[data-link-response]').forEach(f=>f.onsubmit=e=>{e.preventDefault();mutate(f.dataset.kind==='customer_response'?'response_link':'activity_link',{messageId:f.dataset.linkResponse,eventId:f.dataset.event,runId:new FormData(f).get('runId'),revision:f.dataset.kind==='customer_response'?0:Number(f.dataset.revision)});});
 }
 async function loadDetail({focus=false}={}) {
  const id=detail,version=revision;try{
   const d=await request(`timeline?runId=${encodeURIComponent(id)}`,{signal:controller.signal});if(!active()||detail!==id||version!==revision)return;
   const r=d.enquiry,target=root.querySelector('[data-detail]');
   target.innerHTML=`<section class="aa-dialog" aria-label="Enquiry timeline"><div class="aa-head"><h3>${esc(r.customer)} · ${esc(r.form_title)}</h3><button class="btn ghost" data-close>Close timeline</button></div>
    <p>${badge(r.status)} ${r.ai_paused?badge('AI paused','attention'):''} ${r.opted_out?badge('STOP','attention'):''}</p><p class="aa-muted">${esc(r.reason||'No coordination hold')}${r.quiet_until?` · Quiet until ${esc(time(r.quiet_until))}`:''}</p>
    <div class="aa-actions"><button class="btn ghost" data-conv>Conversation</button><button class="btn ghost" data-form>Form</button><button class="btn ghost" data-bookings>Bookings</button>${d.handoffs.length?'<button class="btn ghost" data-handoffs>Handoffs</button>':''}${d.canManage&&['active','paused'].includes(r.status)?`<button class="btn" data-sequence ${r.opted_out&&r.status==='paused'?'disabled':''}>${r.status==='paused'?'Resume':'Pause'} sequence</button>`:''}${d.canManage&&r.conversation_id?`<button class="btn ghost" data-ai ${r.opted_out&&r.ai_paused?'disabled':''}>${r.ai_paused?'Resume':'Pause'} AI</button>`:''}</div>
    <p class="aa-muted">Sequence and AI controls are independent. Resume cannot override STOP.</p>
    ${d.canManage?`<div class="aa-tags">${data.tags.filter(t=>!t.archived).map(t=>`<label><input type="checkbox" data-assign="${t.id}" ${r.tags.some(a=>a.id===t.id)?'checked':''}>${esc(t.name)}</label>`).join('')}</div><form data-booking-link class="aa-actions"><label>Link an existing customer booking<select name="bookingId" required><option value="">Select booking</option>${d.bookings.map(b=>option(b.id,`${b.id} · ${b.status} · ${time(b.appointmentAt)}${b.linkedRunId&&b.linkedRunId!==r.id?' · linked to another enquiry':''}`)).join('')}</select></label><button class="btn ghost">Save primary attribution</button></form>`:''}
    ${d.bookings.filter(b=>b.linkedRunId===r.id).map(b=>`<p>${badge(b.status)} Booking ${esc(b.id)} · Channel: ${esc(b.channel)} · Creator: ${esc(b.creator)}</p>`).join('')}
    ${d.handoffs.map(h=>`<p>${badge(h.status,'attention')} Handoff ${esc(h.id)} · ${esc(h.reason)}</p>`).join('')}
    <h3>Timeline</h3><ul class="aa-timeline">${d.events.map(e=>`<li><strong>${esc(label(e.kind))}</strong> ${e.simulated?badge('Shadow','shadow'):''}${e.historical?badge(e.occurred_at?'Historical record':'Historical status snapshot'):''}<div class="aa-muted">${e.occurred_at?esc(time(e.occurred_at)):'Transition time unavailable'}</div><pre>${esc(activityEventText(e))}</pre></li>`).join('')}</ul></section>`;
   if(focus){const heading=target.querySelector('h3');heading.tabIndex=-1;heading.focus({preventScroll:true});target.scrollIntoView({block:'start',behavior:'smooth'});}
   target.querySelector('[data-close]').onclick=()=>{detail=null;target.innerHTML='';root.querySelector(`[data-run="${id}"]`)?.focus();};
   target.querySelector('[data-conv]').onclick=()=>onConversation(r.conversation_id,r.phone);
   target.querySelector('[data-form]').onclick=()=>onForm(r.form_id);
   target.querySelector('[data-bookings]').onclick=()=>onBookings();
   target.querySelector('[data-handoffs]')?.addEventListener('click',()=>onHandoffs());
   target.querySelector('[data-sequence]')?.addEventListener('click',()=>mutate('sequence',{runId:r.id,generation:r.generation,operation:r.status==='paused'?'resume':'pause'}));
   target.querySelector('[data-ai]')?.addEventListener('click',async()=>{try{const res=await apiFetch(`/api/conversations/${r.conversation_id}/ai/${r.ai_paused?'resume':'pause'}`,{method:'POST',body:'{}'});if(!res.ok)throw new Error((await res.json()).error);await load();}catch(e){root.querySelector('[data-error]').textContent=e.message;}});
   target.querySelectorAll('[data-assign]').forEach(c=>c.onchange=()=>mutate('tag_assignment',{runId:r.id,tagId:c.dataset.assign,present:c.checked}));
   target.querySelector('[data-booking-link]')?.addEventListener('submit',e=>{e.preventDefault();const b=d.bookings.find(b=>b.id===new FormData(e.currentTarget).get('bookingId'));if(b)mutate('booking_link',{runId:r.id,bookingId:b.id,revision:b.revision});});
  }catch(e){if(active()&&e.name!=='AbortError')root.querySelector('[data-error]').textContent=e.message;}
 }
 async function load({background=false}={}) {
  if(!active()||background&&(document.hidden||root.contains(document.activeElement)&&document.activeElement.matches('input,select,textarea')))return;
  controller?.abort();controller=new AbortController();const signal=controller.signal;revision++;root.setAttribute('aria-busy','true');
  try{const nextData=await request(`report?${activityQuery({...filters,scope:filters.scope==='shadow'?'enquiry':filters.scope,quick:filters.quick==='unlinked'?'':filters.quick})}`,{signal});if(!active()||signal.aborted)return;data=nextData;filters.from||=data.from;filters.to||=data.to;render();if(filters.quick==='unlinked'||filters.scope==='shadow')await loadSpecial(signal);if(detail)await loadDetail();root.querySelector('[data-error]').textContent='';}
  catch(e){if(active()&&e.name!=='AbortError')root.querySelector('[data-error]').textContent=e.message;}
  finally{if(active()&&!signal.aborted)root.setAttribute('aria-busy','false');}
 }
 shell();await load();timer=setInterval(()=>{if(!active()){clearInterval(timer);controller?.abort();return;}load({background:true});},30000);
 return ()=>{closed=true;clearInterval(timer);controller?.abort();};
}
