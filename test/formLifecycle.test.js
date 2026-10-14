import test from 'node:test';
import assert from 'node:assert/strict';
import {changeFormLifecycle,lifecycleConfirmation} from '../public/formLifecycle.js';
import {automationStatus,filterForms,formTotals} from '../public/formDirectory.js';
test('deactivation preserves fresh saved fields and legacy email settings',async()=>{
 const calls=[],form={public_id:'form',title:'Latest saved title',description:'Saved description',button_label:'Request quote',fields:[{key:'notes',label:'Notes',type:'text'}],enabled:true,email_enabled:true};
 await changeFormLifecycle(async(path,options)=>{calls.push({path,options});return path==='/api/web-forms'?{canEdit:true,forms:[form]}:{form};},'form','deactivate');
 assert.equal(calls[0].path,'/api/web-forms');assert.equal(calls[1].path,'/api/web-forms/form');assert.equal(calls[1].options.method,'PUT');
 assert.deepEqual(JSON.parse(calls[1].options.body),{title:form.title,description:form.description,buttonLabel:form.button_label,fields:form.fields,enabled:false,emailEnabled:true});
});
test('deactivation never writes after lost permission, archival, read failure or a workspace change',async()=>{
 for(const data of [{canEdit:false,forms:[]},{canEdit:true,forms:[]},{canEdit:true,forms:[{public_id:'form',archived:true}]}]){
  let calls=0;await assert.rejects(changeFormLifecycle(async()=>{calls++;return data;},'form','deactivate'));assert.equal(calls,1);
 }
 let current=true,calls=0;
 await assert.rejects(changeFormLifecycle(async()=>{calls++;current=false;return {canEdit:true,forms:[]};},'form','deactivate',{isCurrent:()=>current}),/workspace changed/);assert.equal(calls,1);
 await assert.rejects(changeFormLifecycle(async()=>{throw Error('Offline');},'form','deactivate'),/Offline/);
});
test('deletion uses recoverable archive and restoration never activates a form',async()=>{
 const calls=[];for(const action of ['archive','restore'])await changeFormLifecycle(async(...args)=>{calls.push(args);return {};},'form',action);
 assert.deepEqual(calls,[['/api/web-forms/form/archive',{method:'POST',body:'{}'}],['/api/web-forms/form/restore',{method:'POST',body:'{}'}]]);
 assert.match(lifecycleConfirmation('archive'),/history will be kept/);assert.match(lifecycleConfirmation('deactivate'),/pause active SMS/);
});
test('deleted forms leave current view, and disabled forms cannot count as active automation',()=>{
 const forms=[{public_id:'live',enabled:true,automationEnabled:true,submissionCount:1},{public_id:'inactive',enabled:false,automationEnabled:true,publishedVersion:1,submissionCount:2},{public_id:'deleted',archived:true,submissionCount:3}];
 assert.deepEqual(filterForms(forms,'','active').map(f=>f.public_id),['live','inactive']);
 assert.deepEqual(filterForms(forms,'','archived').map(f=>f.public_id),['deleted']);
 assert.equal(formTotals(forms).automations,1);assert.equal(formTotals(forms).submissions,6);assert.match(automationStatus(forms[1]),/form inactive/);
});
