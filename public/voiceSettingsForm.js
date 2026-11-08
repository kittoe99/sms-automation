import {LANGUAGES,RESPONSE_STYLES,REASONING_EFFORTS,SERVICE_TIERS,LIMITS,normalizeSettings,parsePronunciations,formatPronunciations} from './voiceSettings.js';
const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const n=(group,key)=>`s.${group}.${key}`;
const text=(s,group,key,label,max,{hint='',placeholder=''}={})=>`<label>${label}${hint?` <small>${hint}</small>`:''}<input name="${n(group,key)}" maxlength="${max}" value="${esc(s[group][key])}" placeholder="${esc(placeholder)}"></label>`;
const area=(s,group,key,label,max,{hint='',placeholder='',rows=2}={})=>`<label class="wide">${label}${hint?` <small>${hint}</small>`:''}<textarea name="${n(group,key)}" maxlength="${max}" rows="${rows}" placeholder="${esc(placeholder)}">${esc(s[group][key])}</textarea></label>`;
const check=(s,group,key,label,hint='')=>`<label class="voice-check wide"><input type="checkbox" name="${n(group,key)}" ${s[group][key]?'checked':''}> <span>${label}${hint?`<small>${hint}</small>`:''}</span></label>`;
const select=(s,group,key,label,options)=>`<label>${label}<select name="${n(group,key)}">${options.map(([v,l])=>`<option value="${esc(v)}" ${String(s[group][key])===v?'selected':''}>${esc(l)}</option>`).join('')}</select></label>`;
const number=(s,group,key,label,min,max,hint='')=>`<label>${label}${hint?` <small>${hint}</small>`:''}<input type="number" name="${n(group,key)}" min="${min}" max="${max}" step="1" value="${esc(s[group][key])}"></label>`;
const section=(title,summary,body,open=false)=>`<details class="voice-settings-group wide" ${open?'open':''}><summary><strong>${title}</strong><small>${summary}</small></summary><div class="voice-config">${body}</div></details>`;

/** Markup for every detailed Voice Agent setting. Inputs are named s.<group>.<key>. */
export function settingsMarkup(raw){
 const s=normalizeSettings(raw);
 return `<div class="voice-settings wide"><h3>Call settings</h3><p class="muted">Settings apply to new calls after you publish. Capabilities can only be narrowed here: phone booking and in-call texts still need their deployment features enabled.</p>
 ${section('Greeting &amp; recording disclosure','How the agent opens each call',`
  ${text(s,'greeting','spokenName','Name the agent introduces itself as',LIMITS.spokenName,{hint:'Optional',placeholder:'e.g. Lisa'})}
  ${area(s,'greeting','message','Opening line',LIMITS.greeting,{hint:'Leave blank for the standard greeting',placeholder:'Thanks for calling! This is Lisa, how can I help today?'})}
  ${check(s,'greeting','recordingDisclosure','Read a recording disclosure first','Recommended where callers must be told a call is recorded.')}
  ${area(s,'greeting','disclosureText','Disclosure wording',LIMITS.disclosure)}`,true)}
 ${section('Language &amp; conversation style','Language, reply length, interruptions and pronunciation',`
  ${select(s,'language','primary','Primary language',LANGUAGES)}
  ${select(s,'conversation','responseStyle','Reply length',RESPONSE_STYLES)}
  ${check(s,'language','allowSwitching','Switch language when the caller does','Off keeps every call in the primary language.')}
  ${check(s,'conversation','allowInterruptions','Let callers interrupt the agent','Off makes the agent finish each sentence before listening.')}
  <label class="wide">Pronunciation guide <small>One per line: Word = how to say it (up to ${LIMITS.pronunciations})</small><textarea name="s.conversation.pronunciations" rows="3" placeholder="Opek = OH-peck">${esc(formatPronunciations(s.conversation.pronunciations))}</textarea></label>`)}
 ${section('Silence &amp; call length','Check-ins when the caller goes quiet and a maximum call time',`
  ${check(s,'silence','enabled','Check in when the caller goes silent')}
  ${number(s,'silence','seconds','Seconds of silence before checking in',5,120)}
  ${number(s,'silence','hangUpAfter','End the call after unanswered check-ins',0,5,'0 never ends the call')}
  ${area(s,'silence','message','Check-in wording',LIMITS.checkIn)}
  ${number(s,'limits','maxCallMinutes','Maximum call length (minutes)',0,120,'0 means no limit')}
  ${area(s,'limits','wrapUpMessage','Wrap-up wording when time runs out',LIMITS.wrapUp)}`)}
 ${section('Escalation &amp; closing','What to do when a caller needs a person, and how calls end',`
  ${area(s,'escalation','message','When a caller asks for a person or the agent cannot help',LIMITS.escalation,{hint:'Optional',placeholder:"Our team isn't available right now, but I can have someone call you back."})}
  ${check(s,'escalation','offerCallback','Offer a team callback and save it for staff','Saved as a callback request in Leads.')}
  ${area(s,'closing','message','Closing line',LIMITS.closing,{hint:'Optional',placeholder:'Thanks for calling, have a great day!'})}`)}
 ${section('Capabilities','Turn off tools this agent should not use',`
  ${check(s,'capabilities','lookups','Look up business information and customer bookings')}
  ${check(s,'capabilities','bookings','Book, change and cancel appointments','Needs business lookups.')}
  ${check(s,'capabilities','inCallSms','Send texts the caller asks for during the call')}`)}
 ${section('Reasoning &amp; recording','Backend speed, cost and call audio',`
  ${select(s,'backend','reasoningEffort','Backend reasoning effort',REASONING_EFFORTS)}
  ${select(s,'backend','serviceTier','Backend speed tier',SERVICE_TIERS)}
  ${check(s,'recording','audio','Record call audio','Transcripts and recaps are always kept. Audio is retained for 90 days.')}`)}
 </div>`;
}

/** Reads the settings inputs back into a full settings object. Throws on malformed pronunciations. */
export function readSettings(form){
 const s=normalizeSettings();
 for(const [group,fields] of Object.entries(s))for(const [key,fallback] of Object.entries(fields)){
  const el=form.elements.namedItem(n(group,key));if(!el)continue;
  if(key==='pronunciations')s[group][key]=parsePronunciations(el.value);
  else if(typeof fallback==='boolean')s[group][key]=el.checked;
  else if(typeof fallback==='number')s[group][key]=el.value===''?fallback:Number(el.value);
  else s[group][key]=el.value;
 }
 return s;
}

/** Reads the whole configuration form: base prompt fields plus settings. */
export function readConfiguration(form){
 const base={};
 for(const key of ['name','voiceName','persona','voice','brain']){const el=form.elements.namedItem(key);if(el)base[key]=el.value;}
 return {...base,settings:readSettings(form)};
}
