import {formPreviewOutputs} from './formSchemas.js';

const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// A self-contained display resource, never a public/hosted form. No fetch,
// scripts, form element, submit action, live links, values or enabled controls.
export function formPreviewResource(input) {
 const data=formPreviewOutputs.crm_preview_form.parse(input),{form}=data,definition=form.definition;
 const field=f=>{
  const id=`preview-${f.key}`,attrs=`id="${esc(id)}" disabled${f.required?' required':''}`;
  const control=f.type==='textarea'?`<textarea ${attrs}></textarea>`:
   f.type==='select'?`<select ${attrs}><option value="">Choose an option</option>${f.options.map(o=>`<option>${esc(o)}</option>`).join('')}</select>`:
   `<input ${attrs} type="${esc(f.type)}">`;
  return `<label for="${esc(id)}">${esc(f.label)}${f.required?' *':''}</label>${control}`;
 };
 const consent=(choice,key)=>choice?`<p><label><input type="checkbox" id="preview-${key}" disabled> ${esc(choice.text)}</label></p>`:'';
 const warnings=data.warnings.map(code=>`<p role="note">${code==='DRAFT_BASE_CHANGED'?'The applied form changed after this draft was saved. Reconciliation is required before applying it.':'This form is archived.'}</p>`).join('');
 const html=`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'none'; connect-src 'none'; form-action 'none'; base-uri 'none'; style-src 'unsafe-inline'"><title>Saved form draft preview</title><style>body{font:16px system-ui,sans-serif;max-width:640px;margin:32px auto;padding:0 20px;color:#172033;background:#fff}header{padding:16px;background:#eef3fa;border-radius:8px}label{display:block;margin-top:16px}input:not([type=checkbox]),textarea,select{box-sizing:border-box;width:100%;padding:10px;border:1px solid #aab4c4;border-radius:5px;background:#f7f8fa;color:#172033}input[type=checkbox]{margin-right:8px}button{margin-top:20px;padding:10px 20px}p{white-space:pre-wrap}small{color:#526078}</style></head><body><header><strong>Saved draft preview</strong><p>Display only. No data is collected or submitted.</p><small>Draft revision ${form.draftRevision} · Based on form revision ${form.draftBaseRevision} · Current form revision ${form.revision}</small>${warnings}</header><main><h1>${esc(definition.title)}</h1><p>${esc(definition.description)}</p>${data.fixedFields.map(field).join('')}${definition.fields.map(field).join('')}${consent(data.consent.sms,'sms_opt_in')}${consent(data.consent.email,'email_opt_in')}<button type="button" disabled>${esc(definition.buttonLabel)}</button><p><small>* Required on the eventual form. Consent choices are optional and unchecked. This preview does not activate collection or assess SMS eligibility.</small></p></main></body></html>`;
 return {type:'resource',resource:{uri:`crm-form-preview://draft/${form.id}/${form.revision}/${form.draftRevision}`,mimeType:'text/html',text:html}};
}
