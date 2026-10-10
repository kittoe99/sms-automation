import {canonicalPhone} from './phoneNormalization.js';
// Leave invalid input visible so the form can explain the error.
export function normalizePhoneInput(value) {
 try{return canonicalPhone(value);}catch{return String(value??'').trim();}
}
const installed=new WeakSet();
export function installPhoneFormatting(root=document) {
 if(installed.has(root))return;installed.add(root);
 const format=input=>{
  if(!input?.matches?.('input[type="tel"]')||input.disabled||input.readOnly)return;
  const formatted=normalizePhoneInput(input.value);
  if(input.value!==formatted){input.value=formatted;input.dispatchEvent(new Event('input',{bubbles:true}));}
 };
 root.addEventListener('focusout',event=>format(event.target));
 // Capture normalizes before form-specific serialization, including Enter submits.
 root.addEventListener('submit',event=>event.target.querySelectorAll('input[type="tel"]').forEach(format),true);
}
