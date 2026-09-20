import {renderForm} from './form-renderer.js';
const root=document.getElementById('form-root');
async function solveProof(token,difficulty=12) {
  const encoder=new TextEncoder(),fullBytes=Math.floor(difficulty/8),remaining=difficulty%8;
  for(let counter=0;counter<=5000000;counter++) {
    const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(`${token}.${counter}`)));
    let valid=true;for(let i=0;i<fullBytes;i++)if(hash[i]!==0){valid=false;break;}
    if(valid&&(!remaining||(hash[fullBytes]>>(8-remaining))===0))return counter;
  }
  throw new Error('Could not prepare spam protection. Reload the page.');
}
async function main() {
  const id=location.pathname.split('/').pop(),response=await fetch(`/forms-public/${encodeURIComponent(id)}`);
  const data=await response.json();if(!response.ok)throw new Error(data.error||'Form unavailable');
  document.title=data.definition.title;
  const requestedParent=new URL(location.href).searchParams.get('parent');
  const parentOrigin=[location.origin,...data.allowedOrigins].includes(requestedParent)?requestedParent:null;
  if(window.parent!==window&&!parentOrigin)throw new Error('This website is not enabled for this form.');
  let key=crypto.randomUUID(),widget,proofPromise=data.botProtection==='proof_of_work'?solveProof(data.token,data.proofDifficulty):Promise.resolve(null);
  const view=renderForm(root,data.definition,{onSubmit:async(answers,website)=>{
    const challengeToken=widget===undefined?null:window.turnstile?.getResponse(widget),proofCounter=await proofPromise;
    try {
      const result=await fetch(`/forms-public/${encodeURIComponent(id)}/submissions`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({answers,website,versionId:data.versionId,token:data.token,idempotencyKey:key,parentOrigin,challengeToken,proofCounter})});
      const body=await result.json();if(!result.ok)throw new Error(body.error||'Could not submit. Try again.');
      key=crypto.randomUUID();view.form.querySelector('button[type=submit]').hidden=true;
      return data.definition.successMessage;
    } finally {if(widget!==undefined)window.turnstile?.reset(widget);}
  }});
  if(data.turnstileSiteKey){
    const script=document.createElement('script');script.src='https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';script.async=true;
    script.onload=()=>{widget=window.turnstile.render(view.challenge,{sitekey:data.turnstileSiteKey});};
    script.onerror=()=>{view.status.textContent='Bot check could not load. Please reload the page.';};document.head.append(script);
  }
  if(parentOrigin&&window.parent!==window){const resize=()=>window.parent.postMessage({type:'sms-form-height',form:id,height:Math.ceil(root.getBoundingClientRect().height)},parentOrigin);new ResizeObserver(resize).observe(root);resize();}
}
main().catch(error=>{root.replaceChildren();const p=document.createElement('p');p.setAttribute('role','alert');p.textContent=error.message;root.append(p);});
