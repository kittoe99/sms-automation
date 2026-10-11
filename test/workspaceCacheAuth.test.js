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
  auth.configureWorkspaceCache({...access,tenants:[{id:'beta',smsRead:false,formsManage:true}]});assert.equal(disk.size,0);
  await auth.signOut();assert.equal(disk.size,0);
});
