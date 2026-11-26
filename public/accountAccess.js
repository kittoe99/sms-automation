const esc=value=>String(value??'').replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const when=value=>value?new Date(value).toLocaleString():'—';
export const ACCESS_LABELS={active:'Active',suspended:'Suspended',blocked:'Blocked',deleted:'Deleted'};
const HISTORY={status:'Status changed',access_block:'Blocked',access_unblock:'Unblocked',access_sign_out:'Signed out everywhere'};

export function accessBadge(row) {
 const access=row.access||row.status;
 return `<span class="access-badge" data-access="${esc(access)}">${esc(ACCESS_LABELS[access]||access)}</span>`;
}

// Access card for one user: suspend/restore, block/unblock sign-in, sign out
// everywhere, live Clerk state and the access history.
export function mountAccountAccess(container,row,{read,write,reload,confirm=message=>window.confirm(message)}) {
 if(!container||row.status==='deleted')return;
 const access=row.access||row.status,blocked=access==='blocked';
 const history=row.accessHistory||[];
 container.innerHTML=`<section class="card account-access"><h3>Access</h3>
  <p>${accessBadge(row)} ${blocked?`Since ${esc(when(row.access_blocked_at))}${row.accessBlockedByName?` by ${esc(row.accessBlockedByName)}`:''}${row.access_block_reason?` · ${esc(row.access_block_reason)}`:''}`
   :access==='suspended'?'Cannot use the E2 dashboard or the CRM until restored.':'Can sign in and use the businesses assigned below.'}</p>
  <div data-clerk-state><p>Checking sign-in status…</p></div>
  <form class="compose" data-access-form>
   <label class="compose-label">Reason <span>(required to suspend or block)</span><input name="reason" maxlength="500" autocomplete="off"></label>
   <p data-access-error class="login-error" role="alert"></p><p data-access-status role="status"></p>
   <div class="compose-actions">
    ${blocked?'<button type="button" class="btn" data-access="unblock">Unblock and restore access</button>'
     :`${access==='active'?'<button type="button" class="btn ghost" data-access="suspend">Suspend access</button>':'<button type="button" class="btn" data-access="restore">Restore access</button>'}
      <button type="button" class="btn ghost" data-access="block">Block sign-in</button>`}
    <button type="button" class="btn ghost" data-access="sign-out">Sign out everywhere</button>
   </div>
  </form>
  <details${history.length?'':' hidden'}><summary>Access history (${history.length})</summary><ul class="access-history">${history.map(h=>`<li><strong>${esc(h.action==='status'?(h.status==='active'?'Restored':'Suspended'):HISTORY[h.action]||h.action)}</strong> · ${esc(when(h.at))}${h.by?` · ${esc(h.by)}`:''}${h.reason?` · ${esc(h.reason)}`:''}</li>`).join('')}</ul></details>
 </section>`;
 const form=container.querySelector('[data-access-form]'),error=container.querySelector('[data-access-error]'),status=container.querySelector('[data-access-status]');
 void read('account-access',{accountId:row.id}).then(state=>{
  container.querySelector('[data-clerk-state]').innerHTML=(state.clerk||[]).map(c=>c.ok
   ?`<p>${esc(c.app)}: ${c.banned?'<strong>sign-in blocked in Clerk</strong>':'sign-in allowed'} · last sign-in ${esc(when(c.lastSignInAt))} · ${c.activeSessions} active session${c.activeSessions===1?'':'s'}</p>`
   :`<p>${esc(c.issuer)}: sign-in status unavailable (${esc(c.error)})</p>`).join('')||'<p>No sign-in identity linked.</p>';
 }).catch(e=>{container.querySelector('[data-clerk-state]').innerHTML=`<p>Sign-in status unavailable (${esc(e.message)})</p>`;});
 const messages={
  suspend:'Suspend this account? They lose access to the E2 dashboard and the CRM until restored. They stay signed in to Clerk but see "account unavailable".',
  restore:'Restore access for this account?',
  block:'Block sign-in? The account is suspended, signed out everywhere, and cannot sign in until unblocked.',
  unblock:'Unblock sign-in and restore access for this account?',
  'sign-out':'Sign this account out of every device? They can sign in again unless suspended or blocked.',
 };
 container.querySelectorAll('[data-access]').forEach(button=>button.addEventListener('click',async()=>{
  const kind=button.dataset.access,reason=new FormData(form).get('reason').trim();
  error.textContent='';status.textContent='';
  if(['suspend','block'].includes(kind)&&!reason){error.textContent='Give a reason first.';form.querySelector('input').focus();return;}
  if(!confirm(messages[kind]))return;
  button.disabled=true;
  try{
   const body={accountId:row.id,revision:row.revision,...(reason?{reason}:{})};
   const result=kind==='suspend'||kind==='restore'?await write('status',{...body,status:kind==='suspend'?'suspended':'active'})
    :await write(`account-access/${kind}`,body);
   status.textContent=result?.message||'Saved.';
   await reload();
  }catch(e){error.textContent=e.message;button.disabled=false;}
 }));
}
