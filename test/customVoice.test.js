import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {testDatabase,call} from './helpers/database.js';
import {RUNTIME_TENANT as tenant} from '../supabase/functions/voice-runtime/handler.js';
import {CUSTOM_VOICE_ID,VOICES,voiceLabel,validateConfiguration} from '../public/voiceWorkspace.js';
import {voiceConfiguration,voiceTools} from '../src/mcp/voiceSchemas.js';

const base={name:'Opek phone',persona:'',voice:'Speak clearly',brain:'Use approved facts',voiceName:'marin'};
const custom={...base,voiceName:'voice_6af2d134d92081918a68df7cf07fad38'};
const unknown={...base,voiceName:'voice_00000000000000000000000000000000'};

test('custom OpenAI voice is offered with a readable label and validated by client and MCP',()=>{
 assert.equal(CUSTOM_VOICE_ID,custom.voiceName);
 assert.equal(VOICES.length,14);assert.ok(VOICES.includes(CUSTOM_VOICE_ID));
 assert.equal(voiceLabel(CUSTOM_VOICE_ID),'My new voice (custom, American, masculine)');
 assert.equal(voiceLabel('marin'),'marin');
 validateConfiguration(custom);voiceConfiguration.parse(custom);
 assert.throws(()=>validateConfiguration(unknown),/supported voice/);
 assert.throws(()=>voiceConfiguration.parse(unknown));
 assert.deepEqual(voiceConfiguration.shape.voiceName.options,VOICES,'Zod enum and picker list match');
});

test('database saves and publishes the custom voice; stored MCP schemas accept it',async()=>{
 const db=await testDatabase();try{
  const workspace=(action,p={})=>call(db,'voice_workspace','admin',tenant,action,p);
  await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'Voice CRM',timeZone:'UTC'});
  await db.query("update sms_private.providers set from_number='+18777574365' where tenant_id=$1",[tenant]);
  await workspace('initialize',{configuration:base});
  let a=(await workspace('overview')).agents[0];
  await assert.rejects(()=>workspace('save',{agentId:a.id,version:a.draft_version,configuration:unknown}),/supported voice/);
  await workspace('save',{agentId:a.id,version:a.draft_version,configuration:custom});
  a=(await workspace('overview')).agents[0];assert.equal(a.draft.voiceName,CUSTOM_VOICE_ID);
  await workspace('publish',{agentId:a.id,version:a.draft_version});
  const runtime=(await db.query('select voice_runtime_api.dispatch($1,$2,$3,$4) result',[tenant,'phone-job-custom-voice','configuration','{}'])).rows[0].result;
  assert.equal(runtime.configuration.voiceName,CUSTOM_VOICE_ID);
  for(const [name,,shape] of voiceTools.filter(t=>['crm_create_voice_agent','crm_save_voice_draft'].includes(t[0]))){
   const stored=(await db.query('select schema from sms_private.mcp_input_schemas where tool=$1',[name])).rows[0].schema;
   assert.ok(stored.properties.configuration.properties.voiceName.enum.includes(CUSTOM_VOICE_ID),name);
   assert.deepEqual(stored,zodToJsonSchema(z.object(shape).strict(),{$refStrategy:'none'}),name);
  }
 }finally{await db.close();}
});
