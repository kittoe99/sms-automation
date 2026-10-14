// Reuse the existing form lifecycle contract; deleting is a recoverable archive.
export const lifecycleConfirmation = action => action==='archive'
  ? 'Delete this form? It will stop accepting submissions and stop its automation runs. Submission and message history will be kept. You can restore it as a draft from Deleted forms. Unsaved edits will be discarded.'
  : 'Deactivate this form? It will stop accepting submissions, pause active SMS runs and cancel pending email enrollments. History will be kept. Unsaved edits will be discarded. Messages already sent cannot be recalled.';

export async function changeFormLifecycle(request,id,action,{isCurrent=()=>true}={}) {
 if(!['deactivate','archive','restore','duplicate'].includes(action))throw new Error('Unknown form action.');
 const check=()=>{if(!isCurrent())throw new Error('The workspace changed. Open the form again.');};
 check();
 if(action!=='deactivate')return request(`/api/web-forms/${id}/${action}`,{method:'POST',body:'{}'});
 // Read current saved fields rather than resubmitting a stale editor snapshot.
 const data=await request('/api/web-forms');check();
 if(!data.canEdit)throw new Error('You do not have permission to edit this form.');
 const form=data.forms.find(f=>f.public_id===id);
 if(!form||form.archived)throw new Error('This form is no longer available. Refresh the form list.');
 return request(`/api/web-forms/${id}`,{method:'PUT',body:JSON.stringify({
   title:form.title,description:form.description,buttonLabel:form.button_label,
   fields:form.fields,enabled:false,emailEnabled:Boolean(form.email_enabled),
 })});
}
