// Website → Domain: search, review and buy domains on the E2 Cloudflare account, then connect one.
const reasons={domain_unavailable:'Already registered',extension_not_supported_via_api:'Extension not available yet',extension_not_supported:'Extension not supported',extension_disallows_registration:'Extension does not allow registration'};
const connection={connected:'Connected',connecting:'Connecting…',disconnecting:'Disconnecting…',failed:'Needs attention',disconnected:'Not connected'};
const registration={pending:'Purchase starting…',in_progress:'Registration in progress',succeeded:'Registered',failed:'Purchase failed',action_required:'Action required in Cloudflare',blocked:'Blocked by registry'};
const price=(cost,currency)=>cost?`${cost} ${currency||'USD'}`:'Price unavailable';
export function domainResultsMarkup(results,escape){
 if(!results.length)return '<p>No suggestions. Try another name or a full domain such as example.com.</p>';
 return `<ul class="domain-results">${results.map(r=>`<li class="card"><strong>${escape(r.name)}</strong>
  <span>${r.registrable?`${escape(price(r.registrationCost,r.currency))} first year · renews ${escape(price(r.renewalCost,r.currency))}`:escape(reasons[r.reason]||'Not available')}</span>
  ${r.registrable?`<button type="button" class="btn ghost" data-view-domain="${escape(r.name)}">View</button>`:''}</li>`).join('')}</ul>`;
}
export function domainOfferMarkup(offer,escape){
 if(!offer.registrable)return `<section class="card"><h4>${escape(offer.name)}</h4><p>${escape(reasons[offer.reason]||'This domain is not available.')}</p></section>`;
 if(offer.tier&&offer.tier!=='standard')return `<section class="card"><h4>${escape(offer.name)}</h4><p>Premium domains cannot be bought here.</p></section>`;
 return `<section class="card" data-offer><h4>${escape(offer.name)}</h4>
  <p><strong>${escape(price(offer.registrationCost,offer.currency))}</strong> for the first year (live Cloudflare price) · renews at ${escape(price(offer.renewalCost,offer.currency))}/year with auto-renew on.</p>
  <p>Registered to the E2 Local Cloudflare account and its default registrant contact, charged to that account's payment method. Purchases are non-refundable.</p>
  <button type="button" class="btn" data-buy-domain="${escape(offer.name)}" data-cost="${escape(offer.registrationCost)}" data-currency="${escape(offer.currency)}">Buy for ${escape(price(offer.registrationCost,offer.currency))}</button></section>`;
}
export function siteDomainMarkup(slug,domain,available,pending,escape){
 const custom=domain?`<section class="card"><h4>${escape(domain.hostname)}</h4><p>${escape(connection[domain.connection_state]||domain.connection_state)} · www.${escape(domain.hostname)} redirects here</p>
  ${domain.error_code?`<p role="alert">Last error: ${escape(domain.error_code)}</p>`:''}
  ${domain.connection_state==='connected'?`<a class="btn ghost" href="https://${escape(domain.hostname)}/" target="_blank" rel="noopener noreferrer">Visit</a>`:''}
  ${domain.connection_state==='failed'?`<button type="button" class="btn ghost" data-connect-domain="${escape(domain.hostname)}">Retry connection</button>`:''}
  <button type="button" class="btn ghost" data-disconnect-domain="${escape(domain.hostname)}">Disconnect</button></section>`:'';
 const connect=!domain&&available.length?`<form data-connect-form class="compose"><h3>Connect a domain</h3><label>Registered domain<select name="domain" required>${available.map(d=>`<option value="${escape(d.hostname)}">${escape(d.hostname)}</option>`).join('')}</select></label>
  <p>Cloudflare points the domain and www at this website and issues HTTPS certificates. It can take a few minutes to go live.</p><button class="btn">Connect domain</button></form>`:'';
 const purchases=pending.length?`<h3>Purchases</h3>${pending.map(d=>`<div class="card"><strong>${escape(d.hostname)}</strong> <span>${escape(registration[d.registration_state]||d.registration_state)}</span>
  ${['pending','in_progress'].includes(d.registration_state)?`<button type="button" class="btn ghost" data-refresh-domain="${escape(d.hostname)}">Check status</button>`:''}</div>`).join('')}`:'';
 return `<h3>Website addresses</h3><p>E2 Local address: <a href="https://${escape(slug)}.e2local.com/" target="_blank" rel="noopener noreferrer">${escape(slug)}.e2local.com</a></p>${custom||'<p>No custom domain connected.</p>'}${connect}${purchases}`;
}
export async function mountWebsiteDomains(panel,site,{read,write,escape}){
 panel.innerHTML=`<div data-domain-site></div><p data-domain-feedback role="status"></p>
  <form data-domain-search class="compose"><h3>Buy a domain</h3><label>Search by name or keyword<input name="q" required minlength="2" maxlength="63" placeholder="acme plumbing or acmeplumbing.com"/></label><button class="btn">Search</button></form>
  <div data-domain-results></div><div data-domain-offer></div>`;
 const $=selector=>panel.querySelector(selector);
 const feedback=$('[data-domain-feedback]');
 let busy=false;
 const task=async(message,work)=>{
  if(busy)return;busy=true;feedback.textContent=message;panel.querySelectorAll('button').forEach(b=>b.disabled=true);
  try{await work();if(feedback.textContent===message)feedback.textContent='';}
  catch(error){if(error.name!=='AbortError')feedback.textContent=error.message||'Request failed. Please retry.';}
  finally{busy=false;panel.querySelectorAll('button').forEach(b=>b.disabled=false);}
 };
 async function loadSite(){
  const [state,account]=await Promise.all([read(`/${site.id}/domain`),read('/domains')]);
  const pending=account.domains.filter(d=>d.registration_state!=='succeeded');
  $('[data-domain-site]').innerHTML=siteDomainMarkup(site.slug,state.domain,state.available,pending,escape);
  $('[data-connect-form]')?.addEventListener('submit',event=>{event.preventDefault();connect(new FormData(event.currentTarget).get('domain'));});
  panel.querySelectorAll('[data-connect-domain]').forEach(b=>b.addEventListener('click',()=>connect(b.dataset.connectDomain)));
  panel.querySelectorAll('[data-disconnect-domain]').forEach(b=>b.addEventListener('click',()=>{
   if(confirm(`Disconnect ${b.dataset.disconnectDomain}? The website stays live at ${site.slug}.e2local.com and the domain stays registered.`))
    task('Disconnecting domain…',async()=>{await write(`/${site.id}/domain`,{domain:b.dataset.disconnectDomain},'DELETE');await loadSite();feedback.textContent='Domain disconnected.';});
  }));
  panel.querySelectorAll('[data-refresh-domain]').forEach(b=>b.addEventListener('click',()=>task('Checking registration…',async()=>{
   await read(`/domains/${encodeURIComponent(b.dataset.refreshDomain)}`);await loadSite();})));
 }
 const connect=name=>task(`Connecting ${name}…`,async()=>{
  await write(`/${site.id}/domain`,{domain:name});await loadSite();feedback.textContent=`${name} is connected. HTTPS can take a few minutes to activate.`;
 });
 async function view(name){
  const {offer}=await read(`/domains?${new URLSearchParams({check:name})}`);
  const box=$('[data-domain-offer]');box.innerHTML=domainOfferMarkup(offer,escape);box.scrollIntoView?.({block:'nearest'});
  box.querySelector('[data-buy-domain]')?.addEventListener('click',event=>buy(event.currentTarget.dataset));
 }
 const buy=({buyDomain:name,cost,currency})=>{
  if(!confirm(`Buy ${name} for ${cost} ${currency}? This charges the E2 Local Cloudflare account and cannot be refunded.`))return;
  task(`Buying ${name}…`,async()=>{
   try{const {domain}=await write('/domains',{domain:name,expectedCost:cost,currency});
    $('[data-domain-offer]').innerHTML='';await loadSite();
    feedback.textContent=domain.registration_state==='succeeded'?`${name} is registered. Connect it below.`:`${name}: ${registration[domain.registration_state]||domain.registration_state}. Use Check status to follow it.`;}
   catch(error){await view(name).catch(()=>{});throw error;}
  });
 };
 $('[data-domain-search]').addEventListener('submit',event=>{event.preventDefault();const q=new FormData(event.currentTarget).get('q').trim();
  task('Searching Cloudflare…',async()=>{
   const looksLikeDomain=/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(q);
   const {results}=await read(`/domains?${new URLSearchParams({q})}`);
   const box=$('[data-domain-results]');box.innerHTML=domainResultsMarkup(results,escape);$('[data-domain-offer]').innerHTML='';
   box.querySelectorAll('[data-view-domain]').forEach(b=>b.addEventListener('click',()=>task('Checking live price…',()=>view(b.dataset.viewDomain))));
   if(looksLikeDomain&&!results.some(r=>r.name===q.toLowerCase()))await view(q.toLowerCase()).catch(()=>{});
  });
 });
 await task('Loading domains…',loadSite);
}
