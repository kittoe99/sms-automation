const statuses={received:'Received',in_progress:'In progress',needs_info:'Needs information',completed:'Completed'};
export function requestMarkup(request,escape,date){
 return `<form data-update-request="${escape(request.id)}" class="card compose">
  <h3>${escape(request.title)}</h3><p>${escape(request.category)} · ${escape(date(request.created_at))}</p>
  ${request.page?`<p><strong>Page:</strong> ${escape(request.page)}</p>`:''}
  <p style="white-space:pre-wrap;overflow-wrap:anywhere">${escape(request.description)}</p>
  <label>Status<select name="status">${Object.entries(statuses).map(([value,label])=>`<option value="${value}" ${request.status===value?'selected':''}>${label}</option>`).join('')}</select></label>
  <label>Reply visible to the customer<textarea name="response" maxlength="2000" rows="3">${escape(request.response||'')}</textarea></label>
  <button class="btn" type="submit">Save update</button><p data-result role="status"></p></form>`;
}
export async function mountWebsiteRequests(panel,siteId,{read,write,escape,date}){
 panel.innerHTML='<h3>Customer update requests</h3><p>Latest 100 requests for the current website business. Status and replies are visible to the submitting customer. Changes do not publish the website.</p><button type="button" class="btn ghost" data-refresh-requests>Refresh requests</button><p data-request-feedback role="status"></p><div data-request-list></div>';
 const list=panel.querySelector('[data-request-list]'),feedback=panel.querySelector('[data-request-feedback]'),refresh=panel.querySelector('[data-refresh-requests]');
 let pending=false;
 const render=rows=>{
  list.innerHTML=rows.length?rows.map(r=>requestMarkup(r,escape,date)).join(''):'<p>No update requests yet.</p>';
  list.querySelectorAll('[data-update-request]').forEach(form=>form.addEventListener('submit',async event=>{
   event.preventDefault();if(pending)return;
   const row=rows.find(r=>r.id===form.dataset.updateRequest),values=new FormData(form),result=form.querySelector('[data-result]');
   pending=true;refresh.disabled=true;form.querySelectorAll('button,select,textarea').forEach(el=>el.disabled=true);result.textContent='Saving…';
   try{const data=await write(`/${siteId}/requests`,{id:row.id,revision:row.revision,status:values.get('status'),response:values.get('response')},'PATCH');render(data.requests);feedback.textContent='Request updated. The customer can see your reply.';}
   catch(error){result.textContent=error.message||'Could not save. Refresh if the request changed; your reply is kept.';}
   finally{pending=false;refresh.disabled=false;form.querySelectorAll('button,select,textarea').forEach(el=>el.disabled=false);}
  }));
 };
 const load=async()=>{
  if(pending)return;pending=true;refresh.disabled=true;feedback.textContent='Loading requests…';
  try{const data=await read(`/${siteId}/requests`);render(data.requests);feedback.textContent='';}
  catch(error){feedback.textContent=error.message||'Could not load requests. Please retry.';}
  finally{pending=false;refresh.disabled=false;}
 };
 refresh.addEventListener('click',load);await load();
}
