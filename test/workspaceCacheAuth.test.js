import test from 'node:test';
import assert from 'node:assert/strict';

test('the authenticated client gates persistence, scopes businesses, bypasses bootstrap and invalidates writes',async t=>{
  const originals=Object.fromEntries(['fetch','document','localStorage','sessionStorage'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,value] of Object.entries(originals))if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];});
  const disk=new Map(),calls=[];let tenant='alpha';
  globalThis.sessionStorage={getItem:key=>disk.get(key),setItem:(key,value)=>disk.set(key,value),removeItem:key=>disk.delete(key)};
  globalThis.localStorage={getItem:()=>tenant,setItem:(_key,value)=>{tenant=value;}};
  globalThis.document={getElementById:()=>null};
  globalThis.fetch=async(path,options)=>{
    if(path==='/api/auth/config')return Response.json({mode:'local'});
    calls.push({path,tenant:options.headers.get('X-Tenant-ID'),method:options.method||'GET'});
    return Response.json({version:calls.length});
  };
  const auth=await import('../public/auth.js?cache-integration');await auth.initAuth();
  const read=()=>auth.apiFetch('/api/overview').then(response=>response.json());
  await read();await read();assert.equal(calls.length,2);assert.equal(disk.size,0);
  const access={tenants:[{id:'alpha',smsRead:true}],capabilities:{platformStaff:true}};
  auth.configureWorkspaceCache(access);const first=await read();assert.deepEqual(await read(),first);
  assert.equal(calls.length,3);assert.equal(disk.size,1);
  assert.doesNotMatch([...disk.values()][0],/Bearer |Authorization/);
  await auth.apiFetch('/api/auth/me',{tenant:false});await auth.apiFetch('/api/auth/me',{tenant:false});assert.equal(calls.length,5);
  await auth.apiFetch('/api/bookings/id/cancel',{method:'POST',body:'{}'});assert.equal(disk.size,0);
  assert.notDeepEqual(await read(),first);
  auth.setTenantId('beta');const next=await read();assert.equal(calls.at(-1).tenant,'beta');assert.equal(disk.size,0);
  auth.configureWorkspaceCache({...access,tenants:[{id:'beta',smsRead:true}]});assert.notDeepEqual(await read(),next);
  const count=calls.length;await auth.apiFetch('/api/overview',{tenant:false,headers:{'X-Tenant-ID':'alpha'}});assert.equal(calls.length,count+1);
  await auth.apiFetch('/api/web-forms',{headers:{'X-Tenant-ID':'alpha'}});
  assert.equal(calls.at(-1).tenant,'alpha','explicit website business is not replaced by selected beta');
  const foreignReads=calls.length;await auth.apiFetch('/api/web-forms',{headers:{'X-Tenant-ID':'alpha'}});
  assert.equal(calls.length,foreignReads+1,'foreign business reads bypass selected-business cache');
  auth.setTenantId('alpha');const started=auth.apiFetch('/api/directory?race=1');auth.setTenantId('beta');await started;
  assert.equal(calls.at(-1).tenant,'alpha','a started request keeps its tenant while token retrieval yields to a switch');
  auth.configureWorkspaceCache({...access,tenants:[{id:'beta',smsRead:false,formsManage:true}]});assert.equal(disk.size,0);
  await auth.signOut();assert.equal(disk.size,0);
});

test('session switches reject old tokens and responses before they can enter the new account cache',async t=>{
  const originals=Object.fromEntries(['fetch','document','Clerk','localStorage','sessionStorage','window'].map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  t.after(()=>{for(const [key,value] of Object.entries(originals))if(value)Object.defineProperty(globalThis,key,value);else delete globalThis[key];});
  const disk=new Map(),listeners=[],events=[],calls=[];
  globalThis.sessionStorage={getItem:key=>disk.get(key),setItem:(key,value)=>disk.set(key,value),removeItem:key=>disk.delete(key)};
  globalThis.localStorage={getItem:()=> 'alpha'};
  globalThis.window={dispatchEvent:event=>events.push(event.type)};
  globalThis.document={getElementById:()=>null,
    createElement:()=>{const events={};return {setAttribute(){},addEventListener:(name,fn)=>{events[name]=fn;},loaded:()=>events.load()};},
    head:{appendChild:script=>script.loaded()}};
  let releaseToken;
  globalThis.Clerk={user:{id:'user-a'},session:{id:'session-a',getToken:()=>new Promise(resolve=>{releaseToken=resolve;})},load:async()=>{},
    addListener:fn=>{listeners.push(fn);return ()=>{};}};
  let releaseResponse;
  globalThis.fetch=async(url,options)=>{
    if(url.endsWith('/auth/config'))return Response.json({configured:true,publishableKey:'pk_test_fixture',frontendApiUrl:'https://clerk.example.test'});
    const owner=options.headers.get('Authorization');calls.push(owner);
    if(url.includes('delayed'))return new Promise(resolve=>{releaseResponse=()=>resolve(Response.json({owner}));});
    return Response.json({owner});
  };
  const auth=await import('../public/auth.js?session-cache-fence');await auth.initAuth();
  const access={tenants:[{id:'alpha',smsRead:true}],capabilities:{platformStaff:true}};
  auth.configureWorkspaceCache(access);
  const pending=auth.apiFetch('/api/overview');
  const staleToken=assert.rejects(pending,{name:'AbortError'});
  const switchAccount=id=>{
    globalThis.Clerk.user={id:`user-${id}`};
    globalThis.Clerk.session={id:`session-${id}`,getToken:async()=>`token-${id}`};
    listeners.forEach(fn=>fn({session:globalThis.Clerk.session}));
    auth.configureWorkspaceCache(access);
  };
  switchAccount('b');releaseToken('token-a');await staleToken;
  assert.deepEqual(calls,[],'an old token must not start a request under the new cache scope');
  assert.deepEqual(events,['clerk:session-changed']);
  listeners.forEach(fn=>fn({session:globalThis.Clerk.session}));assert.equal(events.length,1);
  const read=()=>auth.apiFetch('/api/overview').then(response=>response.json());
  assert.deepEqual(await read(),{owner:'Bearer token-b'});
  assert.deepEqual(await read(),{owner:'Bearer token-b'});assert.equal(calls.length,1);
  const delayed=auth.apiFetch('/api/overview?delayed=1');
  const staleResponse=assert.rejects(delayed,{name:'AbortError'});
  while(!releaseResponse)await new Promise(resolve=>setTimeout(resolve,0));
  switchAccount('c');releaseResponse();await staleResponse;
  assert.deepEqual(await read(),{owner:'Bearer token-c'});
  assert.doesNotMatch([...disk.values()].join(''),/token-a|token-b/);
});
