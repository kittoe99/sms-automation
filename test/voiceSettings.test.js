import test from 'node:test';
import assert from 'node:assert/strict';
import {z} from 'zod';
import {zodToJsonSchema} from 'zod-to-json-schema';
import {testDatabase,call} from './helpers/database.js';
import {RUNTIME_TENANT as tenant} from '../supabase/functions/voice-runtime/handler.js';
import {DEFAULT_SETTINGS,normalizeSettings,validateSettings,parsePronunciations,formatPronunciations} from '../public/voiceSettings.js';
import {validateConfiguration} from '../public/voiceWorkspace.js';
import {voiceConfiguration,voiceSettings,voiceTools} from '../src/mcp/voiceSchemas.js';

const base={name:'Opek phone',persona:'',voice:'Speak clearly',brain:'Use approved facts',voiceName:'vesper'};
const full={
 greeting:{spokenName:'Lisa',message:'Thanks for calling!',recordingDisclosure:true,disclosureText:'This call is recorded.'},
 closing:{message:'Have a great day.'},language:{primary:'es',allowSwitching:false},
 conversation:{responseStyle:'brief',allowInterruptions:false,pronunciations:[{term:'Opek',sayAs:'OH-peck'}]},
 silence:{enabled:true,seconds:20,message:'Still there?',hangUpAfter:2},limits:{maxCallMinutes:30,wrapUpMessage:'Out of time.'},
 escalation:{message:'The team will call you back.',offerCallback:true},capabilities:{lookups:true,bookings:false,inCallSms:false},
 backend:{reasoningEffort:'medium',serviceTier:'default'},recording:{audio:false},
};
// Each must fail in every layer: client, MCP (Zod) and database.
const invalid=[
 {greeting:{spokenName:'x'.repeat(61)}},{language:{primary:'xx'}},{silence:{seconds:4}},{silence:{seconds:15.5}},
 {limits:{maxCallMinutes:121}},{backend:{reasoningEffort:'max'}},{recording:{audio:'yes'}},{unknown:{}},
 {greeting:{other:'x'}},{conversation:{pronunciations:[{term:'',sayAs:'x'}]}},
 {conversation:{pronunciations:Array.from({length:51},(_,i)=>({term:`t${i}`,sayAs:'x'}))}},{capabilities:[]},
];

test('client settings defaults, validation and pronunciation parsing',()=>{
 assert.deepEqual(normalizeSettings(),DEFAULT_SETTINGS);
 assert.deepEqual(normalizeSettings({silence:{seconds:30}}).silence,{...DEFAULT_SETTINGS.silence,seconds:30});
 validateSettings(undefined);validateSettings(full);validateSettings(normalizeSettings());
 validateConfiguration({...base,settings:full});
 for(const s of invalid)assert.throws(()=>validateSettings(s),/settings\./,JSON.stringify(s));
 const list=parsePronunciations('Opek = OH-peck\n\n  Sofa=SO-fuh ');
 assert.deepEqual(list,[{term:'Opek',sayAs:'OH-peck'},{term:'Sofa',sayAs:'SO-fuh'}]);
 assert.deepEqual(parsePronunciations(formatPronunciations(list)),list);
 assert.throws(()=>parsePronunciations('no equals sign'),/line 1/);
});

test('MCP contract mirrors the client contract',()=>{
 voiceConfiguration.parse(base);voiceConfiguration.parse({...base,settings:full});voiceSettings.parse(normalizeSettings());
 for(const s of invalid)assert.throws(()=>voiceSettings.parse(s),undefined,JSON.stringify(s));
});

test('database stores, publishes and validates settings; old revisions stay valid',async()=>{
 const db=await testDatabase();try{
  const workspace=(action,p={})=>call(db,'voice_workspace','admin',tenant,action,p);
  await call(db,'api_action','admin',null,'create_business',{id:tenant,name:'Voice CRM',timeZone:'UTC'});
  await db.query("update sms_private.providers set from_number='+18777574365' where tenant_id=$1",[tenant]);
  await workspace('initialize',{configuration:base});
  const runtime=async()=>(await db.query('select voice_runtime_api.dispatch($1,$2,$3,$4) result',[tenant,'phone-job-settings','configuration','{}'])).rows[0].result;
  assert.equal((await runtime()).configuration.settings,undefined,'legacy configuration has no settings');
  let a=(await workspace('overview')).agents[0];
  for(const s of invalid)await assert.rejects(()=>workspace('save',{agentId:a.id,version:a.draft_version,configuration:{...base,settings:s}}),/settings/,JSON.stringify(s));
  await workspace('save',{agentId:a.id,version:a.draft_version,configuration:{...base,settings:full}});
  a=(await workspace('overview')).agents[0];assert.deepEqual(a.draft.settings,full);
  await workspace('publish',{agentId:a.id,version:a.draft_version});
  assert.deepEqual((await runtime()).configuration.settings,full);
  // Stored MCP input schemas are exactly what Zod generates for both write tools.
  for(const [name,,shape] of voiceTools.filter(t=>['crm_create_voice_agent','crm_save_voice_draft'].includes(t[0]))){
   const stored=(await db.query('select schema from sms_private.mcp_input_schemas where tool=$1',[name])).rows[0].schema;
   assert.deepEqual(stored,zodToJsonSchema(z.object(shape).strict(),{$refStrategy:'none'}),name);
  }
 }finally{await db.close();}
});
