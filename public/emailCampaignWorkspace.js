/* global crypto, window */
// Staff workspace for one-to-many email campaigns and saved segments.
// Campaigns reuse published marketing templates; consent, unsubscribe and provider
// suppression are enforced by the database before every message is sent.
const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const option = (value,label,selected) => `<option value="${esc(value)}" ${String(value)===String(selected??'')?'selected':''}>${esc(label)}</option>`;
const date = value => value ? new Date(value).toLocaleString() : '—';
const localInput = value => {if(!value)return '';const d=new Date(value);d.setMinutes(d.getMinutes()-d.getTimezoneOffset());return d.toISOString().slice(0,16);};
const FIELDS = {source:'Contact source is',createdWithinDays:'Added within the last (days)',createdOlderThanDays:'Added more than (days) ago',emailDomain:'Email domain is'};
const REASONS = {NO_CONSENT:'No recorded email consent',UNSUBSCRIBED:'Unsubscribed from this business',PROVIDER_SUPPRESSED:'Bounced, complained or suppressed'};
const STATUS = {draft:'Draft',scheduled:'Scheduled',sending:'Sending',paused:'Paused',completed:'Completed',cancelled:'Cancelled'};
const emptySegment = () => ({match:'all',rules:[]});
// Same base look as the Email automation workspace (kept separate so that paired module stays unchanged).
const BASE_STYLE = '.email-workspace{font:inherit;line-height:1.5}.email-workspace label{display:block;margin:12px 0}.email-workspace input:not([type=checkbox]),.email-workspace select{display:block;box-sizing:border-box;width:100%;max-width:100%;padding:9px;border:1px solid #bdccd1;border-radius:6px;background:white;color:#173e4c;font:inherit}.email-workspace button{padding:8px 12px;margin:3px;border:1px solid #b4c7cc;border-radius:6px;background:#fff;color:#173e4c;cursor:pointer;font:inherit}.email-workspace button:disabled{opacity:.5;cursor:default}.email-workspace button[aria-pressed=true]{border-color:#087aa5;background:#087aa5;color:white}.email-workspace fieldset{margin:18px 0;padding:16px;border:1px solid #c7d5d9;border-radius:8px}.email-grid,.email-actions{display:flex;gap:12px;flex-wrap:wrap;align-items:center}.email-grid>label{flex:1;min-width:160px}.email-columns{display:grid;grid-template-columns:minmax(160px,240px) minmax(0,1fr);gap:24px}.email-columns nav button{display:block;width:100%;text-align:left}.email-workspace table{width:100%;border-collapse:collapse}.email-workspace th,.email-workspace td{padding:10px;text-align:left;border-bottom:1px solid #d9e2e5;overflow-wrap:anywhere}.email-table{overflow:auto}.email-workspace [role=alert]{color:#a02727}.email-workspace h2,.email-workspace h3{margin-top:20px}@media(max-width:720px){.email-columns{grid-template-columns:1fr}}';

export function summarizeCounts(counts={}) {
 const m=counts.messages||{},sent=m.sent||0,rate=n=>sent?`${Math.round(n*1000/sent)/10}%`:'—';
 return {recipients:counts.recipients||0,queued:counts.queued||0,skipped:Object.values(counts.skipped||{}).reduce((a,b)=>a+b,0),
  sent,pending:m.pending||0,delivered:m.delivered||0,bounced:m.bounced||0,complained:m.complained||0,failed:m.failed||0,
  opened:m.opened||0,clicked:m.clicked||0,unsubscribed:counts.unsubscribed||0,openRate:rate(m.opened||0),clickRate:rate(m.clicked||0)};
}

export function mountEmailCampaignWorkspace(root,{request}) {
 let data,tab='campaigns',selected=null,segmentId=null,creating=false,segmentDraft=null,report=null,reportPage=1,disposed=false;
 const pending=new Map();
 const message = text => {const el=root.querySelector('[data-error]');if(el)el.textContent=text;};
 const call = async (action,input={}) => {
  if(disposed)throw new Error('Campaign workspace changed');
  const mutation=!['read','segment_preview','campaign_preview'].includes(action),signature=JSON.stringify([action,input]);
  if(mutation&&!pending.has(signature))pending.set(signature,crypto.randomUUID());
  const result=await request(action,mutation?{...input,idempotencyKey:pending.get(signature)}:input);
  pending.delete(signature);
  return result;
 };
 async function reload() {
  data=await call('read');
  if(selected&&data.campaigns.some(c=>c.id===selected))report=await call('read',{campaignId:selected,page:reportPage});else report=null;
  if(!disposed)paint();
 }
 const campaign = () => data.campaigns.find(c=>c.id===selected);
 const segmentName = id => data.segments.find(s=>s.id===id)?.name || 'Archived segment';
 const templateName = id => data.templates.find(t=>t.id===id)?.name || 'Template';
 function breakdown(result) {
  return `<p><strong>${result.eligible}</strong> of ${result.total} contacts with an email address can receive this campaign.</p>${Object.entries(result.skipped||{}).map(([k,n])=>`<p>${esc(REASONS[k]||k)}: ${n}</p>`).join('')}${result.sample?.length?`<p>Sample: ${result.sample.map(s=>esc(s.name?`${s.name} <${s.email}>`:s.email)).join(', ')}</p>`:''}`;
 }
 function campaignEditor() {
  const c=creating?{name:'',template_id:'',segment_id:'',scheduled_at:null}:campaign();
  return `<form data-campaign><h3>${creating?'New campaign':esc(c.name)}</h3><label>Campaign name<input name="name" maxlength="120" value="${esc(c.name)}" required></label>
   <label>Published marketing template<select name="templateId"><option value="">Choose template…</option>${data.templates.map(t=>option(t.id,`${t.name} · v${t.version}${t.steps>1?` · ${t.steps} emails`:''}`,c.template_id)).join('')}</select></label>
   <label>Segment<select name="segmentId"><option value="">Choose segment…</option>${data.segments.map(s=>option(s.id,s.name,c.segment_id)).join('')}</select></label>
   <label>Send at (your local time; leave empty to send when started)<input name="scheduledAt" type="datetime-local" value="${esc(localInput(c.scheduled_at))}"></label>
   <p>Only contacts with recorded email consent receive the campaign. Unsubscribed and bounced addresses are skipped, and sending hours from the template apply.</p>
   <div class="email-actions"><button type="submit">Save draft</button>${creating?'':'<button type="button" data-campaign-preview>Check recipients</button><button type="button" data-campaign-action="campaign_start">Start campaign</button><button type="button" data-campaign-action="campaign_cancel">Discard draft</button>'}</div><div data-preview-output></div></form>`;
 }
 function reportView() {
  const c=campaign(),s=summarizeCounts(report.campaign.counts),controls={scheduled:['campaign_pause','campaign_cancel'],sending:['campaign_pause','campaign_cancel'],paused:['campaign_resume','campaign_cancel']}[c.status]||[];
  const label={campaign_pause:'Pause',campaign_resume:'Resume',campaign_cancel:'Cancel campaign'};
  const tile=(name,value)=>`<div class="campaign-tile"><span>${esc(name)}</span><strong>${esc(value)}</strong></div>`;
  return `<h3>${esc(c.name)} · ${esc(STATUS[c.status])}</h3><p>${esc(templateName(c.template_id))} v${c.template_version} to ${esc(segmentName(c.segment_id))}. ${c.status==='scheduled'?`Scheduled for ${esc(date(c.scheduled_at))}.`:`Started ${esc(date(c.started_at))}.`}</p>
   <div class="email-actions">${controls.map(a=>`<button data-campaign-action="${a}">${label[a]}</button>`).join('')}<button data-refresh>Refresh</button></div>
   <div class="campaign-tiles">${tile('Recipients',s.queued)}${tile('Skipped',s.skipped)}${tile('Accepted by provider',s.sent)}${tile('Waiting',s.pending)}${tile('Delivered',s.delivered)}${tile('Opened',`${s.opened} (${s.openRate})`)}${tile('Clicked',`${s.clicked} (${s.clickRate})`)}${tile('Bounced',s.bounced)}${tile('Complaints',s.complained)}${tile('Unsubscribed',s.unsubscribed)}${tile('Failed',s.failed)}</div>
   <p>Opens are estimates: some mail apps load images automatically. Open and click counts appear only when tracking is enabled for the sender domain.</p>
   ${Object.keys(report.campaign.counts.skipped||{}).length?`<h4>Skipped at start</h4>${Object.entries(report.campaign.counts.skipped).map(([k,n])=>`<p>${esc(REASONS[k]||k)}: ${n}</p>`).join('')}`:''}
   ${report.links.length?`<h4>Top links</h4><div class="email-table"><table><thead><tr><th>Link</th><th>Clicks</th></tr></thead><tbody>${report.links.map(l=>`<tr><td>${esc(l.url)}</td><td>${l.clicks}</td></tr>`).join('')}</tbody></table></div>`:''}
   <h4>Recipients</h4><div class="email-table"><table><thead><tr><th>Email</th><th>Status</th><th>Delivery</th></tr></thead><tbody>${report.recipients.map(r=>`<tr><td>${esc(r.email)}</td><td>${esc(r.status==='skipped'?REASONS[r.skip_reason]||r.skip_reason:r.run_status)}</td><td>${esc(r.delivery||'—')}</td></tr>`).join('')||'<tr><td colspan="3">No recipients.</td></tr>'}</tbody></table></div>
   <div class="email-actions"><button data-report-page="-1" ${reportPage===1?'disabled':''}>Previous</button><span>Page ${reportPage}</span><button data-report-page="1" ${report.recipients.length<100?'disabled':''}>Next</button></div>`;
 }
 function campaigns() {
  const c=campaign();
  const sender=data.sender||{},ready=sender.enabled&&sender.ready;
  return `${ready?'':'<p role="note"><strong>Email sending is not active for this business.</strong> Enable sending with a verified sender and mailing address in Email Settings before starting a campaign.</p>'}
   <div class="email-actions"><button data-new-campaign>New campaign</button></div><div class="email-columns"><nav aria-label="Campaigns">${data.campaigns.map(x=>{const s=summarizeCounts(x.counts);return `<button data-campaign-id="${x.id}" aria-pressed="${selected===x.id}">${esc(x.name)}<br><small>${esc(STATUS[x.status])}${x.status==='draft'?'':` · ${s.sent}/${s.queued} sent`}</small></button>`;}).join('')||'<p>No campaigns yet.</p>'}</nav>
   <section>${creating||c?.status==='draft'?campaignEditor():c&&report?reportView():'<p>Select a campaign, or create one from a published marketing template and a segment.</p>'}</section></div>`;
 }
 function segmentEditor() {
  const s=data.segments.find(x=>x.id===segmentId),d=segmentDraft||s?.definition||emptySegment();
  return `<form data-segment><h3>${s?esc(s.name):'New segment'}</h3><label>Segment name<input name="name" maxlength="120" value="${esc(s?.name||'')}" required></label>
   <label>Contacts must match<select name="match">${option('all','All rules',d.match)}${option('any','Any rule',d.match)}</select></label>
   ${d.rules.map((r,i)=>`<fieldset data-rule><legend>Rule ${i+1}</legend><div class="email-grid"><label>Field<select data-field>${Object.entries(FIELDS).map(([k,v])=>option(k,v,r.field)).join('')}</select></label><label>Value${r.field==='source'&&data.sources.length?`<select data-value>${data.sources.map(x=>option(x,x,r.value)).join('')}</select>`:`<input data-value value="${esc(r.value??'')}" ${['createdWithinDays','createdOlderThanDays'].includes(r.field)?'type="number" min="1" max="3650"':''}>`}</label></div><button type="button" data-remove-rule="${i}">Remove rule</button></fieldset>`).join('')||'<p>No rules: every contact with an email address.</p>'}
   <div class="email-actions"><button type="button" data-add-rule>Add rule</button><button type="button" data-segment-preview>Preview</button><button type="submit">Save segment</button>${s?'<button type="button" data-segment-archive>Archive</button>':''}</div><div data-preview-output></div></form>`;
 }
 function collectSegment() {
  const form=root.querySelector('[data-segment]');if(!form)return segmentDraft;
  return {match:form.elements.match.value,rules:[...form.querySelectorAll('[data-rule]')].map(el=>{const field=el.querySelector('[data-field]').value,raw=el.querySelector('[data-value]').value;
   return {field,value:['createdWithinDays','createdOlderThanDays'].includes(field)?Number(raw):raw.trim()};})};
 }
 function segments() {
  return `<div class="email-actions"><button data-new-segment>New segment</button></div><div class="email-columns"><nav aria-label="Segments">${data.segments.map(s=>`<button data-segment-id="${s.id}" aria-pressed="${segmentId===s.id}">${esc(s.name)}</button>`).join('')||'<p>No segments yet.</p>'}</nav><section>${segmentId||segmentDraft?segmentEditor():'<p>Segments pick contacts by source, how recently they were added, or email domain. Consent is always required at send time.</p>'}</section></div>`;
 }
 function paint() {
  root.innerHTML=`<style>${BASE_STYLE}.campaign-tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:10px;margin:14px 0}.campaign-tile{padding:10px 12px;border:1px solid #c7d5d9;border-radius:8px}.campaign-tile span{display:block;font-size:13px;color:#4d6670}.campaign-tile strong{font-size:20px}.email-workspace [role=note]{padding:10px 12px;border-radius:6px;background:#fff6e5}</style><section class="email-workspace"><h2>Email campaigns</h2><p>Send a published marketing template to a saved segment of opted-in contacts, and follow delivery, opens and clicks.</p><p data-error role="alert" aria-live="polite"></p><nav class="email-actions" aria-label="Campaign sections">${['campaigns','segments'].map(t=>`<button data-tab="${t}" aria-pressed="${tab===t}">${t[0].toUpperCase()+t.slice(1)}</button>`).join('')}</nav>${tab==='campaigns'?campaigns():segments()}</section>`;
  bind();
 }
 function run(fn) {return async event=>{event?.preventDefault();message('');const button=event?.submitter||event?.currentTarget;if(button?.tagName==='BUTTON')button.disabled=true;try{await fn(event);}catch(error){if(!disposed)message(error.message||'Campaign request failed');}finally{if(button?.tagName==='BUTTON')button.disabled=false;}};}
 function bind() {
  const on=(selector,event,fn)=>root.querySelectorAll(selector).forEach(el=>el.addEventListener(event,run(fn)));
  on('[data-tab]','click',e=>{tab=e.currentTarget.dataset.tab;paint();});
  on('[data-new-campaign]','click',()=>{creating=true;selected=null;report=null;paint();});
  on('[data-campaign-id]','click',async e=>{creating=false;selected=e.currentTarget.dataset.campaignId;reportPage=1;await reload();});
  on('[data-campaign]','submit',async e=>{const f=e.target.elements,c=creating?null:campaign();
   const saved=await call('campaign_save',{...(c?{id:c.id,revision:c.revision}:{}),name:f.name.value,templateId:f.templateId.value||null,segmentId:f.segmentId.value||null,scheduledAt:f.scheduledAt.value?new Date(f.scheduledAt.value).toISOString():null});
   creating=false;selected=saved.id;await reload();});
  on('[data-campaign-preview]','click',async()=>{const c=campaign();const result=await call('campaign_preview',{id:c.id});root.querySelector('[data-preview-output]').innerHTML=breakdown(result);});
  on('[data-campaign-action]','click',async e=>{const c=campaign(),action=e.currentTarget.dataset.campaignAction;
   if(action==='campaign_start'){const preview=await call('campaign_preview',{id:c.id});if(!window.confirm(`Start "${c.name}"? This sends real email to up to ${preview.eligible} opted-in contacts${c.scheduled_at&&new Date(c.scheduled_at)>new Date()?` at ${date(c.scheduled_at)}`:' now'}.`))return;}
   if(action==='campaign_cancel'&&!window.confirm(c.status==='draft'?'Discard this draft campaign?':'Cancel this campaign? Messages not yet sent will not be sent.'))return;
   await call(action,{id:c.id,revision:c.revision});await reload();});
  on('[data-refresh]','click',reload);
  on('[data-report-page]','click',async e=>{reportPage=Math.max(1,reportPage+Number(e.currentTarget.dataset.reportPage));await reload();});
  on('[data-new-segment]','click',()=>{segmentId=null;segmentDraft=emptySegment();paint();});
  on('[data-segment-id]','click',e=>{segmentId=e.currentTarget.dataset.segmentId;segmentDraft=null;paint();});
  on('[data-add-rule]','click',()=>{segmentDraft=collectSegment();if(segmentDraft.rules.length>=20)throw new Error('Maximum 20 rules');segmentDraft.rules.push({field:'createdWithinDays',value:90});paint();});
  on('[data-remove-rule]','click',e=>{segmentDraft=collectSegment();segmentDraft.rules.splice(Number(e.currentTarget.dataset.removeRule),1);paint();});
  on('[data-field]','change',()=>{segmentDraft=collectSegment();paint();});
  on('[data-segment-preview]','click',async()=>{const result=await call('segment_preview',{definition:collectSegment()});root.querySelector('[data-preview-output]').innerHTML=breakdown(result);});
  on('[data-segment]','submit',async e=>{const s=data.segments.find(x=>x.id===segmentId);const saved=await call('segment_save',{...(s?{id:s.id,revision:s.revision}:{}),name:e.target.elements.name.value,definition:collectSegment()});segmentId=saved.id;segmentDraft=null;await reload();});
  on('[data-segment-archive]','click',async()=>{const s=data.segments.find(x=>x.id===segmentId);if(!window.confirm(`Archive segment "${s.name}"?`))return;await call('segment_archive',{id:s.id,revision:s.revision});segmentId=null;await reload();});
 }
 root.innerHTML='<p role="status">Loading campaigns…</p>';
 reload().catch(error=>{if(!disposed)root.innerHTML=`<p role="alert">${esc(error.message)}</p>`;});
 return ()=>{disposed=true;root.replaceChildren();};
}
