import {createClerkClient} from '@clerk/backend';
import {createRemoteJWKSet,jwtVerify} from 'jose';

export function mcpConfig(env=process.env) {
 const resource=new URL(env.MCP_RESOURCE_URL);
 const issuer=new URL(env.CRM_CLERK_ISSUER);
 const customer=new URL(env.E2_CLERK_ISSUER);
 if(resource.protocol!=='https:'||resource.pathname!=='/mcp'||resource.search||resource.hash||resource.username||resource.password
   ||issuer.protocol!=='https:'||customer.protocol!=='https:'||issuer.origin!==env.CRM_CLERK_ISSUER||customer.origin!==env.E2_CLERK_ISSUER||issuer.origin===customer.origin)
  throw new Error('Separate CRM issuer and HTTPS /mcp resource are required');
 if(!env.CRM_CLERK_SECRET_KEY||!env.MCP_DATABASE_URL)throw new Error('MCP credentials are not configured');
 return {resource:resource.href,issuer:issuer.origin,customerIssuer:customer.origin,secretKey:env.CRM_CLERK_SECRET_KEY,
  databaseUrl:env.MCP_DATABASE_URL,origins:(env.MCP_ALLOWED_ORIGINS||'').split(',').map(x=>x.trim()).filter(Boolean)};
}
export function validateOAuthToken(token,config,now=Date.now()/1000) {
 if(!token||token.revoked||token.expired||!Number.isFinite(token.expiration)||token.expiration<=now||token.act
  ||!token.subject?.startsWith('user_')||!token.clientId||token.clientId.length>2048||!token.aud?.includes(config.resource))
  throw Object.assign(new Error('Invalid OAuth token'),{status:401});
 return {subject:token.subject,clientId:token.clientId,issuer:config.issuer};
}
export function createOAuthVerifier(config,{client=createClerkClient({secretKey:config.secretKey}),verifyJwt}={}) {
 const key=createRemoteJWKSet(new URL('/.well-known/jwks.json',config.issuer));
 return async raw=>{
  // JWT access tokens additionally bind issuer/signature; opaque tokens are
  // introspected by the dedicated CRM instance's Backend API credential.
  if(raw.split('.').length===3)await (verifyJwt||jwtVerify)(raw,key,{issuer:config.issuer,audience:config.resource,algorithms:['RS256'],requiredClaims:['sub','exp','iat']});
  const token=await client.idPOAuthAccessToken.verify(raw,{audience:config.resource});
  return validateOAuthToken(token,config);
 };
}
export async function getOAuthMetadata(config,fetcher=fetch) {
 const response=await fetcher(`${config.issuer}/.well-known/oauth-authorization-server`,{signal:AbortSignal.timeout(10000),redirect:'error'});
 if(!response.ok)throw new Error('CRM OAuth discovery is unavailable');
 const metadata=await response.json();
 if(metadata.issuer!==config.issuer||!metadata.code_challenge_methods_supported?.includes('S256')||metadata.client_id_metadata_document_supported!==true)
  throw new Error('CRM OAuth must advertise its issuer, PKCE S256 and CIMD');
 for(const field of ['authorization_endpoint','token_endpoint'])if(new URL(metadata[field]).protocol!=='https:')throw new Error('Invalid OAuth metadata');
 return metadata;
}
