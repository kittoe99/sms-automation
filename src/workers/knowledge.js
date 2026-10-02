const WEB_LIMIT=2*1024*1024;
const FILE_LIMIT=10*1024*1024;
const MAX_REDIRECTS=5;
const MAX_PAGES=5;
const env=name=>globalThis.Deno?.env.get(name) ?? globalThis.process?.env[name];
const permanent=(message,code)=>Object.assign(new Error(message),{code,permanent:true});

function ipv4Parts(value) {
 const parts=value.split('.');
 if(parts.length!==4 || parts.some(x=>!/^\d{1,3}$/.test(x) || Number(x)>255)) return null;
 return parts.map(Number);
}
export function isPublicIp(value) {
 const ip=String(value).toLowerCase().replace(/^\[|\]$/g,'');
 const v4=ipv4Parts(ip);
 if(v4) {
  const [a,b]=v4;
  return !(a===0 || a===10 || a===127 || a>=224 || (a===169&&b===254) || (a===172&&b>=16&&b<=31) || (a===192&&b===168) || (a===100&&b>=64&&b<=127) || (a===192&&b===0) || (a===192&&b===2) || (a===198&&[18,19,51].includes(b)) || (a===203&&b===0));
 }
 if(!ip.includes(':')) return false;
 if(ip==='::1' || ip==='::' || ip.startsWith('fc') || ip.startsWith('fd') || ip.startsWith('fe8') || ip.startsWith('fe9') || ip.startsWith('fea') || ip.startsWith('feb') || ip.startsWith('ff')) return false;
 if(ip.startsWith('::ffff:')) return isPublicIp(ip.slice(7));
 return true;
}

async function defaultResolve(hostname) {
 if(ipv4Parts(hostname) || hostname.includes(':')) return [hostname];
 if(globalThis.Deno?.resolveDns) {
  const [v4,v6]=await Promise.allSettled([Deno.resolveDns(hostname,'A'),Deno.resolveDns(hostname,'AAAA')]);
  return [...(v4.value || []),...(v6.value || [])];
 }
 const {lookup}=await import('node:dns/promises');
 return (await lookup(hostname,{all:true})).map(x=>x.address);
}

export async function validatePublicHttps(value,{resolveDns=defaultResolve}={}) {
 let url;try{url=new URL(value);}catch{throw permanent('Invalid source URL','INVALID_SOURCE_URL');}
 if(url.protocol!=='https:' || url.username || url.password || url.port && url.port!=='443') throw permanent('Only public HTTPS URLs are allowed','UNSAFE_SOURCE_URL');
 const addresses=await resolveDns(url.hostname);
 if(!addresses.length || addresses.some(ip=>!isPublicIp(ip))) throw permanent('Source URL resolves to a private or reserved address','UNSAFE_SOURCE_URL');
 return url;
}

async function boundedBody(response,limit) {
 const declared=Number(response.headers.get('content-length') || 0);
 if(declared>limit) throw permanent('Source is too large','SOURCE_TOO_LARGE');
 const reader=response.body?.getReader();
 if(!reader) return new Uint8Array();
 const chunks=[];let total=0;
 while(true){const {done,value}=await reader.read();if(done)break;total+=value.byteLength;if(total>limit){reader.cancel();throw permanent('Source is too large','SOURCE_TOO_LARGE');}chunks.push(value);}
 const output=new Uint8Array(total);let offset=0;for(const chunk of chunks){output.set(chunk,offset);offset+=chunk.byteLength;}return output;
}

export async function secureFetch(urlValue,{fetchImpl=fetch,resolveDns=defaultResolve,maxBytes=WEB_LIMIT,expectedOrigin}={}) {
 let current=await validatePublicHttps(urlValue,{resolveDns});
 const origin=expectedOrigin || current.origin;
 if(current.origin!==origin) throw permanent('Cross-origin crawl denied','CROSS_ORIGIN_REDIRECT');
 for(let redirects=0;redirects<=MAX_REDIRECTS;redirects++) {
  current=await validatePublicHttps(current.href,{resolveDns});
  if(current.origin!==origin) throw permanent('Cross-origin crawl denied','CROSS_ORIGIN_REDIRECT');
  const response=await fetchImpl(current.href,{redirect:'manual',headers:{Accept:'text/html,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document;q=0.9'}});
  if(response.status>=300 && response.status<400) {
   const location=response.headers.get('location');if(!location) throw permanent('Invalid source redirect','INVALID_SOURCE_REDIRECT');
   current=new URL(location,current);continue;
  }
  if(!response.ok) throw Object.assign(new Error(`Source returned ${response.status}`),{code:`SOURCE_HTTP_${response.status}`,permanent:response.status>=400&&response.status<500});
  return {url:current,contentType:(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),bytes:await boundedBody(response,maxBytes)};
 }
 throw permanent('Too many source redirects','TOO_MANY_REDIRECTS');
}

const decode=bytes=>new TextDecoder('utf-8',{fatal:false}).decode(bytes);
export function htmlToText(html) {
 return html.replace(/<!--[\s\S]*?-->/g,' ').replace(/<(script|style|noscript|svg|iframe)[^>]*>[\s\S]*?<\/\1>/gi,' ').replace(/<br\s*\/?>/gi,'\n').replace(/<\/(p|div|li|h[1-6]|section|article)>/gi,'\n').replace(/<[^>]+>/g,' ').replace(/&nbsp;/gi,' ').replace(/&amp;/gi,'&').replace(/&lt;/gi,'<').replace(/&gt;/gi,'>').replace(/&#39;/g,"'").replace(/&quot;/g,'"').replace(/[ \t]+/g,' ').replace(/\n\s*\n+/g,'\n').trim();
}
function htmlLinks(html,base) {
 const links=[];for(const match of html.matchAll(/\bhref\s*=\s*["']([^"'#]+)["']/gi)){try{const url=new URL(match[1],base);url.hash='';if(url.origin===base.origin && url.protocol==='https:'&&!/\.(?:png|jpe?g|gif|svg|webp|zip|pdf|docx?)$/i.test(url.pathname)) links.push(url.href);}catch{}}
 return [...new Set(links)];
}

export function chunkText(value,{size=1200,overlap=150}={}) {
 const text=String(value).replace(/\r/g,'').replace(/[ \t]+\n/g,'\n').trim();if(!text)return [];
 const paragraphs=text.split(/\n{2,}|(?<=[.!?])\s+(?=[A-Z0-9])/).map(x=>x.trim()).filter(Boolean);
 const chunks=[];let current='';
 for(const paragraph of paragraphs){
  if(current && current.length+paragraph.length+1>size){chunks.push(current);current=current.slice(Math.max(0,current.length-overlap)).replace(/^\S*\s?/,'')+` ${paragraph}`;}
  else current=current?`${current}\n${paragraph}`:paragraph;
  while(current.length>size){chunks.push(current.slice(0,size));current=current.slice(size-overlap);}
 }
 if(current.trim()) chunks.push(current.trim());return chunks;
}
export async function sha256(value) {
 const bytes=typeof value==='string'?new TextEncoder().encode(value):value;
 return [...new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))].map(x=>x.toString(16).padStart(2,'0')).join('');
}

async function extract(bytes,type) {
  if(type==='text/html') return htmlToText(decode(bytes));
 if(['text/plain','text/markdown','text/x-markdown'].includes(type)) {if(bytes.includes(0))throw permanent('Text file contains binary content','MIME_MISMATCH');return decode(bytes);}
  if(type==='application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
  if(bytes[0]!==0x50||bytes[1]!==0x4b)throw permanent('DOCX content does not match its MIME type','MIME_MISMATCH');
   const mammoth=await import('npm:mammoth@1.10.0');return (await mammoth.extractRawText({arrayBuffer:bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)})).value;
  }
  if(type==='application/pdf') {
  if(decode(bytes.slice(0,5))!=='%PDF-')throw permanent('PDF content does not match its MIME type','MIME_MISMATCH');
   const {getDocumentProxy,extractText}=await import('npm:unpdf@1.3.2');const pdf=await getDocumentProxy(bytes);return (await extractText(pdf,{mergePages:true})).text;
 }
 throw permanent('Unsupported source content type','UNSUPPORTED_SOURCE_TYPE');
}

async function loadWebsite(source,options) {
 const root=await validatePublicHttps(source.origin,{resolveDns:options.resolveDns});const queue=[root.href],seen=new Set(),pages=[];
 while(queue.length&&pages.length<MAX_PAGES){const next=queue.shift();if(seen.has(next))continue;seen.add(next);const response=await secureFetch(next,{...options,maxBytes:WEB_LIMIT,expectedOrigin:root.origin});if(!['text/html','text/plain','text/markdown'].includes(response.contentType))throw permanent('Website returned an unsupported content type','UNSUPPORTED_SOURCE_TYPE');const raw=decode(response.bytes);pages.push(`Source: ${response.url.href}\n${response.contentType==='text/html'?htmlToText(raw):raw}`);if(response.contentType==='text/html')for(const link of htmlLinks(raw,response.url))if(!seen.has(link))queue.push(link);}
 return {text:pages.join('\n\n'),meta:{pages:[...seen].slice(0,pages.length),pageCount:pages.length}};
}
async function loadFile(source,options) {
 const project=options.supabaseUrl || env('SUPABASE_URL'),key=options.serviceRoleKey || env('SUPABASE_SERVICE_ROLE_KEY');
 if(!project||!key) throw permanent('Storage access is not configured','STORAGE_NOT_CONFIGURED');
 const path=source.storage_path.split('/').map(encodeURIComponent).join('/');
 const response=await options.fetchImpl(`${project}/storage/v1/object/business-knowledge/${path}`,{headers:{Authorization:`Bearer ${key}`,apikey:key}});
 if(!response.ok) throw Object.assign(new Error('Could not read private knowledge file'),{code:`STORAGE_${response.status}`,permanent:response.status===404});
 const bytes=await boundedBody(response,FILE_LIMIT);const type=(response.headers.get('content-type')||'application/octet-stream').split(';')[0].toLowerCase();
 return {text:await extract(bytes,type),meta:{contentType:type,bytes:bytes.byteLength,storagePath:source.storage_path}};
}

export async function processKnowledge(job,db,{fetchImpl=fetch,resolveDns=defaultResolve,supabaseUrl,serviceRoleKey}={}) {
 try{
  const ctx=await db.call('knowledge_job_context',job.id,job.lease_token),source=ctx.source;if(!source)throw permanent('Knowledge source not found','SOURCE_NOT_FOUND');
  const options={fetchImpl,resolveDns,supabaseUrl,serviceRoleKey};let loaded;
  if(source.type==='website') loaded=await loadWebsite(source,options);
  else if(source.type==='file') loaded=await loadFile(source,options);
  else loaded={text:String(source.origin || ''),meta:{manual:true}};
  const text=String(loaded.text || '').trim();if(text.length<20)throw permanent('No useful text could be extracted; scanned documents require OCR and are not supported in v1','EMPTY_EXTRACTION');if(text.length>5*1024*1024)throw permanent('Extracted text is too large','EXTRACTION_TOO_LARGE');
  const chunks=chunkText(text).map(content=>({content,precedence:source.type==='manual'?20:30,metadata:{sourceUrl:source.origin || null}}));
  return db.call('complete_knowledge_ingest',job.id,job.lease_token,{text,content_hash:await sha256(text),chunks,meta:loaded.meta});
 }catch(error){if(error.permanent||job.attempts>=5)await db.call('fail_knowledge_job',job.id,job.lease_token,error.code||'INGEST_FAILED').catch(()=>{});throw error;}
}
