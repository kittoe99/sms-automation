import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {testDatabase,call} from './helpers/database.js';
import {RUNTIME_TENANT as tenant} from '../supabase/functions/voice-runtime/handler.js';
import {VOICES,voiceLabel,validateConfiguration} from '../public/voiceWorkspace.js';
import {voiceConfiguration,voiceTools} from '../src/mcp/voiceSchemas.js';

// Added to OpenAI's GPT-Live voice table on October 16, 2026.
const NEW_VOICES=['nuri','juni','flitz','brise','sillage','nira','harema','shida','noeul'];
const base={name:'Opek phone',persona:'',voice:'Speak clearly',brain:'Use approved facts',voiceName:'marin'};

test('new GPT-Live voices are offered with language labels and validated by client and MCP',()=>{
 for(const v of NEW_VOICES){
  assert.ok(VOICES.includes(v),v);
  validateConfiguration({...base,voiceName:v});voiceConfiguration.parse({...base,voiceName:v});
 }
 assert.equal(voiceLabel('harema'),'harema (Japanese, feminine)');
 assert.equal(voiceLabel('sillage'),'sillage (French, masculine)');
 assert.throws(()=>voiceConfiguration.parse({...base,voiceName:'cedar'}),'unlisted names stay rejected');
 assert.deepEqual(voiceConfiguration.shape.voiceName.options,VOICES,'Zod enum and picker list match');
});

test('database saves, publishes and serves a new GPT-Live voice; stored MCP schemas match Zod',async()=>{
 const db=await testDatabase();try{
  const workspace=(action,p={})=>call(db,'voice_workspace','admin',tenant,action,p);
  await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'Voice CRM',timeZone:'UTC'});
  await db.query("update sms_private.providers set from_number='+18777574365' where tenant_id=$1",[tenant]);
  await workspace('initialize',{configuration:base});
  let a=(await workspace('overview')).agents[0];
  await assert.rejects(()=>workspace('save',{agentId:a.id,version:a.draft_version,configuration:{...base,voiceName:'cedar'}}),/supported voice/);
  await workspace('save',{agentId:a.id,version:a.draft_version,configuration:{...base,voiceName:'nuri'}});
  a=(await workspace('overview')).agents[0];assert.equal(a.draft.voiceName,'nuri');
  await workspace('publish',{agentId:a.id,version:a.draft_version});
  const runtime=(await db.query('select voice_runtime_api.dispatch($1,$2,$3,$4) result',[tenant,'phone-job-gpt-live-voice','configuration','{}'])).rows[0].result;
  assert.equal(runtime.configuration.voiceName,'nuri');
  for(const [name,,shape] of voiceTools.filter(t=>['crm_create_voice_agent','crm_save_voice_draft'].includes(t[0]))){
   const stored=(await db.query('select schema from sms_private.mcp_input_schemas where tool=$1',[name])).rows[0].schema;
   for(const v of NEW_VOICES)assert.ok(stored.properties.configuration.properties.voiceName.enum.includes(v),`${name} ${v}`);
   assert.deepEqual(stored,zodToJsonSchema(z.object(shape).strict(),{$refStrategy:'none'}),name);
  }
 }finally{await db.close();}
});
