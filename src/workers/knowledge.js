import {isPublicIp,publicHttpsUrl,resolvePublicHost,fetchPublicHttps,readBoundedBody,abortable,deadline} from '../lib/publicHttps.js';
export {isPublicIp};
const WEB_LIMIT=2*1024*1024;
const FILE_LIMIT=10*1024*1024;
const MAX_PAGES=5;
const env=name=>globalThis.Deno?.env.get(name) ?? globalThis.process?.env[name];
const permanent=(message,code)=>Object.assign(new Error(message),{code,permanent:true});

export async function validatePublicHttps(value,options={}) {
 const url=publicHttpsUrl(value),scope=deadline(12000,options.signal);
 try{await resolvePublicHost(url,{...options,signal:scope.signal});return url;}finally{scope.close();}
}

export async function secureFetch(urlValue,options={}) {
 return fetchPublicHttps(urlValue,{maxBytes:WEB_LIMIT,...options,expectedOrigin:options.expectedOrigin||publicHttpsUrl(urlValue).origin});
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
 const root=publicHttpsUrl(source.origin);const queue=[root.href],seen=new Set(),pages=[];
 while(queue.length&&pages.length<MAX_PAGES){const next=queue.shift();if(seen.has(next))continue;seen.add(next);const response=await secureFetch(next,{...options,maxBytes:WEB_LIMIT,expectedOrigin:root.origin});if(!['text/html','text/plain','text/markdown'].includes(response.contentType))throw permanent('Website returned an unsupported content type','UNSUPPORTED_SOURCE_TYPE');const raw=decode(response.bytes);pages.push(`Source: ${response.url.href}\n${response.contentType==='text/html'?htmlToText(raw):raw}`);if(response.contentType==='text/html')for(const link of htmlLinks(raw,response.url))if(!seen.has(link))queue.push(link);}
 return {text:pages.join('\n\n'),meta:{pages:[...seen].slice(0,pages.length),pageCount:pages.length}};
}
async function loadFile(source,options) {
 const project=options.supabaseUrl || env('SUPABASE_URL'),key=options.serviceRoleKey || env('SUPABASE_SERVICE_ROLE_KEY');
 if(!project||!key) throw permanent('Storage access is not configured','STORAGE_NOT_CONFIGURED');
 const path=source.storage_path.split('/').map(encodeURIComponent).join('/');
 // Storage's configured project URL is trusted; never forward its credentials
 // through a redirect to a source-controlled host.
 const response=await abortable((options.fetchImpl||fetch)(`${project}/storage/v1/object/business-knowledge/${path}`,{redirect:'error',signal:options.signal,headers:{Authorization:`Bearer ${key}`,apikey:key}}),options.signal);
 if(!response.ok) throw Object.assign(new Error('Could not read private knowledge file'),{code:`STORAGE_${response.status}`,permanent:response.status===404});
 const bytes=await readBoundedBody(response,FILE_LIMIT,options.signal);const type=(response.headers.get('content-type')||'application/octet-stream').split(';')[0].toLowerCase();
 return {text:await abortable((options.extractImpl||extract)(bytes,type,{signal:options.signal}),options.signal),meta:{contentType:type,bytes:bytes.byteLength,storagePath:source.storage_path}};
}

export async function processKnowledge(job,db,{fetchImpl,resolveDns,supabaseUrl,serviceRoleKey,extractImpl,signal,timeoutMs=30000}={}) {
 // Thirty seconds for reads/extraction leaves time for the database completion
 // or retry and Edge slot release before the 40s batch and 120s job lease.
 const scope=deadline(Math.min(timeoutMs,30000),signal,'KNOWLEDGE_TIMEOUT');
 try{
  const ctx=await abortable(db.call('knowledge_job_context',job.id,job.lease_token),scope.signal),source=ctx.source;if(!source)throw permanent('Knowledge source not found','SOURCE_NOT_FOUND');
  const options={fetchImpl,resolveDns,supabaseUrl,serviceRoleKey,extractImpl,signal:scope.signal};let loaded;
  if(source.type==='website') loaded=await loadWebsite(source,options);
  else if(source.type==='file') loaded=await loadFile(source,options);
  else loaded={text:String(source.origin || ''),meta:{manual:true}};
  scope.check();
  const text=String(loaded.text || '').trim();if(text.length<20)throw permanent('No useful text could be extracted; scanned documents require OCR and are not supported in v1','EMPTY_EXTRACTION');if(text.length>5*1024*1024)throw permanent('Extracted text is too large','EXTRACTION_TOO_LARGE');
  const chunks=chunkText(text).map(content=>({content,precedence:source.type==='manual'?20:30,metadata:{sourceUrl:source.origin || null}}));
  scope.check();const content_hash=await abortable(sha256(text),scope.signal);scope.check();
  return await db.call('complete_knowledge_ingest',job.id,job.lease_token,{text,content_hash,chunks,meta:loaded.meta});
 }catch(error){if(error.permanent||job.attempts>=5)await db.call('fail_knowledge_job',job.id,job.lease_token,error.code||'INGEST_FAILED').catch(()=>{});throw error;}
 finally{scope.close();}
}
