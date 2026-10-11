// Cache only bounded directory/summary reads, never credentials, detail records,
// transcripts, permission/bootstrap responses, provider actions or arbitrary URLs.
export const CACHE_TTL = 60_000;
export const CACHE_KEY = 'e2-crm:workspace:v1';
const paths = new Set(['/api/overview','/api/categories','/api/sms/connection','/api/web-forms',
  '/api/directory','/api/conversations','/api/bookings','/api/messages','/api/opt-outs',
  '/api/deliverability','/api/platform/accounts','/api/platform/businesses','/api/platform/websites']);
export function cacheableRead(path, options = {}) {
  if ((options.method || 'GET').toUpperCase() !== 'GET' || options.cache === 'no-store' || options.cache === 'reload') return false;
  if (!path.startsWith('/api/')) return false;
  const url = new URL(path, 'https://crm.invalid');
  if (!paths.has(url.pathname)) return false;
  // Only the default first page. Search results, filters and individual records stay live.
  return [...url.searchParams].every(([key,value]) =>
    key === 'page' ? value === '1' : key === 'pageSize' ? ['25','50'].includes(value) : key === 'q' && value === '');
}
const responseFrom = entry => new Response(entry.body, {status:200,headers:{'Content-Type':'application/json'}});
const requestKey = path => {const url=new URL(path,'https://crm.invalid');url.searchParams.sort();return url.pathname+url.search;};

export function createWorkspaceCache({storage = () => globalThis.sessionStorage, now = Date.now, maxBytes = 1_000_000, maxEntries = 32} = {}) {
  let scope = null, generation = 0;
  const entries = new Map(), pending = new Map();
  const remove = () => {try {storage()?.removeItem(CACHE_KEY);} catch { /* Storage may be disabled. */ }};
  function invalidate() {generation++;entries.clear();pending.clear();remove();}
  function activate(next) {
    if (scope === next) return;
    generation++;scope=next;entries.clear();pending.clear();
    // Called only after a fresh server-authorized workspace bootstrap.
    try {
      const saved=JSON.parse(storage()?.getItem(CACHE_KEY) || 'null');
      remove();
      if (scope && saved?.scope === scope && Array.isArray(saved.entries)) {
        for (const [key,entry] of saved.entries.slice(0,maxEntries)) {
          if (typeof key === 'string' && cacheableRead(key) && valid(entry)) entries.set(key,entry);
        }
        persist();
      }
    } catch {remove();}
  }
  function valid(entry) {
    return entry && typeof entry.body === 'string' && entry.body.length <= 128_000 &&
      Number.isFinite(entry.at) && entry.at <= now() && now()-entry.at < CACHE_TTL;
  }
  function persist() {
    for (const [key,entry] of entries) if (!valid(entry)) entries.delete(key);
    let serialized=JSON.stringify({scope,entries:[...entries]});
    while (entries.size && (entries.size>maxEntries || serialized.length*2>maxBytes)) {
      entries.delete(entries.keys().next().value);serialized=JSON.stringify({scope,entries:[...entries]});
    }
    try {storage()?.setItem(CACHE_KEY,serialized);} catch {remove();}
  }
  async function fetch(path, options, fetcher) {
    options.signal?.throwIfAborted();
    if (!scope || !cacheableRead(path,options)) return fetcher(options);
    const key=requestKey(path), entry=entries.get(key);
    if (valid(entry)) return responseFrom(entry);
    entries.delete(key);
    let job=pending.get(key);
    if (!job) {
      const controller=new AbortController(), started=generation;
      job={controller,users:0};
      // Each caller has its own cancellation; navigating away from a warmup must
      // not cancel a foreground caller that has joined the same network read.
      job.promise=Promise.resolve().then(()=>fetcher({...options,signal:controller.signal})).then(async response=>{
        if (response.status===401 || response.status===403) invalidate();
        if (response.status===200 && response.headers.get('Content-Type')?.includes('application/json')) {
          const body=await response.clone().text();
          if (started===generation && !controller.signal.aborted && body.length<=128_000) {
            // Reject malformed JSON rather than persisting a broken page.
            try {JSON.parse(body);entries.set(key,{body,at:now()});persist();} catch { /* Retry via network next time. */ }
          }
        }
        return response;
      }).finally(()=>{job.settled=true;if(pending.get(key)===job)pending.delete(key);});
      pending.set(key,job);
    }
    job.users++;
    return new Promise((resolve,reject)=>{
      let done=false;
      const finish=(callback,value)=>{
        if(done)return;done=true;options.signal?.removeEventListener('abort',abort);
        if(--job.users===0){if(!job.settled)job.controller.abort();if(pending.get(key)===job)pending.delete(key);}
        callback(value);
      };
      const abort=()=>finish(reject,options.signal.reason);
      options.signal?.addEventListener('abort',abort,{once:true});
      job.promise.then(response=>finish(resolve,response.clone()),error=>finish(reject,error));
      if(options.signal?.aborted)abort();
    });
  }
  return {activate,invalidate,fetch};
}
