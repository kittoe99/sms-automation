/* global crypto, structuredClone, window, document */
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const option = (value,label,selected) => `<option value="${esc(value)}" ${value===selected?'selected':''}>${esc(label)}</option>`;
const date = value => value ? new Date(value).toLocaleString() : '—';
const events = ['form.submitted','contact.opted_in','booking.confirmed','booking.changed','booking.cancelled'];
const labels = {'form.submitted':'Form submitted','contact.opted_in':'Email consent recorded','booking.confirmed':'Booking confirmed','booking.changed':'Booking changed','booking.cancelled':'Booking cancelled'};
const blank = {purpose:'marketing',startHour:9,endHour:18,steps:[{subject:'Hello {{firstName}}',document:[{type:'paragraph',content:[{text:'Thanks for contacting {{businessName}}.'}]}],anchor:'event',offsetMinutes:0}]};
function editorHtml(doc) {
 return doc.map(b=>`<${b.type==='heading'?'h2':'p'}>${b.type==='bullet'?'• ':''}${b.content.map(s=>{
  let text=esc(s.text); if(s.bold)text=`<strong>${text}</strong>`;if(s.italic)text=`<em>${text}</em>`;
  if(s.href && /^(https?:\/\/|mailto:)/i.test(s.href))text=`<a href="${esc(s.href)}">${text}</a>`;return text;
 }).join('')}</${b.type==='heading'?'h2':'p'}>`).join('');
}
function documentFromEditor(editor) {
 const blocks=[];
 function spans(node,bold=false,italic=false,href) {
  if(node.nodeType===3)return node.textContent?[{text:node.textContent,...(bold?{bold:true}:{}),...(italic?{italic:true}:{}),...(href?{href}:{})}]:[];
  if(node.nodeType!==1)return [];
  const tag=node.tagName.toLowerCase();
  if(tag==='br')return [{text:'\n'}];
  const link=tag==='a'?node.getAttribute('href'):href;
  return [...node.childNodes].flatMap(n=>spans(n,bold||['b','strong'].includes(tag),italic||['i','em'].includes(tag),link));
 }
 for(const node of editor.childNodes) {
  if(node.nodeType===1 && ['UL','OL'].includes(node.tagName)) {
   for(const li of node.children)blocks.push({type:'bullet',content:spans(li)});
  } else {
   const content=spans(node),bullet=node.textContent?.startsWith('• ');if(bullet&&content[0])content[0].text=content[0].text.replace(/^• /,'');if(content.length)blocks.push({type:node.nodeType===1 && /^H[1-6]$/.test(node.tagName)?'heading':bullet?'bullet':'paragraph',content});
  }
 }
 return blocks.length?blocks:[{type:'paragraph',content:[{text:''}]}];
}
export function mountEmailWorkspace(root,{request,staff=false}) {
 let data, tab='templates',selected=null,creating=false,disposed=false,page=1,editorDraft=null,draftName=null;
 const pending=new Map();
 const message = text => {const el=root.querySelector('[data-error]');if(el)el.textContent=text;};
 const call = async (action,input={}) => {
  if(disposed)throw new Error('Email workspace changed');
  const mutation=!['read','preview'].includes(action),signature=JSON.stringify([action,input]);
  if(mutation&&!pending.has(signature))pending.set(signature,crypto.randomUUID());
  const result=await request(action,mutation?{...input,idempotencyKey:pending.get(signature)}:input);
  pending.delete(signature);
  return result;
 };
 async function reload() { data=await call('read',{page});if(!disposed)paint(); }
 function collect() {
  const form=root.querySelector('[data-editor]'); if(!form)return editorDraft;
  draftName=form.elements.name.value;
  return {purpose:form.elements.purpose.value,startHour:Number(form.elements.startHour.value),endHour:Number(form.elements.endHour.value),steps:[...form.querySelectorAll('[data-step]')].map(el=>({subject:el.querySelector('[data-subject]').value,anchor:el.querySelector('[data-anchor]').value,offsetMinutes:Number(el.querySelector('[data-offset]').value),document:documentFromEditor(el.querySelector('[contenteditable]'))}))};
 }
 function editor() {
  const item=data.templates.find(t=>t.id===selected);const d=editorDraft || item?.draft || structuredClone(blank);
  return `<form data-editor><h3>${creating?'New template':esc(item?.name || 'Email template')}</h3><label>Template name<input name="name" maxlength="120" value="${esc(draftName ?? item?.name ?? '')}" required></label>
   <div class="email-grid"><label>Purpose<select name="purpose">${option('marketing','Marketing (email opt-in required)',d.purpose)}${option('service','Booking service (operational content only)',d.purpose)}</select></label><label>Send from hour<input name="startHour" type="number" min="0" max="23" value="${d.startHour}"></label><label>Until hour<input name="endHour" type="number" min="1" max="24" value="${d.endHour}"></label></div>
   <p>Personalize with {{name}}, {{firstName}}, {{email}}, {{businessName}}, {{appointment}}, {{request}}, {{service}}. Service emails must contain only information about the booking.</p>
   ${d.steps.map((s,i)=>`<fieldset data-step><legend>Email ${i+1}</legend><label>Subject<input data-subject maxlength="200" value="${esc(s.subject)}" required></label><div class="email-grid"><label>Timing<select data-anchor>${option('event','After triggering event',s.anchor)}${option('appointment','Relative to appointment',s.anchor)}</select></label><label>Offset in minutes (negative = before appointment)<input data-offset type="number" min="-525600" max="525600" value="${s.offsetMinutes}"></label></div><div class="email-toolbar"><button type="button" data-format="bold">Bold</button><button type="button" data-format="italic">Italic</button><button type="button" data-format="heading">Heading</button><button type="button" data-format="list">List</button><button type="button" data-format="link">Link</button><button type="button" data-remove="${i}">Remove email</button></div><div class="email-document" contenteditable="true" role="textbox" aria-multiline="true" aria-label="Email ${i+1} body">${editorHtml(s.document)}</div></fieldset>`).join('')}
   <div class="email-actions"><button type="button" data-add>Add email</button><button type="submit">Save draft</button>${!creating?'<button type="button" data-preview>Preview saved or edited draft</button><button type="button" data-publish>Publish saved draft</button><button type="button" data-duplicate>Duplicate</button><button type="button" data-archive>Archive</button>':''}</div><p>Publishing affects future runs. Existing runs keep their published content and timing.</p><div data-preview-output></div></form>`;
 }
 function templates() {
  return `<div class="email-actions"><button data-new>New template</button><select data-starter><option value="">Choose a starter…</option>${data.starters.map((s,i)=>option(String(i),s.name)).join('')}</select></div><div class="email-columns"><nav aria-label="Email templates">${data.templates.map(t=>`<button data-template="${t.id}" aria-pressed="${selected===t.id}">${esc(t.name)} ${t.archived?'(archived)':t.published_version?`· v${t.published_version}`:'· draft'}</button>`).join('')||'<p>No templates yet. Start with a ready-made sequence.</p>'}</nav><section>${creating||selected?editor():'<p>Select a template to edit its content and timing.</p>'}</section></div>`;
 }
 function connections() {
  return `<h3>Connect a template</h3><form data-connection><label>Published template<select name="templateId" required>${data.templates.filter(t=>t.published_version&&!t.archived).map(t=>option(t.id,t.name)).join('')}</select></label><label>When<select name="event">${events.map(e=>option(e,labels[e])).join('')}</select></label><label>Form (for form submissions)<select name="formId"><option value="">Choose form</option>${data.forms.map(f=>option(f.id,f.name)).join('')}</select></label><label><input type="checkbox" name="enabled"> Enable connection for future events</label><label><input type="checkbox" name="replaceLegacy"> Replace overlapping legacy email routing for future events</label><button type="submit">Save connection</button></form>
  <h3>Connections</h3>${data.connections.map(c=>`<p>${esc(labels[c.event])} → ${esc(data.templates.find(t=>t.id===c.template_id)?.name)} · ${c.enabled?'Enabled':'Disabled'} <button data-toggle="${c.id}">${c.enabled?'Disable':'Enable'}</button></p>`).join('')||'<p>No connections yet.</p>'}
  <h3>Form email consent</h3><p>Marketing sequences need a separate unchecked email consent box. Collection and SMS settings stay independent.</p>${data.forms.map(f=>`<p>${esc(f.name)} · ${f.emailEnabled?'Offered':'Not offered'} <button data-form-consent="${f.id}">${f.emailEnabled?'Stop offering':'Offer email consent'}</button></p>`).join('')}`;
 }
 function activity() {
  return `<h3>Start for one contact</h3><form data-start><label>Contact<select name="contactId">${data.contacts.map(c=>option(c.id,`${c.name||c.email} · ${c.email} · ${c.consent?'consented':'no recorded opt-in'}`)).join('')}</select></label><label>Published marketing template<select name="templateId">${data.templates.filter(t=>t.published_version&&!t.archived&&t.draft.purpose==='marketing').map(t=>option(t.id,t.name)).join('')}</select></label><label>Request context<input name="request" maxlength="1600"></label><button type="submit">Start sequence</button></form>
  <details><summary>Record existing email consent</summary><form data-consent><label>Contact<select name="contactId">${data.contacts.map(c=>option(c.id,`${c.name||c.email} · ${c.email}`)).join('')}</select></label><label>Evidence<textarea name="evidence" maxlength="1500" required></textarea></label><label><input type="checkbox" name="consent"> Customer has given email marketing consent</label><p>Recording consent can trigger an enabled contact connection. An unsubscribe remains suppressed and requires staff review.</p><button type="submit">Record choice</button></form></details>
  <h3>Email runs</h3><div class="email-table"><table><thead><tr><th>Recipient</th><th>Template</th><th>Status</th><th>Next email</th><th>Controls</th></tr></thead><tbody>${data.runs.map(r=>`<tr><td>${esc(r.name)}<br>${esc(r.email)}</td><td>${esc(data.templates.find(t=>t.id===r.template_id)?.name||'Template')} v${r.template_version}</td><td>${esc(r.status)} ${esc(r.pause_reason||'')}</td><td>${esc(date(r.next_run_at))}</td><td>${(r.status==='active'?['pause','stop']:r.status==='paused'?['resume','stop']:[]).map(a=>`<button data-run="${r.id}" data-action="${a}">${a}</button>`).join('')}</td></tr>`).join('')||'<tr><td colspan="5">No template runs.</td></tr>'}</tbody></table></div>
  <h3>Delivery activity</h3><div class="email-table"><table><thead><tr><th>Recipient</th><th>Subject</th><th>Delivery state</th><th>Issue</th></tr></thead><tbody>${data.jobs.map(j=>`<tr><td>${esc(j.email)}</td><td>${esc(j.subject||'Pending')}</td><td>${esc(j.provider_status|| (j.status==='sent'?'Accepted by provider':j.status))}</td><td>${esc(j.error_code||'—')}</td></tr>`).join('')||'<tr><td colspan="4">No deliveries yet.</td></tr>'}</tbody></table></div><div class="email-actions"><button data-page="-1" ${page===1?'disabled':''}>Previous</button><span>Page ${page}</span><button data-page="1" ${data.runs.length<25&&data.jobs.length<25?'disabled':''}>Next</button><button data-refresh>Refresh activity</button></div>`;
 }
 function settings() {
  const s=data.settings;
  return `<h3>Sender settings</h3><p>All senders use e2local.com. Your current sender: <strong>${esc(data.sender?.sender||'hello@e2local.com')}</strong>.</p><form data-settings><label>Sender domain<select name="domainId">${option('','e2local.com (default)',s.domain_id||'')}${data.domains.filter(d=>d.domain!=='e2local.com'&&d.status==='verified').map(d=>option(d.id,d.domain,s.domain_id)).join('')}</select></label><label>Reply-to mailbox<input name="replyTo" type="email" value="${esc(s.reply_to)}" required></label><label>Business mailing address<textarea name="mailingAddress" maxlength="300" required>${esc(s.mailing_address)}</textarea></label><label><input type="checkbox" name="enabled" ${s.enabled?'checked':''}> Enable email sending for this business</label><button type="submit">Save sender settings</button></form>
  <h3>Sender domains</h3>${data.domains.map(d=>`<p>${esc(d.domain)} · ${esc(d.status)} ${esc(d.error||'')}${staff?` <button data-domain="${d.id}">Check / resume setup</button>`:''}</p>`).join('')}${staff?'<form data-domain-create><label>Business subdomain<input name="slug" pattern="[a-z0-9][a-z0-9-]{0,61}[a-z0-9]" placeholder="opek" required> .e2local.com</label><button type="submit">Create sender subdomain</button></form>':'<p>Our team provisions and verifies business subdomains. Select your sender once verification is complete.</p>'}`;
 }
 function paint() {
  root.innerHTML=`<style>.email-workspace{font:inherit;line-height:1.5}.email-workspace label{display:block;margin:12px 0}.email-workspace input:not([type=checkbox]),.email-workspace select,.email-workspace textarea{display:block;box-sizing:border-box;width:100%;max-width:100%;padding:9px;border:1px solid #bdccd1;border-radius:6px;background:white;color:#173e4c;font:inherit}.email-workspace button{padding:8px 12px;margin:3px;border:1px solid #b4c7cc;border-radius:6px;background:#fff;color:#173e4c;cursor:pointer;font:inherit}.email-workspace button:disabled{opacity:.5;cursor:default}.email-workspace button[aria-pressed=true]{border-color:#087aa5;background:#087aa5;color:white}.email-workspace fieldset{margin:18px 0;padding:16px;border:1px solid #c7d5d9;border-radius:8px}.email-grid,.email-actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.email-grid>label{flex:1;min-width:160px}.email-columns{display:grid;grid-template-columns:minmax(160px,240px) minmax(0,1fr);gap:24px}.email-columns nav button{display:block;width:100%;text-align:left}.email-document{min-height:160px;padding:12px;border:1px solid #b4c7cc;border-radius:6px;background:white;color:#173e4c}.email-document p{margin:8px 0}.email-workspace table{width:100%;border-collapse:collapse}.email-workspace th,.email-workspace td{padding:10px;text-align:left;border-bottom:1px solid #d9e2e5}.email-table{overflow:auto}.email-workspace [role=alert]{color:#a02727}.email-workspace iframe{width:100%;height:440px;border:1px solid #c7d5d9;background:white}.email-workspace h2,.email-workspace h3{margin-top:20px}@media(max-width:720px){.email-columns{grid-template-columns:1fr}}</style><section class="email-workspace"><h2>Email automation</h2><p>Create reusable sequences, connect your forms and bookings, and follow delivery activity.</p><p data-error role="alert" aria-live="polite"></p><nav class="email-actions" aria-label="Email sections">${['templates','connections','activity','settings'].map(t=>`<button data-tab="${t}" aria-pressed="${tab===t}">${t[0].toUpperCase()+t.slice(1)}</button>`).join('')}</nav>${tab==='templates'?templates():tab==='connections'?connections():tab==='activity'?activity():settings()}</section>`;
  bind();
 }
 function run(fn) {return async event=>{event?.preventDefault();message('');const button=event?.submitter||event?.currentTarget;if(button?.tagName==='BUTTON')button.disabled=true;try{await fn(event);}catch(error){if(!disposed)message(error.message||'Email request failed');}finally{if(button?.tagName==='BUTTON')button.disabled=false;}};}
 function bind() {
  root.querySelectorAll('[data-tab]').forEach(b=>b.onclick=()=>{editorDraft=collect();tab=b.dataset.tab;paint();});
  root.querySelectorAll('[data-template]').forEach(b=>b.onclick=()=>{selected=b.dataset.template;creating=false;editorDraft=null;draftName=null;paint();});
  const on=(selector,event,fn)=>{const el=root.querySelector(selector);if(el)el.addEventListener(event,run(fn));};
  on('[data-new]','click',()=>{selected=null;creating=true;draftName=null;editorDraft=structuredClone(blank);paint();});
  on('[data-starter]','change',async e=>{if(e.target.value==='')return;const starter=data.starters[Number(e.target.value)];const saved=await call('create',{name:starter.name,definition:starter});selected=saved.id;creating=false;editorDraft=null;draftName=null;await reload();});
  on('[data-editor]','submit',async e=>{const item=data.templates.find(t=>t.id===selected);const saved=await call(creating?'create':'save',{...(item?{id:item.id,revision:item.revision}:{}),name:e.target.elements.name.value,definition:collect()});selected=saved.id;creating=false;editorDraft=null;await reload();});
  on('[data-add]','click',()=>{editorDraft=collect();if(editorDraft.steps.length>=30)throw new Error('Maximum 30 emails');editorDraft.steps.push(structuredClone(blank.steps[0]));paint();});
  root.querySelectorAll('[data-remove]').forEach(b=>b.onclick=()=>{editorDraft=collect();if(editorDraft.steps.length===1){message('Keep at least one email');return;}editorDraft.steps.splice(Number(b.dataset.remove),1);paint();});
  root.querySelectorAll('[data-format]').forEach(b=>b.addEventListener('mousedown',event=>{event.preventDefault();const cmd=b.dataset.format;if(cmd==='link'){const url=window.prompt('Link URL (https://…)');if(url&&/^(https?:\/\/|mailto:)/i.test(url))document.execCommand('createLink',false,url);}else document.execCommand(cmd==='heading'?'formatBlock':cmd==='list'?'insertUnorderedList':cmd,false,cmd==='heading'?'h2':undefined);}));
  root.querySelectorAll('[contenteditable]').forEach(el=>el.addEventListener('paste',e=>{e.preventDefault();document.execCommand('insertText',false,e.clipboardData.getData('text/plain'));}));
  for(const action of ['publish','duplicate','archive'])on(`[data-${action}]`,'click',async()=>{const item=data.templates.find(t=>t.id===selected);const saved=await call(action,{id:item.id,revision:item.revision});selected=saved.id;editorDraft=null;await reload();});
  on('[data-preview]','click',async()=>{const item=data.templates.find(t=>t.id===selected);const result=await call('preview',{id:item.id,revision:item.revision,definition:collect(),appointmentAt:new Date(Date.now()+7*86400000).toISOString()});const out=root.querySelector('[data-preview-output]');out.innerHTML=result.messages.map((m,i)=>`<h4>${esc(m.subject)}</h4><p>${esc(result.schedule[i]?.dueAt?date(result.schedule[i].dueAt):'Step skipped (no eligible time)')}</p><iframe sandbox title="Email ${i+1} preview"></iframe>`).join('');out.querySelectorAll('iframe').forEach((f,i)=>{f.srcdoc=result.messages[i].html;});});
  on('[data-connection]','submit',async e=>{const f=e.target.elements;await call('connection',{templateId:f.templateId.value,event:f.event.value,formId:f.event.value==='form.submitted'?f.formId.value:null,enabled:f.enabled.checked,replaceLegacy:f.replaceLegacy.checked});await reload();});
  root.querySelectorAll('[data-toggle]').forEach(b=>b.onclick=run(async()=>{const c=data.connections.find(c=>c.id===b.dataset.toggle);await call('connection',{id:c.id,revision:c.revision,templateId:c.template_id,event:c.event,formId:c.form_id,enabled:!c.enabled,replaceLegacy:c.replace_legacy});await reload();}));
  root.querySelectorAll('[data-form-consent]').forEach(b=>b.onclick=run(async()=>{const f=data.forms.find(f=>f.id===b.dataset.formConsent);await call('form_consent',{formId:f.id,revision:f.revision,enabled:!f.emailEnabled});await reload();}));
  on('[data-start]','submit',async e=>{const f=e.target.elements,c=data.contacts.find(c=>c.id===f.contactId.value);await call('start',{contactId:c.id,contactRevision:c.revision,templateId:f.templateId.value,request:f.request.value});await reload();});
  on('[data-consent]','submit',async e=>{const f=e.target.elements,c=data.contacts.find(c=>c.id===f.contactId.value);await call('consent',{contactId:c.id,contactRevision:c.revision,consent:f.consent.checked,evidence:f.evidence.value});await reload();});
  root.querySelectorAll('[data-run]').forEach(b=>b.onclick=run(async()=>{const r=data.runs.find(r=>r.id===b.dataset.run);await call(b.dataset.action,{runId:r.id,revision:r.revision,generation:r.generation});await reload();}));
  on('[data-settings]','submit',async e=>{const f=e.target.elements;await call('settings',{revision:data.settings.revision,domainId:f.domainId.value||null,replyTo:f.replyTo.value,mailingAddress:f.mailingAddress.value,enabled:f.enabled.checked});await reload();});
  root.querySelectorAll('[data-domain]').forEach(b=>b.onclick=run(async()=>{await call('sender',{id:b.dataset.domain});await reload();}));
  on('[data-domain-create]','submit',async e=>{await call('sender',{slug:e.target.elements.slug.value});await reload();});
  root.querySelectorAll('[data-page]').forEach(b=>b.onclick=run(async()=>{page+=Number(b.dataset.page);await reload();}));
  on('[data-refresh]','click',reload);
 }
 root.innerHTML='<p role="status">Loading email automation…</p>';
 reload().catch(error=>{if(!disposed)root.innerHTML=`<p role="alert">${esc(error.message)}</p><button data-retry>Try again</button>`;const button=root.querySelector('[data-retry]');if(button)button.onclick=()=>reload().catch(e=>message(e.message));});
 return ()=>{disposed=true;root.replaceChildren();};
}
