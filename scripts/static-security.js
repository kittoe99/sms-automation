import {createHash} from 'node:crypto';
import {readFile,writeFile} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

export async function staticSecurityHeaders() {
  const config=JSON.parse(await readFile(new URL('../config/environments/production.json',import.meta.url),'utf8'));
  const html=(await readFile(new URL('../public/index.html',import.meta.url),'utf8')).replaceAll('\r\n','\n');
  const inline=[...html.matchAll(/<script\b(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)]
    .map(([,body])=>`'sha256-${createHash('sha256').update(body).digest('base64')}'`);
  const policy=["default-src 'self'",
    `script-src 'self' ${inline.join(' ')} ${config.clerkOrigin} https://challenges.cloudflare.com https://*.protect.clerk.com`,
    "style-src 'self' 'unsafe-inline'", "img-src 'self' data: blob: https://img.clerk.com", "font-src 'self'",
    `connect-src 'self' ${config.supabaseUrl} ${config.supabaseUrl.replace('https:','wss:')} ${new URL(config.hostingApiBase).origin} ${config.clerkOrigin} https://*.protect.clerk.com:* https://clerk-telemetry.com https://*.clerk-telemetry.com https://*.r2.cloudflarestorage.com https://*.twilio.com`,
    `media-src 'self' blob: ${config.supabaseUrl}`,
    "worker-src 'self' blob:",
    "frame-src 'self' https://challenges.cloudflare.com https://*.protect.clerk.com https://inquiry.withpersona.com https://*.twilio.com",
    "object-src 'none'", "base-uri 'none'", "form-action 'self'", 'upgrade-insecure-requests'].join('; ');
  // Separate non-overlapping framing rules preserve third-party public form embeds.
  // Unknown application URLs redirect to /, where this policy is enforced.
  return [
    {path:'/*',name:'Content-Security-Policy',value:policy},
    ...['/','/index.html','/email-unsubscribe.html'].map(path=>({path,name:'X-Frame-Options',value:'DENY'})),
    ...['/','/index.html','/email-unsubscribe.html'].map(path=>({path,name:'Content-Security-Policy',value:`${policy}; frame-ancestors 'none'`})),
    {path:'/*',name:'Permissions-Policy',value:'camera=(self "https://inquiry.withpersona.com"), microphone=("https://inquiry.withpersona.com"), geolocation=(), payment=(), usb=()'},
    ...['/','/index.html'].map(path=>({path,name:'Cache-Control',value:'no-cache'})),
  ];
}
export async function securityBlock() {
  return ['    # BEGIN GENERATED SECURITY HEADERS (npm run headers:generate)',
    ...(await staticSecurityHeaders()).flatMap(h=>[`      - path: ${h.path}`,`        name: ${h.name}`,`        value: ${JSON.stringify(h.value)}`]),
    '    # END GENERATED SECURITY HEADERS'].join('\n');
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const file=new URL('../render.yaml',import.meta.url),text=(await readFile(file,'utf8')).replaceAll('\r\n','\n'),block=await securityBlock();
  const pattern=/    # BEGIN GENERATED SECURITY HEADERS[\s\S]*?    # END GENERATED SECURITY HEADERS/;
  if(process.argv.includes('--check')) {
    if(text.match(pattern)?.[0]!==block)throw new Error('Render security headers drifted; run npm run headers:generate');
    if(!/type: redirect\s+source: \/\*\s+destination: \//.test(text))throw new Error('Unknown app routes must redirect to the protected root document');
    console.log('Static deployment headers match reviewed policy.');
  } else await writeFile(file,pattern.test(text)?text.replace(pattern,()=>block):`${text.trimEnd()}\n${block}\n`);
}
