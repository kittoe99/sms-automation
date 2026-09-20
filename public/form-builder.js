import {renderForm} from './form-renderer.js';
import {FIELD_TYPES,MAPPING_KEYS} from './form-schema.js';
const h=(tag,attrs={},text)=>{const el=document.createElement(tag);Object.assign(el,attrs);if(text!==undefined)el.textContent=text;return el;};
const button=(label,action,kind='btn ghost')=>{const b=h('button',{type:'button',className:kind},label);b.addEventListener('click',()=>Promise.resolve().then(action).catch(error=>alert(error.message)));return b;};
const input=(value,onChange,type='text')=>{const el=h('input',{type,value:value??''});el.addEventListener('change',()=>onChange(type==='checkbox'?el.checked:el.value));return el;};
const select=(value,options,onChange)=>{const el=h('select');for(const [id,name]of options)el.append(h('option',{value:id},name));el.value=value||'';el.addEventListener('change',()=>onChange(el.value));return el;};
const label=(name,control)=>{const el=h('label',{className:'fb-control'},name);el.append(control);return el;};
const area=(value,onChange,rows=3)=>{const el=h('textarea',{value:value||'',rows});el.addEventListener('change',()=>onChange(el.value));return el;};

export async function mountFormBuilder(root,{apiFetch,runtimeConfig}) {
  let disposed=false,form=null,catalog=null,dirty=false,agentRunning=false,cursor=0,streamAbort=null,mobile=false,history=[];
  const state=h('p',{className:'fb-notice'});state.setAttribute('role','status');
  const request=async(path='',method='GET',body,options={})=>{
    const response=await apiFetch('/api/forms'+path,{method,...options,...(body===undefined?{}:{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
    const result=await response.json();if(!response.ok)throw new Error(result.error||'Form request failed');return result;
  };
  const notice=text=>{state.textContent=text;};
  const changed=()=>{dirty=true;notice('Unsaved changes');};
  const confirmLeave=()=>!dirty||window.confirm('Discard unsaved form edits?');
  if(runtimeConfig.apiBase&&!runtimeConfig.formsApiBase) {
    root.replaceChildren(h('div',{className:'card fb-unavailable'},'Form Builder is awaiting connection.'));return ()=>{};
  }
  async function list() {
    streamAbort?.abort();form=null;cursor=0;dirty=false;
    const data=await request();if(disposed)return;
    root.replaceChildren();const header=h('div',{className:'fb-header'});
    header.append(h('p',{},'Describe what you need. AI builds the form and connects the right SMS follow-ups.'),button('Build with AI',async()=>{form=await request('','POST',{});await open(form.id);},'btn'));
    root.append(header,state);const cards=h('div',{className:'fb-form-list'});
    for(const item of data.forms){const card=h('article',{className:'card fb-form-card'});card.append(h('span',{className:'fb-badge'},item.published_version?'Published':'Draft'),h('h3',{},item.name),h('p',{},`${item.submission_count} submissions`),button('Edit form',()=>open(item.id)));cards.append(card);}
    if(!data.forms.length)cards.append(h('div',{className:'card fb-unavailable'},'Build your first form with AI. Describe the customer information you need and what should happen after submission.'));
    root.append(cards);
  }
  async function open(id) {
    streamAbort?.abort();cursor=0;dirty=false;history=[];
    [form,catalog]=await Promise.all([request('/'+id),request('/catalog')]);
    const session=await request(`/${id}/agent/session`);agentRunning=session.status==='running'&&Date.parse(session.authorized_until)>Date.now();
    if(disposed)return;draw();watch(id);
  }
  async function save() {
    const draft=form.draft;
    form=await request('/'+form.id,'PUT',{revision:form.revision,definition:draft,draftGroups:form.draft_groups});form.draft=draft;dirty=false;notice('Draft saved.');return form;
  }
  async function reload() {
    if(!confirmLeave())return;await open(form.id);notice('Loaded the latest saved draft.');
  }
  function draw() {
    if(disposed)return;const automationOpen=root.querySelector('.fb-automation')?.open||false;root.replaceChildren();const d=form.draft;d.instantSms||={enabled:false,body:''};
    const needsGeneration=!form.published_version&&!d.routing.defaultGroupId&&!form.draft_groups.length;
    const header=h('div',{className:'fb-header'}),actions=h('div',{className:'fb-actions'});
    header.append(h('div',{},''));header.firstChild.append(h('span',{className:'fb-badge'},form.published_version?'Published · editing draft':'Draft'),h('h2',{},d.title));
    actions.append(button('All forms',()=>{if(confirmLeave())return list();}));
    if(!needsGeneration) actions.append(button('Save',save),button('Publish',async()=>{
      await save();form=await request(`/${form.id}/publish`,'POST',{revision:form.revision});dirty=false;draw();notice('Published.');await embed();
    },'btn'));
    const more=h('details',{className:'fb-more'});more.append(h('summary',{},'More'));
    more.append(button('Reload saved form',reload));
    if(!needsGeneration)more.append(button('Test follow-ups',async()=>{
      await save();const result=await request(`/${form.id}/simulate`,'POST',{answers:preview.getAnswers()});showResult(result);
    }));
    if(form.published_version){actions.append(button('Embed code',embed));more.append(button('Unpublish',async()=>{if(!confirm('Stop accepting new submissions on this form?'))return;form=await request(`/${form.id}/unpublish`,'POST',{revision:form.revision});draw();notice('Unpublished.');}));}
    if(!needsGeneration)actions.append(more);
    header.append(actions);root.append(header,state);
    if(needsGeneration) {
      const start=h('section',{className:'card fb-ai-start'});
      start.append(h('span',{className:'fb-ai-kicker'},'AI FORM BUILDER'),h('h2',{},agentRunning?'Building your form and automations…':'What form should I build?'),h('p',{className:'muted'},agentRunning?'AI is reading your SMS app, creating the form, connecting follow-ups, and testing every route.':'AI will create the fields, find the matching SMS automations, configure routing and mappings, and test the setup.'));
      if(agentRunning){const progress=h('div',{className:'fb-chat-messages',id:'fb-chat-messages'});progress.setAttribute('aria-live','polite');for(const event of history)progress.append(eventNode(event));start.append(progress);root.append(start);return;}
      const starter=area('',()=>{},5);starter.placeholder='Example: Build a junk removal quote form. Ask whether the job is residential or commercial, collect photos later by text, and send commercial requests to our Commercial Follow-up automation.';starter.setAttribute('aria-label','Describe the form to build');
      const generate=button('Build form and connect automations',async()=>{
        const requestText=starter.value.trim();if(!requestText){starter.focus();notice('Describe the form you want AI to build.');return;}
        generate.disabled=true;generate.textContent='Building form and automations…';
        try{await request(`/${form.id}/agent/messages`,'POST',{message:`Build the complete form described below and automatically connect it to the appropriate SMS automations. Create or revise the fields, mappings, conditional visibility, and answer-based routing. Discover and reuse suitable live automation groups; draft a form-specific group only when needed. Validate the finished draft and simulate every route.\n\nUser request:\n${requestText}`});agentRunning=true;notice('AI is building the form and connecting SMS follow-ups.');draw();}
        catch(e){generate.disabled=false;generate.textContent='Build form and connect automations';throw e;}
      },'btn');
      const examples=h('div',{className:'fb-ai-examples'});for(const text of ['Lead capture form with an instant welcome follow-up','Quote form that routes commercial and residential requests differently'])examples.append(button(text,()=>{starter.value=text;starter.focus();},'fb-example'));
      start.append(starter,generate,examples);root.append(start);return;
    }
    const grid=h('div',{className:'fb-workspace'}),chat=h('section',{className:'card fb-chat'}),editor=h('section',{className:'card fb-editor'}),previewPanel=h('section',{className:'card fb-preview-panel'});
    chat.append(h('h3',{},agentRunning?'AI is building your form':'Refine with AI'));
    const messages=h('div',{className:'fb-chat-messages',id:'fb-chat-messages'});messages.setAttribute('aria-live','polite');
    for(const event of history)messages.append(eventNode(event));
    const prompt=area('',()=>{},3);prompt.placeholder='Ask AI to change the form or its follow-ups…';prompt.setAttribute('aria-label','Instructions for AI form builder');
    const ask=button(agentRunning?'Building…':'Apply change with AI',async()=>{
      const requestText=prompt.value.trim();if(!requestText){prompt.focus();return;}
      const message=`Revise the form and its connected SMS automations based on this request. Keep the form and automation wiring consistent, validate the result, and simulate affected routes.\n\nUser request:\n${requestText}`;
      ask.disabled=true;
      try{if(dirty)await save();await request(`/${form.id}/agent/messages`,'POST',{message});agentRunning=true;ask.textContent='Building…';prompt.value='';notice('AI is updating the form and its SMS follow-ups.');}
      catch(e){ask.disabled=false;throw e;}
    },'btn');ask.id='fb-ask';ask.disabled=agentRunning;
    prompt.addEventListener('input',()=>{if(!agentRunning)ask.textContent='Apply change with AI';});
    const conversation=h('details',{className:'fb-conversation'});conversation.append(h('summary',{},'AI conversation'),messages);
    chat.append(prompt,ask,conversation);
    editor.append(label('Form title',input(d.title,v=>{d.title=v;changed();refreshPreview();})));
    const settings=h('details',{className:'fb-field-editor'});settings.append(h('summary',{},'Appearance and messages'),label('Description',area(d.description,v=>{d.description=v;changed();refreshPreview();})),label('Button label',input(d.submitLabel,v=>{d.submitLabel=v;changed();refreshPreview();})),label('Success message',area(d.successMessage,v=>{d.successMessage=v;changed();})),label('Accent color',input(d.theme.color,v=>{d.theme.color=v;changed();refreshPreview();},'color')));editor.append(settings);
    editor.append(h('h3',{},'Fields'));
    d.fields.forEach((field,index)=>{
      const details=h('details',{className:'fb-field-editor'}),summary=h('summary',{},`${field.label} · ${field.type}`);details.append(summary);
      details.append(label('Label',input(field.label,v=>{field.label=v;changed();refreshPreview();})),label('Type',select(field.type,FIELD_TYPES.map(t=>[t,t]),v=>{field.type=v;if(['select','radio'].includes(v))field.options||=['Option 1','Option 2'];if(v==='consent'){field.disclosure||=d.fields.find(f=>f.type==='consent')?.disclosure||'I agree to receive follow-up texts. Reply STOP to opt out.';field.required=false;delete field.visibleWhen;}changed();draw();})),label('Help text',input(field.help,v=>{field.help=v;changed();refreshPreview();})));
      if(field.type==='consent')details.append(label('Consent disclosure',area(field.disclosure,v=>{field.disclosure=v;changed();refreshPreview();},5)));
      else {const checkbox=input('',v=>{field.required=v;changed();refreshPreview();},'checkbox');checkbox.checked=field.required;details.append(label('Required',checkbox));}
      if(['select','radio'].includes(field.type))details.append(label('Options (one per line)',area((field.options||[]).join('\n'),v=>{field.options=v.split('\n').map(s=>s.trim()).filter(Boolean);changed();refreshPreview();})));
      if(index>0&&field.type!=='consent')details.append(conditionEditor(field.visibleWhen,d.fields.slice(0,index),v=>{field.visibleWhen=v;changed();refreshPreview();},true));
      const buttons=h('div',{className:'fb-actions'});buttons.append(button('Move up',()=>{if(index){[d.fields[index-1],d.fields[index]]=[d.fields[index],d.fields[index-1]];changed();draw();}}),button('Remove',()=>{d.fields.splice(index,1);changed();draw();}));details.append(buttons);editor.append(details);
    });
    editor.append(button('Add field',()=>{d.fields.push({id:'field_'+crypto.randomUUID().slice(0,8),type:'text',label:'New question',required:false});changed();draw();}));
    const mappings=h('details',{className:'fb-field-editor'});mappings.append(h('summary',{},'Contact and service mappings'));
    for(const key of MAPPING_KEYS)mappings.append(label(key.replaceAll('_',' '),select(d.mappings[key],[['','Not mapped'],...d.fields.map(f=>[f.id,f.label])],v=>{if(v)d.mappings[key]=v;else delete d.mappings[key];changed();})));
    const automation=h('details',{className:'fb-field-editor fb-automation',open:automationOpen});
    const defaultGroup=[...catalog.groups,...form.draft_groups].find(g=>g.id===d.routing.defaultGroupId);
    automation.append(h('summary',{},'Adjust automations'),h('p',{className:'muted'},defaultGroup?`Follow-up: ${defaultGroup.name}${d.routing.rules.length?` · ${d.routing.rules.length} routing rules`:''}`:'Use AI to connect follow-ups for this form.'),mappings);
    editor.append(automation);
    const groups=[...catalog.groups.filter(g=>g.active&&g.kind!=='reminder'),...form.draft_groups.map(g=>({...g,version:1,draft:true}))];
    const options=[['','Choose automation'],...groups.map(g=>[g.id,g.name+(g.draft?' (draft)':'')])];
    const review=id=>{const g=groups.find(g=>g.id===id);if(g&&!g.draft)d.routing.reviewedVersions[id]=Number(g.version);};
    automation.append(label('Default group',select(d.routing.defaultGroupId,options,v=>{d.routing.defaultGroupId=v;review(v);changed();draw();})));
    const instant=input('',v=>{d.instantSms.enabled=v;if(v&&!d.instantSms.body)d.instantSms.body='Thanks {{name}} — we received your {{service_name}} request and will follow up shortly.';changed();draw();},'checkbox');instant.checked=d.instantSms.enabled;
    automation.append(label('Send an instant SMS before the automation',instant));
    if(d.instantSms.enabled) automation.append(label('Instant SMS message',area(d.instantSms.body,v=>{d.instantSms.body=v;changed();},4)),h('p',{className:'muted'},'Available mapped values: {{name}}, {{email}}, {{service_name}}, {{service_address}}, {{preferred_date}}, {{details}}. The automation starts one minute later.'));
    d.routing.rules.forEach((rule,i)=>{const card=h('div',{className:'fb-route'});card.append(h('strong',{},`Rule ${i+1}`),conditionEditor(rule.when,d.fields,v=>{rule.when=v;changed();},false),label('Automation',select(rule.groupId,options,v=>{rule.groupId=v;review(v);changed();draw();})),button('Remove rule',()=>{d.routing.rules.splice(i,1);changed();draw();}));automation.append(card);});
    automation.append(button('Add routing rule',()=>{const field=d.fields.find(f=>!['consent','checkbox'].includes(f.type));d.routing.rules.push({when:{field:field.id,operator:'eq',value:''},groupId:d.routing.defaultGroupId});changed();draw();}));
    for(const id of new Set([d.routing.defaultGroupId,...d.routing.rules.map(r=>r.groupId)])) {
      const group=groups.find(g=>g.id===id);if(!group)continue;
      const details=h('details',{className:'fb-field-editor'});details.append(h('summary',{},group.name+(group.draft?' · new draft':` · version ${group.version}`)));
      const ol=h('ol');for(const s of group.rule?.steps||[])ol.append(h('li',{},`${s.delayCount} ${s.delayUnit}(s): ${s.template}`));details.append(ol);
      if(!group.draft)details.append(button('Use this reviewed version',()=>{review(id);changed();notice(`${group.name} version ${group.version} reviewed. Save to retain.`);}));automation.append(details);
    }
    for(const group of form.draft_groups) {
      automation.append(button(`Discard draft: ${group.name}`,()=>{form.draft_groups=form.draft_groups.filter(g=>g.id!==group.id);if(d.routing.defaultGroupId===group.id)d.routing.defaultGroupId='';d.routing.rules=d.routing.rules.filter(r=>r.groupId!==group.id);changed();draw();}));
    }
    const website=h('details',{className:'fb-field-editor'});website.append(h('summary',{},'Website settings'));editor.append(website);
    website.append(label('Allowed website origins (one per line)',area(d.allowedOrigins.join('\n'),v=>{d.allowedOrigins=v.split('\n').map(s=>s.trim()).filter(Boolean);changed();})),h('p',{className:'muted'},'Example: https://yourwebsite.com — use the exact origin without a trailing slash.'));
    previewPanel.append(h('h3',{},'Live preview'),button(mobile?'Desktop preview':'Mobile preview',()=>{mobile=!mobile;draw();}));
    const previewRoot=h('div',{className:mobile?'fb-preview mobile':'fb-preview'}),result=h('pre',{className:'fb-test-result'});previewPanel.append(previewRoot,result);
    let preview;
    function showResult(r){result.textContent=`${r.eligible?'Eligible for enrollment':'Enrollment blocked'}\n${r.instantSms?.enabled?'Instant SMS: queued before automation\n':''}Group: ${r.groupName||r.groupId||'Not selected'}\n${r.note}\n${r.validation.errors.join('\n')}`;}
    function refreshPreview(){preview=renderForm(previewRoot,d,{preview:true,onSubmit:async answers=>{await save();const r=await request(`/${form.id}/simulate`,'POST',{answers});showResult(r);return 'Simulation finished. No SMS sent.';}});}
    const controls=h('div',{className:'fb-controls'});controls.append(chat,editor);grid.append(controls,previewPanel);root.append(grid);refreshPreview();
    const submissions=h('details',{className:'card fb-submissions'});submissions.append(h('summary',{},'Submissions'),button('Refresh submissions',()=>loadSubmissions(submissions)));root.append(submissions);submissions.addEventListener('toggle',()=>{if(submissions.open)loadSubmissions(submissions).catch(e=>notice(e.message));});
  }
  function conditionEditor(value,fields,onChange,optional) {
    const box=h('div',{className:'fb-condition'});let c=value?structuredClone(value):{field:fields[0]?.id||'',operator:'eq',value:''};
    const update=()=>onChange(c.field?structuredClone(c):undefined);
    box.append(label(optional?'Show when':'When',select(value?.field||'',[[...(optional?['','Always visible']:['','Choose field'])],...fields.map(f=>[f.id,f.label])],v=>{c.field=v;update();})),select(c.operator,[['eq','equals'],['neq','does not equal'],['in','is one of'],['contains','contains']],v=>{c.operator=v;update();}),input(Array.isArray(c.value)?c.value.join(', '):String(c.value),v=>{const f=fields.find(f=>f.id===c.field);const parse=x=>['checkbox','consent'].includes(f?.type)?x==='true':f?.type==='number'?Number(x):x;c.value=c.operator==='in'?v.split(',').map(x=>parse(x.trim())):parse(v);update();}));
    return box;
  }
  async function loadSubmissions(section) {
    const data=await request(`/${form.id}/submissions`);if(disposed||!section.isConnected)return;section.querySelector('.fb-log')?.remove();const log=h('div',{className:'fb-log'});
    if(!data.submissions.length)log.append(h('p',{className:'muted'},'No submissions yet. Preview tests do not create submissions.'));
    for(const s of data.submissions){const row=h('details');row.append(h('summary',{},`${new Date(s.created_at).toLocaleString()} · ${s.mapped.name||s.mapped.phone} · ${s.status}${s.reason?' · '+s.reason:''}`),h('pre',{},JSON.stringify(s.answers,null,2)));if(s.status==='failed')row.append(button('Retry processing',async()=>{await request(`/${form.id}/submissions/${s.id}/retry`,'POST',{});await loadSubmissions(section);}));log.append(row);}section.append(log);
  }
  async function embed() {
    const data=await request(`/${form.id}/embed`),dialog=h('dialog',{className:'fb-embed-dialog'});dialog.append(h('h3',{},'Embed this form'),h('p',{},'Paste this snippet into your website’s HTML block.'),h('textarea',{value:data.snippet,readOnly:true,rows:4}),h('a',{href:data.url,target:'_blank',rel:'noopener'},'Open hosted form'),button('Copy snippet',async()=>{await navigator.clipboard.writeText(data.snippet);notice('Embed code copied.');}),button('Close',()=>{dialog.close();dialog.remove();}));document.body.append(dialog);dialog.showModal();
  }
  async function watch(id) {
    const abort=new AbortController();streamAbort=abort;
    while(!disposed&&!abort.signal.aborted&&form?.id===id) {
      try {
        const res=await apiFetch(`/api/forms/${id}/agent/events?after=${cursor}`,{signal:abort.signal});if(!res.ok)throw new Error('Agent progress connection unavailable');
        const reader=res.body.getReader(),decoder=new TextDecoder();let buffer='';
        while(true){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let end;
          while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);const line=frame.split('\n').find(l=>l.startsWith('data: '));if(!line)continue;
            const event=JSON.parse(line.slice(6));cursor=Number(event.id);const messages=root.querySelector('#fb-chat-messages');
            if(['user_message','agent_message','agent_failed'].includes(event.event)){history.push(event);messages?.append(eventNode(event));if(messages)messages.scrollTop=messages.scrollHeight;}
            if(['agent_completed','agent_failed'].includes(event.event)) {
              agentRunning=false;const ask=root.querySelector('#fb-ask');if(ask){ask.disabled=false;ask.textContent='Apply change with AI';}
              notice(event.event==='agent_completed'?'AI finished.':'AI could not finish. Your saved draft is preserved.');
              if(!dirty && !abort.signal.aborted && form?.id===id) {
                const saved=await request('/'+id);
                if(!dirty&&!abort.signal.aborted&&saved.revision!==form.revision){form=saved;catalog=await request('/catalog');draw();notice('Form and follow-ups updated. Review when ready.');}
              }
            }
          }
        }
      } catch(error){if(abort.signal.aborted)return;notice(error.message);await new Promise(resolve=>setTimeout(resolve,3000));}
    }
  }
  function eventNode(event){return h('p',{className:'fb-chat-'+event.event},event.event==='tool'?'Using '+event.detail.name:event.detail.text||event.detail.message);}
  const beforeUnload=e=>{if(dirty){e.preventDefault();e.returnValue='';}};window.addEventListener('beforeunload',beforeUnload);
  try{await list();}catch(e){root.replaceChildren(h('div',{className:'card fb-unavailable'},e.message));}
  return ()=>{disposed=true;streamAbort?.abort();window.removeEventListener('beforeunload',beforeUnload);};
}
