import {env} from '../_shared/http.js';

// This endpoint consumes an operation-specific credential. CRM browser sessions
// and MCP OAuth tokens are deliberately not accepted as upload authorization.
export async function signMcpKnowledgeUpload(db,input,{fetchImpl=fetch,base=env('SUPABASE_URL'),key=env('SUPABASE_SERVICE_ROLE_KEY')}={}) {
 if(!input||Object.keys(input).length!==1||typeof input.ticket!=='string'||!/^[0-9a-f-]{72}$/.test(input.ticket))throw Object.assign(new Error('Upload access denied'),{status:403});
 const intent=await db.call('mcp_consume_upload_ticket',input.ticket);
 if(!base||!key)throw new Error('Storage signing is not configured');
 const url=new URL(base);if(url.protocol!=='https:'||url.pathname!=='/'||url.username||url.password)throw new Error('Invalid storage configuration');
 const path=String(intent.path).split('/').map(encodeURIComponent).join('/');
 const response=await fetchImpl(`${url.origin}/storage/v1/object/upload/sign/business-knowledge/${path}`,{method:'POST',redirect:'error',signal:AbortSignal.timeout(10000),headers:{Authorization:`Bearer ${key}`,apikey:key,'Content-Type':'application/json'},body:'{}'});
 if(!response.ok)throw new Error('Could not sign private upload');
 const result=await response.json(),raw=result.url||result.signedURL||result.signedUrl;
 const signedUrl=new URL(typeof raw==='string'&&raw.startsWith('/object/')?'/storage/v1'+raw:raw,url.origin);
 if(signedUrl.origin!==url.origin||signedUrl.pathname!==`/storage/v1/object/upload/sign/business-knowledge/${path}`||!signedUrl.searchParams.get('token'))throw new Error('Invalid storage signing response');
 return {signedUrl:signedUrl.href};
}
