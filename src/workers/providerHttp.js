// No automatic retries: the durable attempt ledger decides whether replay is safe.
export async function providerPost(url,sid,token,params,fetchImpl=fetch) {
 const response=await fetchImpl(url,{method:'POST',signal:AbortSignal.timeout(20000),
  headers:{Authorization:`Basic ${btoa(`${sid}:${token}`)}`,'Content-Type':'application/x-www-form-urlencoded'},body:new URLSearchParams(params)});
 let data;
 try {data=await response.json();} catch {
  throw Object.assign(new Error('Unreadable provider response'),{code:'PROVIDER_RESPONSE_UNKNOWN'});
 }
 if(!response.ok) throw Object.assign(new Error('Provider rejected request'),{status:response.status,code:data.code || `HTTP_${response.status}`});
 if(!data.sid) throw Object.assign(new Error('Missing provider identifier'),{code:'PROVIDER_RESPONSE_UNKNOWN'});
 return data;
}
