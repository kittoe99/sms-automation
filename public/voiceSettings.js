// Detailed Voice Agent call settings. Shared by the staff UI (normalize/validate) and
// mirrored by src/mcp/voiceSchemas.js (Zod) and sms_private.validate_voice_settings (SQL).
// Every key is optional: an absent value means today's behavior, so revisions saved before
// these settings existed stay valid and run unchanged.
export const LANGUAGES=[['en','English'],['es','Spanish'],['pt','Portuguese'],['fr','French'],['de','German'],['tl','Tagalog']];
export const RESPONSE_STYLES=[['brief','Brief · one or two sentences'],['balanced','Balanced'],['detailed','Detailed · fuller explanations']];
export const REASONING_EFFORTS=[['low','Low · fastest replies'],['medium','Medium'],['high','High · most careful, slower']];
export const SERVICE_TIERS=[['priority','Priority · fastest'],['default','Standard · lower cost']];
export const LIMITS={spokenName:60,greeting:1000,disclosure:500,closing:1000,checkIn:300,wrapUp:500,escalation:1000,term:80,sayAs:120,pronunciations:50};
export const DEFAULT_SETTINGS=Object.freeze({
 greeting:{spokenName:'',message:'',recordingDisclosure:false,disclosureText:'This call may be recorded for quality and training.'},
 closing:{message:''},
 language:{primary:'en',allowSwitching:true},
 conversation:{responseStyle:'balanced',allowInterruptions:true,pronunciations:[]},
 silence:{enabled:false,seconds:15,message:'Are you still there?',hangUpAfter:2},
 limits:{maxCallMinutes:0,wrapUpMessage:"We're nearly out of time for this call. Let me wrap up your request."},
 escalation:{message:'',offerCallback:true},
 capabilities:{lookups:true,bookings:true,inCallSms:true},
 backend:{reasoningEffort:'low',serviceTier:'priority'},
 recording:{audio:true},
});
const SPEC={
 greeting:{spokenName:['text',LIMITS.spokenName],message:['text',LIMITS.greeting],recordingDisclosure:['bool'],disclosureText:['text',LIMITS.disclosure]},
 closing:{message:['text',LIMITS.closing]},
 language:{primary:['enum',LANGUAGES.map(x=>x[0])],allowSwitching:['bool']},
 conversation:{responseStyle:['enum',RESPONSE_STYLES.map(x=>x[0])],allowInterruptions:['bool'],pronunciations:['pronunciations']},
 silence:{enabled:['bool'],seconds:['int',5,120],message:['text',LIMITS.checkIn],hangUpAfter:['int',0,5]},
 limits:{maxCallMinutes:['int',0,120],wrapUpMessage:['text',LIMITS.wrapUp]},
 escalation:{message:['text',LIMITS.escalation],offerCallback:['bool']},
 capabilities:{lookups:['bool'],bookings:['bool'],inCallSms:['bool']},
 backend:{reasoningEffort:['enum',REASONING_EFFORTS.map(x=>x[0])],serviceTier:['enum',SERVICE_TIERS.map(x=>x[0])]},
 recording:{audio:['bool']},
};
const isObject=v=>v!==null&&typeof v==='object'&&!Array.isArray(v);
/** Full settings with defaults filled in; never mutates the input. */
export function normalizeSettings(settings={}){
 const out=structuredClone(DEFAULT_SETTINGS);
 for(const [group,fields] of Object.entries(SPEC))for(const key of Object.keys(fields))if(isObject(settings?.[group])&&settings[group][key]!==undefined)out[group][key]=structuredClone(settings[group][key]);
 return out;
}
/** Throws a field-addressed error when settings do not match the stored contract. */
export function validateSettings(settings){
 if(settings===undefined)return;
 if(!isObject(settings))throw new Error('settings: must be an object.');
 for(const [group,value] of Object.entries(settings)){
  const fields=SPEC[group];if(!fields)throw new Error(`settings.${group}: unsupported setting.`);
  if(!isObject(value))throw new Error(`settings.${group}: must be an object.`);
  for(const [key,v] of Object.entries(value)){
   const rule=fields[key],path=`settings.${group}.${key}`;if(!rule)throw new Error(`${path}: unsupported setting.`);
   const [kind,a,b]=rule;
   if(kind==='text'&&(typeof v!=='string'||v.length>a))throw new Error(`${path}: enter ${a} characters or fewer.`);
   if(kind==='bool'&&typeof v!=='boolean')throw new Error(`${path}: choose on or off.`);
   if(kind==='enum'&&!a.includes(v))throw new Error(`${path}: choose a supported option.`);
   if(kind==='int'&&(!Number.isInteger(v)||v<a||v>b))throw new Error(`${path}: enter a whole number from ${a} to ${b}.`);
   if(kind==='pronunciations'){
    if(!Array.isArray(v)||v.length>LIMITS.pronunciations)throw new Error(`${path}: add up to ${LIMITS.pronunciations} pronunciations.`);
    v.forEach((p,i)=>{if(!isObject(p)||Object.keys(p).some(k=>!['term','sayAs'].includes(k))||typeof p.term!=='string'||!p.term.trim()||p.term.length>LIMITS.term||typeof p.sayAs!=='string'||!p.sayAs.trim()||p.sayAs.length>LIMITS.sayAs)throw new Error(`${path}[${i+1}]: enter a word (up to ${LIMITS.term} characters) and how to say it (up to ${LIMITS.sayAs}).`);});
   }
  }
 }
}
/** Parses one pronunciation per line: "Term = how to say it". */
export function parsePronunciations(text){
 return String(text||'').split(/\r?\n/).map(l=>l.trim()).filter(Boolean).map((line,i)=>{const at=line.indexOf('=');if(at<1)throw new Error(`Pronunciation line ${i+1}: use "Word = how to say it".`);return {term:line.slice(0,at).trim(),sayAs:line.slice(at+1).trim()};});
}
export const formatPronunciations=list=>(list||[]).map(p=>`${p.term} = ${p.sayAs}`).join('\n');
