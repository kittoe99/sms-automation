import test from 'node:test';
import assert from 'node:assert/strict';
import {chunkText,isPublicIp,processKnowledge,secureFetch,validatePublicHttps} from '../src/workers/knowledge.js';
import {createWorkerHandler} from '../supabase/functions/_shared/worker.js';

test('knowledge URL validation blocks local, reserved, credentialed, HTTP, and DNS-rebound targets',async()=>{
 for(const ip of ['127.0.0.1','10.0.0.2','172.20.0.1','192.168.1.1','169.254.169.254','::1','fd00::1'])assert.equal(isPublicIp(ip),false);
 assert.equal(isPublicIp('8.8.8.8'),true);
 await assert.rejects(validatePublicHttps('http://example.com',{resolveDns:async()=>['8.8.8.8']}),{code:'UNSAFE_SOURCE_URL'});
 await assert.rejects(validatePublicHttps('https://user:pass@example.com',{resolveDns:async()=>['8.8.8.8']}),{code:'UNSAFE_SOURCE_URL'});
 await assert.rejects(validatePublicHttps('https://example.com',{resolveDns:async()=>['10.0.0.1']}),{code:'UNSAFE_SOURCE_URL'});
 let lookups=0;
 await assert.rejects(secureFetch('https://example.com',{resolveDns:async()=>++lookups===1?['8.8.8.8']:['127.0.0.1'],fetchImpl:async()=>new Response(null,{status:302,headers:{location:'/next'}})}),{code:'UNSAFE_SOURCE_URL'});
});

test('secure website ingestion stays on origin, strips executable content, chunks and persists a draft',async()=>{
 const calls=[];const pages=new Map([
  ['https://example.com/',new Response('<h1>Acme</h1><script>steal()</script><p>We repair bicycles in Denver every weekday.</p><a href="/faq">FAQ</a><a href="https://evil.test/">evil</a>',{headers:{'content-type':'text/html'}})],
  ['https://example.com/faq',new Response('<p>Estimates are free and repairs require staff confirmation.</p>',{headers:{'content-type':'text/html'}})]
 ]);
 const db={call:async(name,...args)=>{calls.push([name,...args]);if(name==='knowledge_job_context')return {source:{id:'source',type:'website',origin:'https://example.com/',title:'Site'}};if(name==='complete_knowledge_ingest')return args[2];}};
 const result=await processKnowledge({id:'job',lease_token:'lease'},db,{resolveDns:async host=>host==='example.com'?['8.8.8.8']:['9.9.9.9'],fetchImpl:async url=>pages.get(url) || new Response('missing',{status:404})});
 assert.doesNotMatch(result.text,/steal/);assert.match(result.text,/repair bicycles/);assert.match(result.text,/Estimates are free/);assert.ok(result.chunks.length);assert.match(result.content_hash,/^[a-f0-9]{64}$/);assert.equal(calls.at(-1)[0],'complete_knowledge_ingest');
});

test('chunking is bounded and keeps overlap context',()=>{
 const chunks=chunkText(`${'Sentence one. '.repeat(100)}${'Sentence two. '.repeat(100)}`,{size:300,overlap:40});
 assert.ok(chunks.length>2);assert.ok(chunks.every(x=>x.length<=300));
});

test('mapped IPv6 cannot bypass the knowledge source boundary',async()=>{
 for(const host of ['::ffff:127.0.0.1','::ffff:a00:1','::ffff:a9fe:a9fe']) {
  await assert.rejects(()=>secureFetch(`https://[${host}]/`,{fetchImpl:()=>{throw new Error('Must not fetch');}}),{code:'UNSAFE_SOURCE_URL'});
 }
});

test('a stalled knowledge fetch retries and releases its Edge slot before the lease expires',async()=>{
 const calls=[],secret='knowledge-test-secret-'.repeat(3);
 const db={call:async(name,...args)=>{calls.push([name,...args]);if(name==='edge_enter')return 'slot';if(name==='claim')return {id:'job',lease_token:'lease',attempts:1};if(name==='knowledge_job_context')return {source:{type:'website',origin:'https://example.com/'}};}};
 const handler=createWorkerHandler({queue:'knowledge_ingest_jobs',secret,db,maxJobs:1,budgetMs:40000,
  processJob:(job,db)=>processKnowledge(job,db,{timeoutMs:20,resolveDns:async()=>['8.8.8.8'],fetchImpl:()=>new Promise(()=>{})})});
 assert.equal((await handler(new Request('https://example.test/worker',{method:'POST',headers:{authorization:`Bearer ${secret}`}}))).status,200);
 assert.deepEqual(calls.find(x=>x[0]==='finish').slice(1,5),['job','lease','retry','KNOWLEDGE_TIMEOUT']);
 assert.equal(calls.at(-1)[0],'edge_exit');assert.ok(!calls.some(x=>x[0]==='complete_knowledge_ingest'));
});

test('knowledge deadline also covers private-file extraction and prevents late completion',async()=>{
 const calls=[];let finishExtraction,signal;
 const db={call:async(name)=>{calls.push(name);if(name==='knowledge_job_context')return {source:{type:'file',storage_path:'tenant/source.pdf'}};}};
 await assert.rejects(processKnowledge({id:'job',lease_token:'lease',attempts:1},db,{timeoutMs:20,
  supabaseUrl:'https://project.example.test',serviceRoleKey:'synthetic',
  fetchImpl:async(_url,options)=>{signal=options.signal;assert.equal(options.redirect,'error');return new Response('%PDF-synthetic',{headers:{'content-type':'application/pdf'}});},
  extractImpl:()=>new Promise(resolve=>{finishExtraction=resolve;}),
 }),{code:'KNOWLEDGE_TIMEOUT'});
 assert.equal(signal.aborted,true);finishExtraction('Late synthetic extracted source text');await Promise.resolve();
 assert.ok(!calls.includes('complete_knowledge_ingest'));
});

test('elapsed deadline fences completion even when synchronous extraction delays the timer',async()=>{
 const calls=[];
 const db={call:async(name)=>{calls.push(name);if(name==='knowledge_job_context')return {source:{type:'file',storage_path:'tenant/source.pdf'}};}};
 await assert.rejects(processKnowledge({id:'job',lease_token:'lease',attempts:1},db,{timeoutMs:10,
  supabaseUrl:'https://project.example.test',serviceRoleKey:'synthetic',
  fetchImpl:async()=>new Response('%PDF-synthetic',{headers:{'content-type':'application/pdf'}}),
  extractImpl:()=>{const end=Date.now()+20;while(Date.now()<end){}return 'Synthetic document text completed after deadline';},
 }),{code:'KNOWLEDGE_TIMEOUT'});
 assert.ok(!calls.includes('complete_knowledge_ingest'));
});
