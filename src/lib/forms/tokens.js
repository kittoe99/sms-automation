import {SignJWT,jwtVerify} from 'jose';
function key(secret=process.env.FORMS_SIGNING_SECRET) {
  if(!secret||secret.length<32) throw new Error('FORMS_SIGNING_SECRET must contain at least 32 characters');
  return new TextEncoder().encode(secret);
}
export function signFormToken(claims,audience,expires='1h',secret) {
  return new SignJWT(claims).setProtectedHeader({alg:'HS256'}).setIssuer('sms-form-builder').setAudience(audience).setIssuedAt().setExpirationTime(expires).sign(key(secret));
}
export async function verifyFormToken(token,audience,secret) {
  try{return (await jwtVerify(token,key(secret),{algorithms:['HS256'],issuer:'sms-form-builder',audience,requiredClaims:['iat','exp']})).payload;}
  catch {throw Object.assign(new Error('Invalid or expired form authorization'),{status:401});}
}
