import { isIP } from 'node:net';

export const sourceError = (message, code, permanent = true) => Object.assign(new Error(message), { code, permanent });
const bareHost = value => String(value).toLowerCase().replace(/^\[|\]$/g, '');

// Accept routable unicast only. Decode mapped IPv4 before classifying it: URL
// canonicalization writes ::ffff:127.0.0.1 as ::ffff:7f00:1.
export function isPublicIp(value) {
  const ip = bareHost(value), family = isIP(ip);
  if (family === 4) {
    const [a,b,c] = ip.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2) || b === 88 && c === 99)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) || (a === 203 && b === 0 && c === 113));
  }
  if (family !== 6 || ip.includes('%')) return false;
  const canonical = bareHost(new URL(`https://[${ip}]/`).hostname);
  const [left,right] = canonical.split('::');
  const head = left ? left.split(':') : [], tail = right ? right.split(':') : [];
  const words = [...head, ...Array(8-head.length-tail.length).fill('0'), ...tail].map(x => parseInt(x,16));
  if (words.slice(0,5).every(x => x === 0) && words[5] === 0xffff) {
    return isPublicIp(`${words[6] >>> 8}.${words[6] & 255}.${words[7] >>> 8}.${words[7] & 255}`);
  }
  return (words[0] & 0xe000) === 0x2000 && words[0] !== 0x2002 &&
    !(words[0] === 0x2001 && (words[1] < 0x0200 || words[1] === 0x0db8)) &&
    !(words[0] === 0x3fff && words[1] < 0x1000);
}

export function publicHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw sourceError('Invalid source URL', 'INVALID_SOURCE_URL'); }
  const host = bareHost(url.hostname).replace(/\.$/,'');
  if (url.protocol !== 'https:' || url.username || url.password || url.port && url.port !== '443' ||
      host === 'localhost' || /\.(?:localhost|local|internal)$/.test(host) || (isIP(host) && !isPublicIp(host))) {
    throw sourceError('Only public HTTPS URLs are allowed', 'UNSAFE_SOURCE_URL');
  }
  return url;
}

export function deadline(milliseconds, parent, code = 'SOURCE_TIMEOUT') {
  const controller = new AbortController();
  const expiresAt = Date.now() + milliseconds;
  const expire = () => controller.abort(sourceError('Source processing timed out', code, false));
  const stop = () => controller.abort(parent.reason);
  if (parent?.aborted) stop(); else parent?.addEventListener('abort', stop, { once:true });
  const timer = setTimeout(expire, milliseconds);
  return { signal:controller.signal, check() { if(Date.now() >= expiresAt) expire(); controller.signal.throwIfAborted(); },
    close() { clearTimeout(timer); parent?.removeEventListener('abort',stop); } };
}

export function abortable(value, signal) {
  if (!signal) return Promise.resolve(value);
  return new Promise((resolve,reject) => {
    const abort = () => reject(signal.reason || sourceError('Source processing timed out','SOURCE_TIMEOUT',false));
    if (signal.aborted) { Promise.resolve(value).catch(() => {}); abort(); return; }
    signal.addEventListener('abort',abort,{once:true});
    Promise.resolve(value).then(resolve,reject).finally(() => signal.removeEventListener('abort',abort));
  });
}

export async function resolvePublicHost(url, {resolveDns, signal} = {}) {
  signal?.throwIfAborted();
  const host = bareHost(url.hostname);
  let addresses;
  if (isIP(host)) addresses = [host];
  else if (resolveDns) addresses = await abortable(resolveDns(host),signal);
  else {
    const {lookup} = await import('node:dns/promises');
    addresses = (await abortable(lookup(host,{all:true}),signal)).map(row => row.address);
  }
  if (!addresses.length || addresses.some(ip => !isPublicIp(ip))) {
    throw sourceError('Source URL resolves to a private or reserved address','UNSAFE_SOURCE_URL');
  }
  return bareHost(addresses[0]);
}

export async function readBoundedBody(response, limit, signal) {
  if (Number(response.headers.get('content-length') || 0) > limit) {
    response.body?.cancel().catch(() => {});
    throw sourceError('Source is too large','SOURCE_TOO_LARGE');
  }
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = []; let total = 0;
  try {
    for (;;) {
      const {done,value} = await abortable(reader.read(),signal);
      if (done) break;
      total += value.byteLength;
      if (total > limit) throw sourceError('Source is too large','SOURCE_TOO_LARGE');
      chunks.push(value);
    }
  } catch (error) { reader.cancel().catch(() => {}); throw error; }
  finally { reader.releaseLock(); }
  const output = new Uint8Array(total); let offset = 0;
  for (const chunk of chunks) { output.set(chunk,offset); offset += chunk.byteLength; }
  return output;
}

// Connect to the validated literal address, never re-resolve the untrusted host
// in fetch. Keep the original TLS identity and HTTP Host. node:https is available
// in Node and Deno; unsupported runtimes fail closed instead of using plain fetch.
export async function pinnedHttpsRequest(url, address, {signal, headers, requestImpl} = {}) {
  const request = requestImpl || (await import('node:https')).request;
  const hostname = bareHost(url.hostname);
  return abortable(new Promise((resolve,reject) => {
    const req = request({protocol:'https:',hostname:address,port:443,method:'GET',
      path:url.pathname + url.search,servername:isIP(hostname) ? undefined : hostname,
      headers:{...headers,host:url.host,'accept-encoding':'identity'},agent:false,
      rejectUnauthorized:true,signal,maxHeaderSize:16384}, incoming => {
      const responseHeaders = new Headers();
      for (const [name,value] of Object.entries(incoming.headers)) if (value !== undefined) {
        responseHeaders.set(name,Array.isArray(value) ? value.join(', ') : value);
      }
      const body = new ReadableStream({
        start(controller) {
          incoming.pause();
          incoming.on('data',chunk => { controller.enqueue(new Uint8Array(chunk)); incoming.pause(); });
          incoming.once('end',() => controller.close());
          incoming.once('error',error => controller.error(error));
          incoming.once('aborted',() => controller.error(sourceError('Source connection closed','SOURCE_CONNECTION_CLOSED',false)));
        },
        pull() { incoming.resume(); },
        cancel() { incoming.destroy(); req.destroy(); },
      });
      resolve({status:incoming.statusCode,ok:incoming.statusCode >= 200 && incoming.statusCode < 300,headers:responseHeaders,body});
    });
    req.once('error',reject);
    req.end();
  }),signal);
}

export async function fetchPublicHttps(value, {resolveDns,fetchImpl,requestImpl,maxBytes=2*1024*1024,
  expectedOrigin,signal,timeoutMs=12000,headers={accept:'text/html,text/plain'}} = {}) {
  const scope = deadline(timeoutMs,signal);
  try {
    scope.check();
    let url = publicHttpsUrl(value);
    for (let redirects = 0; redirects <= 5; redirects++) {
      url = publicHttpsUrl(url.href);
      if (expectedOrigin && url.origin !== expectedOrigin) throw sourceError('Cross-origin crawl denied','CROSS_ORIGIN_REDIRECT');
      const address = await resolvePublicHost(url,{resolveDns,signal:scope.signal});
      scope.check();
      // fetchImpl is an explicit test transport; production always pins the IP.
      const response = await abortable(fetchImpl ? fetchImpl(url.href,{redirect:'manual',headers,signal:scope.signal}) :
        pinnedHttpsRequest(url,address,{signal:scope.signal,headers,requestImpl}),scope.signal);
      if (response.status >= 300 && response.status < 400) {
        response.body?.cancel().catch(() => {});
        const location = response.headers.get('location');
        if (!location) throw sourceError('Invalid source redirect','INVALID_SOURCE_REDIRECT');
        url = new URL(location,url); continue;
      }
      if (!response.ok) { response.body?.cancel().catch(() => {}); throw sourceError(`Source returned ${response.status}`,`SOURCE_HTTP_${response.status}`,response.status < 500); }
      if (response.headers.get('content-encoding') && response.headers.get('content-encoding') !== 'identity') {
        response.body?.cancel().catch(() => {});
        throw sourceError('Compressed source responses are unsupported','UNSUPPORTED_SOURCE_ENCODING');
      }
      const bytes=await readBoundedBody(response,maxBytes,scope.signal);scope.check();
      return {url,contentType:(response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase(),bytes};
    }
    throw sourceError('Too many source redirects','TOO_MANY_REDIRECTS');
  } finally { scope.close(); }
}
