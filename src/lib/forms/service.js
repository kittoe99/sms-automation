import {normalizeDefinition,normalizeAnswers,routeSubmission,mapAnswers,defaultDefinition,MAPPING_KEYS} from '../../../public/form-schema.js';
import {groupRule} from '../../../supabase/functions/_shared/domain.js';
import {AUTOMATION_RULE_PRESETS} from '../automations/rulePresets.js';

export const bad = (message,status=400) => Object.assign(new Error(message),{status});
export class FormService {
  constructor(db,user,tenant) {this.db=db;this.user=user;this.tenant=tenant;}
  call(op,p={}) {return this.db.call('forms_admin',this.user,this.tenant,op,p);}
  get(id) {return this.call('get',{id});}
  async catalog() {return {...await this.call('catalog'),presets:AUTOMATION_RULE_PRESETS,mappings:MAPPING_KEYS};}
  async create() {return this.call('create',{definition:defaultDefinition()});}
  async save(id,revision,input,draftGroups) {
    const definition=normalizeDefinition(input);
    const {business}=await this.catalog();
    if(draftGroups!==undefined) {
      if(!Array.isArray(draftGroups)||draftGroups.length>10) throw bad('Use up to 10 draft automations');
      const ids=new Set();
      draftGroups=draftGroups.map(g=>{
        if(!g || !/^form-[a-f0-9-]{36}-[a-z0-9-]{1,32}$/.test(g.id)||!g.id.startsWith(`form-${id}-`)||ids.has(g.id)) throw bad('Invalid or duplicate form-owned automation ID');
        ids.add(g.id);
        if(typeof g.name!=='string'||!g.name.trim()||g.name.length>120) throw bad('Automation name required');
        return {id:g.id,name:g.name.trim(),description:String(g.description||'').slice(0,1000),rule:groupRule(g.rule,business.timeZone)};
      });
    }
    return this.call('save',{id,revision,definition,...(draftGroups===undefined?{}:{draftGroups})});
  }
  async validate(id) {
    const form=await this.get(id),{groups}=await this.catalog();
    const errors=[];
    try {
      const d=normalizeDefinition(form.draft);
      const targets=new Set([d.routing.defaultGroupId,...d.routing.rules.map(r=>r.groupId)]);
      for(const id of targets) {
        const draft=form.draft_groups.find(g=>g.id===id);
        if(draft) {groupRule(draft.rule);continue;}
        const group=groups.find(g=>g.id===id);
        if(!group||!group.active||group.kind==='reminder') errors.push(`Choose an active lead/quote automation for ${id||'the default route'}.`);
        else if(d.routing.reviewedVersions[id]!==Number(group.version)) errors.push(`Review the latest version of ${group.name}.`);
      }
      for(const g of form.draft_groups) if(!targets.has(g.id)) errors.push(`Draft automation ${g.name} is not connected to a route.`);
    } catch(e) {errors.push(e.message);}
    return {valid:!errors.length,errors,revision:form.revision};
  }
  async publish(id,revision) {
    const validation=await this.validate(id);
    if(!validation.valid) throw bad(validation.errors.join(' '));
    return this.call('publish',{id,revision});
  }
  async simulate(id,input) {
    const form=await this.get(id),validation=await this.validate(id);
    const answers=normalizeAnswers(form.draft,input),mapped=mapAnswers(form.draft,answers),groupId=routeSubmission(form.draft,answers);
    const {groups}=await this.catalog();const g=[...groups,...form.draft_groups].find(g=>g.id===groupId);
    return {simulation:true,answers,mapped,groupId,groupName:g?.name,instantSms:form.draft.instantSms?.enabled?form.draft.instantSms:null,steps:g?.rule?.steps||[],eligible:mapped.consent===true&&validation.valid,
      note:mapped.consent===true?'Routing simulation only. Live intake also checks contact suppression and active enrollments.':'Saved as a lead; SMS enrollment blocked without consent.',validation};
  }
  async liveTest(id,revision,input,idempotencyKey) {
    const form=await this.get(id),validation=await this.validate(id);
    if(!validation.valid) throw bad(validation.errors.join(' '));
    if(Number(revision)!==Number(form.revision)) throw bad('Draft changed. Reload before testing.',409);
    const answers=normalizeAnswers(form.draft,input),mapped=mapAnswers(form.draft,answers),groupId=routeSubmission(form.draft,answers);
    if(mapped.consent!==true) throw bad('Check the SMS consent box before sending a live test.');
    if(!mapped.phone) throw bad('Enter a valid test phone number.');
    if(!/^[a-zA-Z0-9_-]{8,100}$/.test(idempotencyKey||'')) throw bad('Valid test key required');
    const {groups,business}=await this.catalog();
    const group=[...groups,...form.draft_groups].find(item=>item.id===groupId);
    if(!group) throw bad('The selected automation is unavailable.');
    const template=form.draft.instantSms?.enabled?form.draft.instantSms.body:group.rule?.steps?.[0]?.template;
    if(!template) throw bad('Configure an instant SMS or at least one automation message before live testing.');
    const values={...mapped,first_name:String(mapped.name||'').trim().split(/\s+/)[0]||'',business_name:business.name};
    const body=template.replace(/\{\{\s*([a-z_]+)\s*\}\}/gi,(_match,key)=>String(values[key]??''));
    const queued=await this.db.call('forms_live_test',this.user,this.tenant,id,{revision:form.revision,idempotencyKey,groupId,body,mapped,consent:true});
    return {liveTest:true,queued:true,groupId,groupName:group.name,instantSms:Boolean(form.draft.instantSms?.enabled),body,...queued};
  }
}
