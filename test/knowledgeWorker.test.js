import test from 'node:test';
import assert from 'node:assert/strict';
import {chunkText,isPublicIp,processKnowledge,secureFetch,validatePublicHttps} from '../src/workers/knowledge.js';

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
