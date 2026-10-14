import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {Readable} from 'node:stream';
import {isPublicIp,publicHttpsUrl,fetchPublicHttps} from '../src/lib/publicHttps.js';

const resolveDns=async()=>['8.8.8.8'];
test('public-address checks normalize IPv4-mapped IPv6 and fail closed on special ranges',()=>{
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','100.64.0.1','192.168.1.1','::1','fd00::1','fe80::1',
  '::ffff:127.0.0.1','::ffff:7f00:1','0:0:0:0:0:ffff:a00:1','::ffff:a9fe:a9fe',
  '2001:db8::1','2002:7f00:1::','64:ff9b::7f00:1','3fff::1','not:an:ip']) assert.equal(isPublicIp(ip),false,ip);
 for(const ip of ['8.8.8.8','1.1.1.1','::ffff:808:808','2606:4700:4700::1111','2001:4860:4860::8888']) assert.equal(isPublicIp(ip),true,ip);
 for(const url of ['https://[::ffff:127.0.0.1]/','https://localhost./','https://169.254.169.254/','https://example.com:8443/','https://user:pass@example.com/','http://example.com/']) assert.throws(()=>publicHttpsUrl(url),{code:'UNSAFE_SOURCE_URL'});
});

test('HTTPS transport connects only to checked IP while preserving TLS and Host identity',async()=>{
 let resolutions=0,requests=0;
 const result=await fetchPublicHttps('https://example.com/path?q=1',{
  resolveDns:async()=>++resolutions===1?['8.8.8.8']:['127.0.0.1'],
  requestImpl:(options,callback)=>{
   requests++; assert.equal(options.hostname,'8.8.8.8'); assert.equal(options.servername,'example.com');
   assert.equal(options.headers.host,'example.com');assert.equal(options.path,'/path?q=1');
   assert.equal(options.rejectUnauthorized,true);assert.equal(options.agent,false);assert.ok(options.signal);
   const request=new EventEmitter();request.destroy=()=>{};
   request.end=()=>queueMicrotask(()=>{const body=Readable.from([Buffer.from('pinned response')]);body.statusCode=200;body.headers={'content-type':'text/plain'};callback(body);});
   return request;
  },
 });
 assert.equal(new TextDecoder().decode(result.bytes),'pinned response');
 assert.equal(resolutions,1);assert.equal(requests,1);
});

test('every redirect rechecks its destination and blocks private or HTTP redirects before requesting',async()=>{
 for(const location of ['https://[::ffff:127.0.0.1]/','https://169.254.169.254/','http://example.com/private']) {
  let requests=0;
  await assert.rejects(fetchPublicHttps('https://example.com',{resolveDns,fetchImpl:async()=>{requests++;return new Response(null,{status:302,headers:{location}});}}),{code:'UNSAFE_SOURCE_URL'});
  assert.equal(requests,1);
 }
 let lookups=0,requests=0;
 await assert.rejects(fetchPublicHttps('https://example.com',{resolveDns:async()=>++lookups===1?['8.8.8.8']:['10.0.0.1'],fetchImpl:async()=>{requests++;return new Response(null,{status:302,headers:{location:'/next'}});}}),{code:'UNSAFE_SOURCE_URL'});
 assert.equal(requests,1);
});

test('streaming limits stop oversized bodies even without Content-Length',async()=>{
 let cancelled=false;
 await assert.rejects(fetchPublicHttps('https://example.com',{resolveDns,maxBytes:10,fetchImpl:async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(11));},cancel(){cancelled=true;}}))}),{code:'SOURCE_TOO_LARGE'});
 assert.equal(cancelled,true);
});

test('deadline bounds stalled DNS, response headers and body reads',async()=>{
 await assert.rejects(fetchPublicHttps('https://example.com',{timeoutMs:20,resolveDns:()=>new Promise(()=>{})}),{code:'SOURCE_TIMEOUT'});
 await assert.rejects(fetchPublicHttps('https://example.com',{timeoutMs:20,resolveDns,fetchImpl:()=>new Promise(()=>{})}),{code:'SOURCE_TIMEOUT'});
 let cancelled=false;
 await assert.rejects(fetchPublicHttps('https://example.com',{timeoutMs:20,resolveDns,fetchImpl:async()=>new Response(new ReadableStream({cancel(){cancelled=true;}}))}),{code:'SOURCE_TIMEOUT'});
 assert.equal(cancelled,true);
});
