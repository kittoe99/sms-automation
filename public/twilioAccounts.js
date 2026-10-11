import {dashboardLoader} from './dashboardLoader.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const businessList=(items,pending=false)=>`<ul>${items.map(b=>`<li><strong>${esc(b.businessName)}</strong>${b.phoneNumber?` · ${esc(b.phoneNumber)}`:''}${pending?` · ${b.state==='needs_review'?'Needs review':'Connecting'}`:''} <button class="btn ghost" type="button" data-linked-business="${esc(b.tenantId)}">Open CRM business</button></li>`).join('')}</ul>`;
export function twilioAccountsHtml(inventory) {
 return `<section class="card"><h2>Twilio accounts</h2><p>Browse active accounts, approved SMS senders and their linked businesses. Viewing this directory does not connect a number or enable sending.</p>
 ${inventory.truncated?'<p role="status">Showing the first 100 active accounts. Additional accounts need an inventory review.</p>':''}
 <div class="platform-grid">${inventory.accounts.map(a=>`<article class="card"><h3>${esc(a.name||'Unnamed Twilio account')}</h3><p>${a.isParent?'Main account':'Subaccount'}</p><h4>Linked CRM businesses (${a.linkedBusinesses?.length||0})</h4>${a.linkedBusinesses?.length?businessList(a.linkedBusinesses):'<p>Not linked to a CRM business</p>'}${a.pendingConnections?.length?`<h4>Pending connections (${a.pendingConnections.length})</h4>${businessList(a.pendingConnections,true)}`:''}<button class="btn" type="button" data-account="${esc(a.sid)}">View approved senders</button><div data-account-detail></div></article>`).join('')||'<p>No active Twilio accounts found.</p>'}</div></section>`;
}
export function twilioSendersHtml(result) {
 return `<h4>Approved senders</h4>${result.options.map(p=>`<div class="card"><strong>Twilio profile: ${esc(p.profileName||p.legalBusinessName||'Business profile')}</strong><p class="twilio-connected-number">${esc(p.phoneNumber)}</p><p>${esc(p.approvalStatus)} · ${p.senderType==='toll_free'?'Toll-free':'A2P 10DLC'}</p><p>${esc(p.serviceName)}</p><p>${p.assignedBusiness?'Linked CRM business: '+esc(p.assignedBusiness.businessName):p.reservedBusiness?'Reserved for CRM business: '+esc(p.reservedBusiness.businessName)+(p.reservedBusiness.state==='needs_review'?' · Needs review':' · Connecting'):'Available to connect'}</p></div>`).join('')||'<p>No approved senders are available in this account.</p>'}
 ${result.unavailable.length?`<details><summary>Senders needing attention (${result.unavailable.length})</summary>${result.unavailable.map(p=>`<p><strong>${esc(p.name)} ${esc(p.phoneNumber)}</strong><br>${esc(p.reason)}</p>`).join('')}</details>`:''}
 ${result.truncated?'<p role="status">This account exceeds the inventory limit. Only the first 100 resources of each type are shown.</p>':''}`;
}
export async function mountTwilioAccounts(container,{read,onBusiness}) {
 container.innerHTML=dashboardLoader('Loading Twilio accounts…');
 try {
  const inventory=await read('twilio/accounts');container.innerHTML=twilioAccountsHtml(inventory);
  container.querySelectorAll('[data-linked-business]').forEach(button=>button.onclick=()=>onBusiness(button.dataset.linkedBusiness));
  container.querySelectorAll('[data-account]').forEach(button=>button.onclick=async()=>{
   const detail=button.parentElement.querySelector('[data-account-detail]');button.disabled=true;detail.innerHTML='<p role="status">Checking approved senders…</p>';
   try{detail.innerHTML=twilioSendersHtml(await read('twilio/profiles',{accountSid:button.dataset.account}));button.textContent='Refresh approved senders';}
   catch(error){detail.innerHTML='<p role="alert"></p>';detail.querySelector('p').textContent=error.message;}
   finally{button.disabled=false;}
  });
 }catch(error){container.innerHTML='<section class="card"><p role="alert"></p><button class="btn" data-retry>Try again</button></section>';container.querySelector('p').textContent=error.message;container.querySelector('[data-retry]').onclick=()=>mountTwilioAccounts(container,{read,onBusiness});}
}
