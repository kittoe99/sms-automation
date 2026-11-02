// Runtime provisioning uses server credentials, never the browser/agent connector.
export async function provisionEmailDomain(db, user, tenant, input, {getEnv = key => globalThis.Deno?.env.get(key) ?? globalThis.process?.env[key], fetchImpl = fetch} = {}) {
  const operation = await db.call('email_domain_control',user,tenant,'begin',input);
  let providerId = operation.provider_id, records = operation.records || [];
  const complete = (status,error = null) => db.call('email_domain_control',user,tenant,'complete',{
    id:operation.id,token:operation.operation_token,providerId,status,records,error});
  try {
    const key = getEnv('RESEND_DOMAIN_API_KEY') || getEnv('RESEND_API_KEY') || await db.call('email_domain_control',user,tenant,'key',{});
    if (!key) throw new Error('RESEND_NOT_CONFIGURED');
    const call = async (base,path,method,body,token) => {
      const response = await fetchImpl(`${base}${path}`,{method,signal:AbortSignal.timeout(8000),headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});
      if(!response.ok) throw new Error(`${base.includes('cloudflare')?'DNS':'RESEND'}_HTTP_${response.status}`);
      const value = await response.json();
      if (value.success === false) throw new Error('DNS_REQUEST_FAILED');
      return value;
    };
    const resend = (path,method='GET',body) => call('https://api.resend.com',path,method,body,key);
    if (!providerId) {
      let after;
      for(let page=0;page<10;page++) {
        const list = await resend(`/domains?limit=100${after?`&after=${encodeURIComponent(after)}`:''}`);
        providerId = list.data?.find(d=>d.name.toLowerCase()===operation.domain)?.id;
        if(providerId || !list.has_more) break;
        after = list.data?.at(-1)?.id;
        if(!after || page===9) throw new Error('DOMAIN_INVENTORY_LIMIT');
      }
      if (!providerId) {
        if(operation.domain==='e2local.com') throw new Error('VERIFY_MAIN_DOMAIN_IN_RESEND');
        const created = await resend('/domains','POST',{name:operation.domain,capabilities:{sending:'enabled',receiving:'disabled'}});
        providerId = created.id;
      }
    }
    let domain = await resend(`/domains/${encodeURIComponent(providerId)}`);
    records = domain.records || [];
    if (operation.domain!=='e2local.com' && domain.status!=='verified') {
      const token = getEnv('CLOUDFLARE_EMAIL_DNS_TOKEN'), zone = getEnv('CLOUDFLARE_EMAIL_ZONE_ID');
      if(!token || !/^[a-f0-9]{32}$/i.test(zone || '')) throw new Error('DNS_CREDENTIALS_REQUIRED');
      const dns = (path,method='GET',body) => call('https://api.cloudflare.com/client/v4',`/zones/${zone}/dns_records${path}`,method,body,token);
      for(const record of records) {
        if(!['TXT','MX','CNAME'].includes(record.type) || !['DKIM','SPF'].includes(record.record)) continue;
        let name = record.name.replace(/\.$/,'').toLowerCase();
        if(!name.endsWith(`.${operation.domain}`) && name!==operation.domain) name=`${name}.${operation.domain}`;
        if(!name.endsWith(`.${operation.domain}`) && name!==operation.domain) throw new Error('INVALID_DNS_RECORD');
        // Relative records can never escape the business subdomain; existing records are never overwritten.
        if(name.includes(`.${operation.domain}.${operation.domain}`)) throw new Error('INVALID_DNS_RECORD');
        const existing = await dns(`?name=${encodeURIComponent(name)}&type=${record.type}`);
        const matches = existing.result || [];
        if(matches.some(r=>r.content.replace(/^"|"$/g,'')===record.value && (record.type!=='MX' || r.priority===record.priority))) continue;
        if(matches.length) throw new Error('DNS_RECORD_CONFLICT');
        await dns('','POST',{type:record.type,name,content:record.value,ttl:300,...(record.type==='MX'?{priority:record.priority}:{proxied:false})});
      }
      await resend(`/domains/${encodeURIComponent(providerId)}/verify`,'POST');
      domain = await resend(`/domains/${encodeURIComponent(providerId)}`);
      records = domain.records || records;
    }
    return await complete(domain.status==='verified' ? 'verified' : domain.status==='failed' ? 'failed' : 'pending');
  } catch(error) {
    return complete('failed',/^[A-Z0-9_]+$/.test(error.message || '') ? error.message : 'PROVISIONING_INTERRUPTED');
  }
}
