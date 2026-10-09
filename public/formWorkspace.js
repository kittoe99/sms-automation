import {mountFormDirectory} from './formDirectory.js';
import {createFormBuilder} from './formBuilder.js?v=20261004-live-test';
import {renderFormAutomation} from './formAutomationEditor.js?v=20261004-live-test';
import {createFormData} from './formData.js';
const esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function createFormWorkspace({root,apiFetch:fetcher,config,canReadSubmissions,getTenantId=()=>config?.tenantId||localStorage.getItem('opek_sms_tenant_id')}) {
  let selected=null,tab='form',tenant=null,revision=0;
  const cache=createFormData(fetcher,getTenantId),apiFetch=cache.fetch;
  const request=async(path,options)=>{const r=await apiFetch(path,options),data=await r.json();if(!r.ok)throw new Error(data.error||'Could not load forms');return data;};
  async function render({refresh=true,formId,initialTab}={}){
    const ticket=++revision,currentTenant=getTenantId();
    if(refresh)cache.clear();
    const data=await cache.read('/api/web-forms');
    if(ticket!==revision||currentTenant!==getTenantId())return;
    if(tenant!==currentTenant){selected=null;tenant=currentTenant;}
    if(formId){selected=formId;tab=canReadSubmissions()&&['automation','submissions'].includes(initialTab)?initialTab:'form';}
    const form=data.forms.find(f=>f.public_id===selected);
    if(!form){selected=null;root.innerHTML=`<section class="card"><div class="card-head"><div><h2>Your forms</h2><p class="muted">Create a form, then configure its messages and rules.</p></div></div>
      <div class="web-builder-body">${data.canEdit?`<form data-create class="form-rule-grid"><label>Form name<input name="title" required maxlength="120" placeholder="e.g. Spring estimate requests" /></label><label>Starting fields<select name="preset"><option value="contacts">Contact form</option><option value="quote_requests">Quote request</option><option value="bookings">Appointment form</option></select></label><button class="btn" type="submit">Create form</button></form>`:''}
      <p role="status" data-status></p><div data-form-directory></div></div></section>`;
      mountFormDirectory(root.querySelector('[data-form-directory]'),data,{canReadSubmissions:canReadSubmissions(),onOpen:(id,nextTab)=>{selected=id;tab=nextTab;render({refresh:false}).catch(showError);}});
      root.querySelector('[data-create]')?.addEventListener('submit',async e=>{e.preventDefault();const input=new FormData(e.currentTarget);const button=e.currentTarget.querySelector('button');button.disabled=true;
        try{const result=await request('/api/web-forms',{method:'POST',body:JSON.stringify({title:input.get('title'),preset:input.get('preset'),description:'',buttonLabel:'Submit',fields:[],enabled:false})});selected=result.form.public_id;tab='form';await render({refresh:false});}catch(err){root.querySelector('[data-status]').textContent=err.message;button.disabled=false;}});
      return;
    }
    root.innerHTML=`<div class="form-workspace-heading"><button class="btn ghost" data-back>← All forms</button><h2>${esc(form.title)}</h2>${data.canEdit&&form.archived?'<button class="btn ghost" data-restore>Restore as draft</button>':''}${data.canEdit&&!form.archived?'<button class="btn ghost" data-duplicate>Duplicate form</button><button class="btn ghost" data-archive>Archive</button>':''}</div>
      <div class="web-builder-tabs" role="tablist" aria-label="Form workspace">${[['form','Form'],...(canReadSubmissions()?[['automation','Automation'],['submissions','Submissions']]:[])].map(([id,label])=>`<button class="btn ${tab===id?'':'ghost'}" role="tab" aria-selected="${tab===id}" data-tab="${id}">${label}</button>`).join('')}</div><div data-panel role="tabpanel"></div><p data-error role="status"></p>`;
    root.querySelector('[data-back]').onclick=()=>{selected=null;render({refresh:false}).catch(showError);};
    root.querySelectorAll('[data-tab]').forEach(b=>{b.onclick=()=>{tab=b.dataset.tab;render({refresh:false}).catch(showError);};b.onkeydown=e=>{const tabs=[...root.querySelectorAll('[data-tab]')],index=tabs.indexOf(b),next=e.key==='ArrowRight'?(index+1)%tabs.length:e.key==='ArrowLeft'?(index+tabs.length-1)%tabs.length:e.key==='Home'?0:e.key==='End'?tabs.length-1:-1;if(next>=0){e.preventDefault();tab=tabs[next].dataset.tab;render({refresh:false}).then(()=>root.querySelector(`[data-tab="${tab}"]`)?.focus()).catch(showError);}};});
    for(const action of ['duplicate','archive','restore'])root.querySelector(`[data-${action}]`)?.addEventListener('click',async()=>{
      try{const r=await request(`/api/web-forms/${form.public_id}/${action}`,{method:'POST',body:'{}'});selected=action==='duplicate'?r.form.public_id:null;tab='form';await render({refresh:false});}catch(e){showError(e);}});
    const panel=root.querySelector('[data-panel]');
    if(tab==='form')await createFormBuilder({root:panel,apiFetch,config,canReadSubmissions,formId:form.public_id,hideSubmissions:true}).render(data);
    if(tab==='automation')await renderFormAutomation({root:panel,form,apiFetch,loadPresets:()=>cache.read('/api/automation-presets'),canManage:data.canManageAutomation&&!form.archived,timeZone:data.timeZone});
    if(tab==='submissions')await submissions(panel,form,data.canManageAutomation);
  }
  function showError(e){const host=root.querySelector('[data-error]')||root.querySelector('[data-status]');if(host)host.textContent=e.message;}
  async function submissions(panel,form,staff,page=1){
    const data=await request(`/api/web-forms/${form.public_id}/submissions?page=${page}`);
    panel.innerHTML=`<section class="card"><div class="card-head"><h3>Submissions</h3><span>${data.total} total</span></div><div class="web-builder-body"><div class="table-scroll"><table class="data"><thead><tr><th>Contact</th><th>Received</th><th>Automation</th><th>Answers</th></tr></thead><tbody>${data.rows.map(r=>`<tr><td>${esc(r.name)}<br>${esc(r.phone)}<br>${esc(r.email)}</td><td>${esc(new Date(r.submitted_at).toLocaleString())}</td><td>${esc(r.enrollment_status||'No run')}${r.skip_reason?` · ${esc(r.skip_reason)}`:''}${r.run_id?`<br>${r.send_index} sends accepted`:''}${staff&&!r.run_id&&r.sms_opt_in?`<button class="btn ghost" data-enroll="${r.id}">Start published sequence</button>`:''}${staff&&r.run_id&&['active','paused'].includes(r.enrollment_status)?`<div><button class="btn ghost" data-run="${r.run_id}" data-action="${r.enrollment_status==='active'?'pause':'resume'}">${r.enrollment_status==='active'?'Pause':'Resume'}</button><button class="btn ghost" data-run="${r.run_id}" data-action="stop">Stop</button></div>`:''}</td><td><details><summary>View answers</summary>${Object.entries(r.details||{}).map(([k,v])=>`<p><strong>${esc(r.field_snapshot?.find(f=>f.key===k)?.label||k)}:</strong> ${esc(v)}</p>`).join('')||'No custom answers'}</details></td></tr>`).join('')||'<tr><td colspan="4">No submissions yet.</td></tr>'}</tbody></table></div><div class="form-editor-actions"><button class="btn ghost" data-page="-1" ${page===1?'disabled':''}>Previous</button><span>Page ${page} of ${data.totalPages}</span><button class="btn ghost" data-page="1" ${page>=data.totalPages?'disabled':''}>Next</button></div><p role="status" data-status></p></div></section>`;
    panel.querySelectorAll('[data-page]').forEach(b=>b.onclick=()=>submissions(panel,form,staff,page+Number(b.dataset.page)).catch(showError));
    panel.querySelectorAll('[data-enroll]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await request(`/api/web-forms/${form.public_id}/automation/enroll`,{method:'PUT',body:JSON.stringify({submissionId:b.dataset.enroll})});await submissions(panel,form,staff,page);}catch(e){panel.querySelector('[data-status]').textContent=e.message;b.disabled=false;}});
    panel.querySelectorAll('[data-run]').forEach(b=>b.onclick=async()=>{b.disabled=true;try{await request(`/api/web-forms/${form.public_id}/automation/${b.dataset.action}`,{method:'PUT',body:JSON.stringify({runId:b.dataset.run})});await submissions(panel,form,staff,page);}catch(e){panel.querySelector('[data-status]').textContent=e.message;b.disabled=false;}});
  }
  return {render,reset(){revision++;cache.clear();selected=null;tenant=null;tab='form';}};
}
