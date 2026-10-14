import test from 'node:test';
import assert from 'node:assert/strict';
import {frontendConfig} from '../scripts/frontend-config.js';
import {staticSecurityHeaders,securityBlock} from '../scripts/static-security.js';
import {readFile} from 'node:fs/promises';

test('build targets must match a reviewed environment and use a public key',async()=>{
  const env={SUPABASE_PUBLISHABLE_KEY:'sb_publishable_offline_fixture'};
  assert.equal((await frontendConfig(env)).embedBaseUrl,'https://crm.e2local.com');
  for(const changes of [{CRM_ENVIRONMENT:'../secret'},{SUPABASE_URL:'https://other.supabase.co'},
    {CRM_API_BASE:'https://other.test/api'},{HOSTING_API_BASE:'https://other.test/api'},
    {SUPABASE_PUBLISHABLE_KEY:'sb_secret_no'}])await assert.rejects(frontendConfig({...env,...changes}));
});
test('static host protects staff documents, permits public embeds, and pins the inline import map',async()=>{
  const headers=await staticSecurityHeaders();
  const matching=path=>headers.filter(h=>h.path==='/*'||h.path===path);
  for(const path of ['/','/index.html','/email-unsubscribe.html'])assert.ok(matching(path).some(h=>h.name==='Content-Security-Policy'&&h.value.includes("frame-ancestors 'none'")));
  assert.ok(!matching('/embed.html').some(h=>h.name==='X-Frame-Options'||h.value.includes('frame-ancestors')));
  const common=matching('/embed.html').find(h=>h.name==='Content-Security-Policy').value;
  assert.match(common,/script-src 'self' 'sha256-/);assert.doesNotMatch(common,/script-src[^;]*'unsafe-inline'|'unsafe-eval'/);
  assert.match(common,/object-src 'none'/);assert.match(common,/r2\.cloudflarestorage\.com/);
  // Persona's embedded verification requests microphone access; do not delegate
  // it to unrelated embedded origins or the CRM document itself.
  const permissions=headers.find(h=>h.name==='Permissions-Policy').value;
  assert.match(permissions,/(?:^|, )microphone=\("https:\/\/inquiry\.withpersona\.com"\)(?:,|$)/);
  const blueprint=(await readFile(new URL('../render.yaml',import.meta.url),'utf8')).replaceAll('\r\n','\n');
  assert.ok(blueprint.includes(await securityBlock()));
});
