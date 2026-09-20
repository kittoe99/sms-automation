/** Shared, executable-free form contract used by the editor, renderer and server. */
export const FIELD_TYPES = ['text','email','phone','textarea','number','date','select','radio','checkbox','consent'];
export const MAPPING_KEYS = ['phone','name','email','consent','service_name','service_address','preferred_date','details'];
export const SMS_TEMPLATE_KEYS = ['name','email','service_name','service_address','preferred_date','details'];
const idPattern = /^[a-z][a-z0-9_]{0,47}$/;
const safeId = id => typeof id === 'string' && idPattern.test(id) && !['constructor','prototype','__proto__'].includes(id);
const plain = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const fail = message => { throw Object.assign(new Error(message), {status:400}); };
const text = (v, max, label, required=false) => {
  if(typeof v !== 'string' || v.length>max || (required && !v.trim())) fail(`Invalid ${label}`);
  return v.trim();
};
export function conditionMatches(condition, answers) {
  if(!condition) return true;
  if(!Object.hasOwn(answers,condition.field)) return false;
  const value=answers[condition.field];
  if(condition.operator==='eq') return value===condition.value;
  if(condition.operator==='neq') return value!==condition.value;
  if(condition.operator==='in') return condition.value.includes(value);
  return typeof value==='string' && value.toLowerCase().includes(String(condition.value).toLowerCase());
}
function condition(input, fields) {
  if(!plain(input) || !fields.some(f=>f.id===input.field) || !['eq','neq','in','contains'].includes(input.operator)) fail('Invalid condition or field reference');
  const values=input.operator==='in'?input.value:[input.value];
  if(!Array.isArray(values)||!values.length||values.length>50||values.some(v=>!['string','number','boolean'].includes(typeof v)||String(v).length>200)) fail('Invalid condition value');
  return {field:input.field,operator:input.operator,value:input.value};
}
export function normalizeDefinition(input) {
  if(!plain(input) || input.schemaVersion!==1 || !Array.isArray(input.fields) || input.fields.length<1 || input.fields.length>40) fail('A version 1 form needs 1–40 fields');
  const fields=[];
  for(const f of input.fields) {
    if(!plain(f)||!safeId(f.id)||fields.some(x=>x.id===f.id)||!FIELD_TYPES.includes(f.type)) fail('Invalid or duplicate field');
    const item={id:f.id,type:f.type,label:text(f.label,160,'field label',true),required:f.required===true};
    if(f.placeholder) item.placeholder=text(f.placeholder,200,'placeholder');
    if(f.help) item.help=text(f.help,1000,'help text');
    if(['select','radio'].includes(f.type)) {
      if(!Array.isArray(f.options)||f.options.length<1||f.options.length>50) fail('Select and radio fields need 1–50 options');
      item.options=f.options.map(v=>text(v,200,'option',true));
      if(new Set(item.options).size!==item.options.length) fail('Options must be unique');
    }
    if(f.visibleWhen) item.visibleWhen=condition(f.visibleWhen,fields); // Earlier fields only: no dependency cycles.
    if(f.type==='consent') {
      item.disclosure=text(f.disclosure,2000,'consent disclosure',true);
      if(f.required || f.visibleWhen) fail('SMS consent must be optional and always visible');
    }
    fields.push(item);
  }
  const mappings={};
  for(const [key,value] of Object.entries(input.mappings||{})) {
    if(!MAPPING_KEYS.includes(key)||!fields.some(f=>f.id===value)) fail('Invalid field mapping');
    mappings[key]=value;
  }
  const phone=fields.find(f=>f.id===mappings.phone);
  if(!phone||phone.type!=='phone'||!phone.required||phone.visibleWhen) fail('Map an always-visible required phone field');
  if(fields.find(f=>f.id===mappings.consent)?.type!=='consent') fail('Map an SMS consent field');
  if(mappings.email && fields.find(f=>f.id===mappings.email)?.type!=='email') fail('Email mapping must use an email field');
  const routing=input.routing||{};
  if(typeof routing.defaultGroupId!=='string'||routing.defaultGroupId.length>100) fail('Select a default automation group');
  if(!Array.isArray(routing.rules)||routing.rules.length>20) fail('Use up to 20 routing rules');
  const rules=routing.rules.map(r=>{
    if(!plain(r)||typeof r.groupId!=='string'||!r.groupId||r.groupId.length>100) fail('Invalid routing group');
    return {when:condition(r.when,fields),groupId:r.groupId};
  });
  const reviewedVersions={};
  for(const [key,value] of Object.entries(routing.reviewedVersions||{})) {
    if(!/^[a-zA-Z0-9_-]{1,100}$/.test(key)||!Number.isSafeInteger(value)||value<1) fail('Invalid reviewed automation version');
    reviewedVersions[key]=value;
  }
  const instantInput=input.instantSms||{};
  const instantSms={enabled:instantInput.enabled===true,body:''};
  if(instantSms.enabled) {
    instantSms.body=text(instantInput.body,1000,'instant SMS message',true);
    const placeholders=[...instantSms.body.matchAll(/{{\s*([a-z_]+)\s*}}/g)].map(match=>match[1]);
    if(placeholders.some(key=>!SMS_TEMPLATE_KEYS.includes(key)||!mappings[key])) fail('Instant SMS uses an unmapped placeholder');
    if(instantSms.body.replace(/{{\s*[a-z_]+\s*}}/g,'').includes('{{')) fail('Invalid instant SMS placeholder');
    instantSms.body=instantSms.body.replace(/{{\s*([a-z_]+)\s*}}/g,'{{$1}}');
  }
  const color=input.theme?.color||'#087f5b';
  if(!/^#[0-9a-f]{6}$/i.test(color)) fail('Use a six-digit theme color');
  const origins=(input.allowedOrigins||[]).map(origin=>{
    let url;try{url=new URL(origin);}catch{fail('Invalid website origin');}
    if(url.protocol!=='https:' && !(url.protocol==='http:'&&['localhost','127.0.0.1'].includes(url.hostname))) fail('Website origins must use HTTPS');
    if(url.origin!==origin) fail('Use website origins without paths or trailing slashes');
    return origin;
  });
  if(origins.length>20) fail('Use up to 20 website origins');
  return {schemaVersion:1,title:text(input.title,120,'form title',true),description:text(input.description||'',1000,'description'),
    submitLabel:text(input.submitLabel||'Send request',80,'button label',true),successMessage:text(input.successMessage||'Thank you. Your request has been received.',500,'success message',true),
    fields,mappings,routing:{defaultGroupId:routing.defaultGroupId,rules,reviewedVersions},instantSms,theme:{color},layout:'stacked',allowedOrigins:[...new Set(origins)]};
}
export function defaultDefinition() {
  return {schemaVersion:1,title:'Request a quote',description:'Tell us how we can help.',submitLabel:'Request quote',successMessage:'Thank you. Your request has been received.',
    fields:[{id:'name',type:'text',label:'Your name',required:true},{id:'phone',type:'phone',label:'Phone number',required:true},{id:'email',type:'email',label:'Email',required:false},
      {id:'service',type:'text',label:'What service do you need?',required:true},{id:'details',type:'textarea',label:'Tell us about your request',required:false},
      {id:'sms_consent',type:'consent',label:'SMS updates',required:false,disclosure:'I agree to receive follow-up text messages about my request. Message and data rates may apply. Reply STOP to opt out. Consent is not a condition of purchase.'}],
    mappings:{name:'name',phone:'phone',email:'email',service_name:'service',details:'details',consent:'sms_consent'},routing:{defaultGroupId:'',rules:[],reviewedVersions:{}},instantSms:{enabled:false,body:''},theme:{color:'#087f5b'},layout:'stacked',allowedOrigins:[]};
}
export function normalizeAnswers(definition, input) {
  if(!plain(input)) fail('Answers must be an object');
  if(Object.keys(input).some(k=>!definition.fields.some(f=>f.id===k))) fail('Unknown answer field');
  const answers={};
  for(const f of definition.fields) {
    if(!conditionMatches(f.visibleWhen,answers)) continue;
    let value=input[f.id];
    if(['checkbox','consent'].includes(f.type)) {
      if(value!==undefined&&typeof value!=='boolean') fail(`${f.label} must be true or false`);
      value=value===true;
    } else {
      if(value===undefined || value==='') {if(f.required) fail(`${f.label} is required`);continue;}
      if(!['string','number'].includes(typeof value)) fail(`Invalid ${f.label}`);
      value=String(value).trim();
      if(!value && f.required) fail(`${f.label} is required`);
      if(value.length>(f.type==='textarea'?4000:500)) fail(`${f.label} is too long`);
      if(f.type==='number') {value=Number(value);if(!Number.isFinite(value)) fail(`Invalid ${f.label}`);}
      if(f.type==='email' && value && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) fail(`Invalid ${f.label}`);
      if(f.type==='phone') {
        let digits=value.replace(/\D/g,'');if(!value.startsWith('+')&&digits.length===10) digits='1'+digits;
        value='+'+digits;if(!/^\+[1-9]\d{7,14}$/.test(value)) fail(`Invalid ${f.label}`);
      }
      if(f.type==='date' && (!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value)) fail(`Invalid ${f.label}`);
      if(f.options && !f.options.includes(value)) fail(`Invalid ${f.label} option`);
    }
    if(f.required && value===false) fail(`${f.label} is required`);
    answers[f.id]=value;
  }
  return answers;
}
export function routeSubmission(definition, answers) {
  return definition.routing.rules.find(r=>conditionMatches(r.when,answers))?.groupId || definition.routing.defaultGroupId;
}
export function mapAnswers(definition,answers) {
  return Object.fromEntries(Object.entries(definition.mappings).filter(([,field])=>Object.hasOwn(answers,field)).map(([key,field])=>[key,answers[field]]));
}
export function publicDefinition(definition) {
  const {title,description,submitLabel,successMessage,fields,theme,layout,schemaVersion}=definition;
  return {title,description,submitLabel,successMessage,fields,theme,layout,schemaVersion};
}
