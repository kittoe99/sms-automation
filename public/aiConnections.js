const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
import {connectionPermissions} from './mcpPermissions.js';
export {connectionPermissions} from './mcpPermissions.js';
export async function mountAiConnections(root,{read,write,isCurrent=()=>true}) {
 let page=1,selected=null,activityPage=1,generation=0;
 const current=()=>isCurrent()&&root.querySelector('[data-ai-connections]');
 async function run(work){try{await work();}catch(error){if(current()&&error.name!=='AbortError')root.querySelector('[data-error]').textContent=error.message;}}
 async function directory(){
  const turn=++generation,data=await read('ai-connections',{page});if(!isCurrent()||turn!==generation)return;
  root.innerHTML=`<section class="card" data-ai-connections><h2>AI connections</h2><p>Connect Codex using the MCP server URL and your CRM sign-in. New connections appear here pending approval.</p><p>Grants apply to this staff member and OAuth client. Connections cannot grant themselves access.</p><p data-error role="alert"></p><div class="table-wrap"><table><thead><tr><th>Staff / client</th><th>Status</th><th>Last use</th><th></th></tr></thead><tbody>${data.connections.map(c=>`<tr><td>${esc(c.staff_name||c.subject)}<br><small>${esc(c.client_id)}</small></td><td>${esc(c.status)}</td><td>${esc(c.last_used_at?new Date(c.last_used_at).toLocaleString():'Never')}</td><td><button class="btn ghost" data-open="${esc(c.id)}">Manage</button></td></tr>`).join('')||'<tr><td colspan="4">No connections yet.</td></tr>'}</tbody></table></div><p>Page ${data.page} of ${data.totalPages}</p><button class="btn ghost" data-prev ${page<=1?'disabled':''}>Previous</button> <button class="btn ghost" data-next ${page>=data.totalPages?'disabled':''}>Next</button></section>`;
  root.querySelector('[data-prev]').onclick=()=>run(async()=>{page--;await directory();});root.querySelector('[data-next]').onclick=()=>run(async()=>{page++;await directory();});
  for(const button of root.querySelectorAll('[data-open]'))button.onclick=()=>run(async()=>{selected=data.connections.find(c=>c.id===button.dataset.open);activityPage=1;await editor();});
 }
 async function editor(){
  const c=selected,chosen=new Map(c.business_ids.map(id=>[id,c.business_labels?.[id]||id]));++generation;
  root.innerHTML=`<section class="card" data-ai-connections><button class="btn ghost" data-back>Back to connections</button><h2>${esc(c.staff_name||c.subject)}</h2><p style="overflow-wrap:anywhere">${esc(c.client_id)}</p><p data-error role="alert"></p><form data-grants><fieldset ${c.status==='revoked'?'disabled':''}><legend>Connection access</legend><label>Status <select name="status"><option value="active" ${c.status==='active'?'selected':''}>Active</option><option value="disabled" ${!['active','revoked'].includes(c.status)?'selected':''}>Disabled</option><option value="revoked" ${c.status==='revoked'?'selected':''}>Permanently revoked</option></select></label><p>${connectionPermissions.map(([key,label])=>`<label style="display:block"><input type="checkbox" name="permission" value="${key}" ${c.permissions.includes(key)?'checked':''}> ${label}</label>`).join('')}</p><h3>Permitted businesses</h3><div data-selected></div><label>Find businesses <input data-search maxlength="100"></label> <button type="button" class="btn ghost" data-find>Search</button><div data-business-results></div><p>Writes run directly within these grants. Revocation stops further calls and cannot be undone.</p><button class="btn" type="submit">Save access</button></fieldset></form><h3>Activity</h3><div data-activity></div></section>`;
  root.querySelector('[data-back]').onclick=()=>run(directory);
  root.querySelector('[data-selected]').insertAdjacentHTML('beforebegin',`<label style="display:block"><input type="checkbox" name="allBusinesses" ${c.all_businesses?'checked':''}> All businesses, including future registrations</label><p>Selections below apply when all-business access is off.</p>`);
  const renderSelected=()=>{root.querySelector('[data-selected]').innerHTML=[...chosen].map(([id,label])=>`<label style="display:block"><input type="checkbox" data-selected-business="${esc(id)}" checked ${c.status==='revoked'?'disabled':''}> ${esc(label)}</label>`).join('')||'<p>No individual businesses selected.</p>';for(const input of root.querySelectorAll('[data-selected-business]'))input.onchange=()=>{chosen.delete(input.dataset.selectedBusiness);root.querySelector('form').dataset.dirty='true';renderSelected();};};
  renderSelected();let searchTurn=0;
  root.querySelector('[data-find]').onclick=()=>run(async()=>{
   const turn=++searchTurn,g= generation;const data=await read('businesses',{q:root.querySelector('[data-search]').value,pageSize:25});if(!current()||g!==generation||turn!==searchTurn)return;
   const results=root.querySelector('[data-business-results]');results.innerHTML=data.rows.map(b=>`<button type="button" class="btn ghost" data-add="${esc(b.tenant_id||b.id)}">Add ${esc(b.name)}</button>`).join('')||'<p>No matching businesses.</p>';
   for(const button of results.querySelectorAll('[data-add]'))button.onclick=()=>{const b=data.rows.find(b=>(b.tenant_id||b.id)===button.dataset.add);chosen.set(button.dataset.add,b.name);root.querySelector('form').dataset.dirty='true';renderSelected();};
  });
  const form=root.querySelector('form');form.onchange=()=>{form.dataset.dirty='true';};
  form.onsubmit=event=>{event.preventDefault();const payload={connectionId:c.id,revision:c.revision,status:form.elements.status.value,permissions:[...form.querySelectorAll('[name="permission"]:checked')].map(x=>x.value),businessIds:[...chosen.keys()],allBusinesses:form.elements.allBusinesses.checked};const g=generation;form.querySelector('[type="submit"]').disabled=true;
   run(async()=>{try{const saved=await write('ai-connections',payload);if(current()&&g===generation){selected={...c,...saved.connection,business_labels:Object.fromEntries(chosen)};await editor();}}finally{if(current()&&g===generation)form.querySelector('[type="submit"]').disabled=false;}});
  };
  await activity();
 }
 async function activity(){
  const g=generation,data=await read('ai-connections/activity',{connectionId:selected.id,page:activityPage});if(!current()||g!==generation)return;
  const host=root.querySelector('[data-activity]');host.innerHTML=`<div class="table-wrap"><table><thead><tr><th>When</th><th>Action</th><th>Target</th><th>Outcome</th><th>Request</th></tr></thead><tbody>${data.activity.map(a=>`<tr><td>${esc(new Date(a.created_at).toLocaleString())}</td><td>${esc(a.tool)}</td><td>${esc(a.target)}</td><td>${esc(a.outcome)} ${esc(a.code||'')}</td><td>${esc(a.request_id)}</td></tr>`).join('')||'<tr><td colspan="5">No activity yet.</td></tr>'}</tbody></table></div><p>Page ${data.page} of ${data.totalPages}</p><button class="btn ghost" data-older ${activityPage>=data.totalPages?'disabled':''}>Older</button> <button class="btn ghost" data-newer ${activityPage<=1?'disabled':''}>Newer</button>`;
  host.querySelector('[data-older]').onclick=()=>run(async()=>{activityPage++;await activity();});host.querySelector('[data-newer]').onclick=()=>run(async()=>{activityPage--;await activity();});
 }
 await directory();
}
