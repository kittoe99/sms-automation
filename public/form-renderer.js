import {conditionMatches} from './form-schema.js';
const node=(tag,props={},text)=>{const el=document.createElement(tag);Object.assign(el,props);if(text!==undefined)el.textContent=text;return el;};
/** Only trusted components render the schema. No form content is interpreted as HTML. */
export function renderForm(container,definition,{onSubmit=()=>{},preview=false}={}) {
  container.replaceChildren();
  const form=node('form',{className:'fb-rendered'});form.style.setProperty('--form-color',definition.theme?.color||'#087f5b');
  form.append(node('h2',{},definition.title),node('p',{className:'fb-description'},definition.description));
  const controls=new Map();
  for(const field of definition.fields) {
    const section=node('div',{className:'fb-field'}),label=node('label',{},field.label+(field.required?' *':''));
    const unique=`form-${crypto.randomUUID()}`;
    section.append(label);
    let input;
    if(field.type==='textarea') input=node('textarea',{rows:4,maxLength:4000});
    else if(field.type==='select') {input=node('select');input.append(node('option',{value:''},'Choose an option'));for(const option of field.options||[])input.append(node('option',{value:option},option));}
    else if(field.type==='radio') {
      input=node('fieldset');input.append(node('legend',{className:'fb-sr'},field.label));label.hidden=true;
      for(const option of field.options||[]) {
        const radio=node('input',{type:'radio',name:unique,value:option,required:field.required===true});
        const optionLabel=node('label',{className:'fb-choice'});optionLabel.append(radio,document.createTextNode(option));input.append(optionLabel);
      }
    } else input=node('input',{type:field.type==='phone'?'tel':['checkbox','consent'].includes(field.type)?'checkbox':field.type,maxLength:500});
    input.id=unique;input.name=field.id;input.required=field.required===true;
    if(field.placeholder)input.placeholder=field.placeholder;
    label.htmlFor=unique;
    if(field.type==='consent') {label.textContent=field.disclosure;label.className='fb-choice';label.prepend(input);}
    else if(field.type==='checkbox') {label.className='fb-choice';label.prepend(input);}
    else section.append(input);
    if(field.help){const help=node('small',{id:unique+'-help'},field.help);section.append(help);input.setAttribute('aria-describedby',help.id);}
    controls.set(field.id,{field,input,section});form.append(section);
  }
  const getAnswers=()=>{
    const answers={};
    for(const {field,input,section} of controls.values()) {
      if(section.hidden)continue;
      answers[field.id]=field.type==='radio'?(input.querySelector('input:checked')?.value||''):['checkbox','consent'].includes(field.type)?input.checked:input.value;
    }
    return answers;
  };
  const visibility=()=>{
    const answers={};
    for(const {field,input,section} of controls.values()) {
      const visible=conditionMatches(field.visibleWhen,answers);section.hidden=!visible;
      if(field.type==='radio')input.querySelectorAll('input').forEach(x=>x.disabled=!visible);else input.disabled=!visible;
      if(visible)answers[field.id]=field.type==='radio'?(input.querySelector('input:checked')?.value||''):['checkbox','consent'].includes(field.type)?input.checked:field.type==='number'&&input.value!==''?Number(input.value):input.value;
    }
  };
  const honeypot=node('input',{name:'website',tabIndex:-1,autocomplete:'off',className:'fb-honey'});honeypot.setAttribute('aria-hidden','true');
  const challenge=node('div',{className:'fb-challenge'}),status=node('p',{className:'fb-status'});status.setAttribute('role','status');status.setAttribute('aria-live','polite');
  const button=node('button',{type:'submit',className:'fb-submit'},preview?'Test submission':definition.submitLabel);
  form.append(honeypot,challenge,button,status);container.append(form);form.addEventListener('input',visibility);visibility();
  form.addEventListener('submit',async event=>{
    event.preventDefault();status.textContent='';button.disabled=true;
    try {const result=await onSubmit(getAnswers(),honeypot.value);status.textContent=result||definition.successMessage;}
    catch(error){status.textContent=error.message;}
    finally{button.disabled=false;}
  });
  return {form,getAnswers,challenge,status};
}
