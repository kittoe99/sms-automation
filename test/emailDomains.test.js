import test from 'node:test';
import assert from 'node:assert/strict';
import {provisionEmailDomain} from '../src/lib/emailDomains.js';
test('Resend domain provisioning resumes existing DNS safely and requires provider verification',async()=>{
 const requests=[],completions=[];
 const record={record:'DKIM',type:'TXT',name:'resend._domainkey',value:'public-key'};
 const db={call:async(name,u,t,action,p)=>action==='begin'?{id:'domain',domain:'opek.e2local.com',operation_token:'lease',provider_id:'resend-domain',records:[]}:action==='complete'?(completions.push(p),p):'sending-key'};
 const result=await provisionEmailDomain(db,'admin','opek',{id:'domain'},{getEnv:key=>({CLOUDFLARE_EMAIL_DNS_TOKEN:'dns-key',CLOUDFLARE_EMAIL_ZONE_ID:'a'.repeat(32)})[key],fetchImpl:async(url,options)=>{
  requests.push({url,...options});
  if(url.includes('cloudflare')&&options.method==='GET')return Response.json({success:true,result:[{content:'public-key'}]});
  if(url.includes('/verify'))return Response.json({});
  return Response.json({id:'resend-domain',status:'pending',records:[record]});
 }});
 assert.equal(result.status,'pending');assert.equal(requests.some(r=>r.url.includes('cloudflare')&&r.method!=='GET'),false);
 assert.match(requests.find(r=>r.url.includes('cloudflare')).url,/resend._domainkey.opek.e2local.com/);
 assert.equal(completions[0].token,'lease');
});
test('DNS conflicts are recorded without overwriting records or leaking credentials',async()=>{
 let result;const db={call:async(n,u,t,a,p)=>a==='begin'?{id:'d',domain:'opek.e2local.com',operation_token:'lease',provider_id:'provider'}:a==='complete'?(result=p,p):'key'};
 await provisionEmailDomain(db,'admin','opek',{}, {getEnv:key=>key==='CLOUDFLARE_EMAIL_ZONE_ID'?'a'.repeat(32):'secret',fetchImpl:async(url,options)=>{
  if(url.includes('cloudflare')){assert.equal(options.method,'GET');return Response.json({success:true,result:[{content:'unrelated-key'}]});}
  return Response.json({status:'pending',records:[{record:'DKIM',type:'TXT',name:'resend._domainkey',value:'new-key'}]});
 }});
 assert.equal(result.error,'DNS_RECORD_CONFLICT');assert.equal(result.status,'failed');assert.doesNotMatch(JSON.stringify(result),/secret/);
});

 test('Resend zone-relative subdomain names do not duplicate the business label',async()=>{
 const names=[];const db={call:async(n,u,t,a,p)=>a==='begin'?{id:'d',domain:'test.e2local.com',operation_token:'lease',provider_id:'provider'}:a==='complete'?p:'key'};
 await provisionEmailDomain(db,'admin','test',{}, {getEnv:k=>k==='CLOUDFLARE_EMAIL_ZONE_ID'?'a'.repeat(32):'secret',fetchImpl:async(url,options)=>{
 if(url.includes('cloudflare')){if(options.method==='POST')names.push(JSON.parse(options.body).name);return Response.json({success:true,result:[]});}
 return Response.json({status:'pending',records:[{record:'DKIM',type:'TXT',name:'resend._domainkey.test',value:'key'},{record:'SPF',type:'MX',name:'send.test',value:'mx',priority:10}]});
 }});assert.deepEqual(names,['resend._domainkey.test.e2local.com','send.test.e2local.com']);
});
