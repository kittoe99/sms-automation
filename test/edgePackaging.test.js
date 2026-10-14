import test from 'node:test';
import assert from 'node:assert/strict';
import {collectEdgeFiles} from '../scripts/edge-files.js';

test('deployment closure includes every worker and shared security dependency without secrets',async()=>{
  const files=await collectEdgeFiles(),names=new Set(files.map(f=>f.name));
  for(const name of ['src/workers/knowledge.js','supabase/functions/embedding-worker/index.ts','src/workers/email.js',
    'src/workers/inboundAgent.js','src/lib/websiteEnrich.js','src/lib/publicHttps.js'])assert.ok(names.has(name),name);
  assert.equal(files.length,names.size);
  assert.deepEqual(files,await collectEdgeFiles());
  assert.ok(names.has('public/phoneNormalization.js'));
  assert.ok(files.every(f=>(/^(supabase\/functions|src)\//.test(f.name)||f.name==='public/phoneNormalization.js')&&!f.name.includes('.env')));
});
