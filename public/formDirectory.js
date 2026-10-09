const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const types = {contacts:'Contact',quote_requests:'Quote request',bookings:'Appointment'};
export const formStatus = form => form.archived ? 'Archived' : form.enabled ? 'Live' : 'Draft';
export const automationStatus = form => form.archived ? 'Archived' : form.automationEnabled ? 'Active' : form.publishedVersion ? 'Paused' : 'Not published';
const count = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
export function formTotals(forms) {
  const counts = forms.map(form => count(form.submissionCount));
  return {forms:forms.length,live:forms.filter(f=>!f.archived&&f.enabled).length,
    automations:forms.filter(f=>!f.archived&&f.automationEnabled).length,
    submissions:counts.some(n=>n===null)?null:counts.reduce((sum,n)=>sum+n,0)};
}
export function filterForms(forms, query='', status='all') {
  const q=query.trim().toLowerCase();
  return forms.filter(f=>(status==='all'||formStatus(f).toLowerCase()===status) &&
    [f.title,f.description,f.public_id,types[f.preset],automationStatus(f)].some(v=>String(v||'').toLowerCase().includes(q)));
}
const number = value => value == null ? 'Unavailable' : value.toLocaleString();
function date(value,timeZone) {
  if(!value || !Number.isFinite(Date.parse(value)))return 'Not recorded';
  return new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',...(timeZone?{timeZone}:{})}).format(new Date(value));
}
export function formCards(forms,{canReadSubmissions=true,timeZone}={}) {
  return forms.map(f=>`<article class="form-directory-card">
    <div class="form-directory-card-head"><h3>${esc(f.title)}</h3><span class="form-directory-state">${formStatus(f)}</span></div>
    <p class="muted">${esc(f.description||'No description added.')}</p>
    <dl class="form-directory-facts">
      <div><dt>Submissions · all time</dt><dd>${number(count(f.submissionCount))}</dd></div>
      <div><dt>Automation</dt><dd>${automationStatus(f)}${f.publishedVersion?` · v${esc(f.publishedVersion)}`:''}</dd></div>
      <div><dt>Form type</dt><dd>${esc(types[f.preset]||f.preset||'Not recorded')}</dd></div>
      <div><dt>Custom fields</dt><dd>${Array.isArray(f.fields)?f.fields.length:'Not recorded'}</dd></div>
      <div><dt>Created</dt><dd>${esc(date(f.created_at,timeZone))}</dd></div>
      <div><dt>Updated</dt><dd>${esc(date(f.updated_at,timeZone))}</dd></div>
    </dl>
    <details><summary>Form details</summary><p>Form ID: <code>${esc(f.public_id)}</code></p><p>Form version: ${esc(f.version??'Not recorded')} · Submit button: ${esc(f.button_label||'Not recorded')}</p><p>Custom fields: ${esc(f.fields?.map(field=>`${field.label}${field.required?' (required)':''}`).join(', ')||'None')}</p></details>
    <div class="form-editor-actions"><button type="button" class="btn ghost" data-form-open="${esc(f.public_id)}" data-form-tab="form" aria-label="Open ${esc(f.title)} form">Open form</button>${canReadSubmissions?`<button type="button" class="btn ghost" data-form-open="${esc(f.public_id)}" data-form-tab="submissions" aria-label="View ${esc(f.title)} submissions">Submissions</button><button type="button" class="btn ghost" data-form-open="${esc(f.public_id)}" data-form-tab="automation" aria-label="View ${esc(f.title)} automation">Automation</button>`:''}</div>
  </article>`).join('');
}
export function mountFormDirectory(root,data,{onOpen,canReadSubmissions=true}={}) {
  const forms=data.forms||[], totals=formTotals(forms);
  root.innerHTML=`<dl class="form-directory-totals">${[['Created forms',totals.forms],['Live forms',totals.live],['Active automations',totals.automations],['All-time submissions',totals.submissions]].map(([label,value])=>`<div><dt>${label}</dt><dd>${number(value)}</dd></div>`).join('')}</dl>
    <div class="form-rule-grid"><label>Find a form<input type="search" data-form-search placeholder="Name, type, description or ID"></label><label>Form status<select data-form-filter><option value="all">All forms</option><option value="live">Live</option><option value="draft">Draft</option><option value="archived">Archived</option></select></label></div>
    <p class="muted">Counts include archived forms. Automation status shows the saved sequence setting; actual sending also depends on consent, business sending settings and delivery eligibility.${data.timeZone?` Dates shown in ${esc(data.timeZone)}.`:''}</p>
    <p role="status" data-form-count></p><div class="form-directory-grid" data-form-results></div>`;
  const search=root.querySelector('[data-form-search]'),filter=root.querySelector('[data-form-filter]');
  function paint(){
    const visible=filterForms(forms,search.value,filter.value);
    root.querySelector('[data-form-count]').textContent=`${visible.length} of ${forms.length} forms`;
    const results=root.querySelector('[data-form-results]');
    results.innerHTML=formCards(visible,{canReadSubmissions,timeZone:data.timeZone})||`<p class="blank">${forms.length?'No forms match these filters.':'No forms yet. Create your first form to collect submissions.'}</p>`;
    results.querySelectorAll('[data-form-open]').forEach(button=>button.onclick=()=>onOpen?.(button.dataset.formOpen,button.dataset.formTab));
  }
  search.oninput=paint;filter.onchange=paint;paint();
}
