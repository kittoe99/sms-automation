// US/Canada is the default for local entry. International input must be explicit.
export function normalizePhoneInput(value) {
 const raw=String(value??'').trim();
 if(!raw||!/^[+\d\s().-]+$/.test(raw))return raw;
 let compact=raw.replace(/[\s().-]/g,'');
 if(compact.startsWith('00'))compact='+'+compact.slice(2);
 if(/^\d{10}$/.test(compact))return '+1'+compact;
 if(/^1\d{10}$/.test(compact))return '+'+compact;
 return /^\+[1-9]\d{7,14}$/.test(compact)?compact:raw;
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
