import { EMAIL_STARTERS, renderTemplateEmail, validateEmailDefinition } from '../../../src/lib/emailTemplates.js';
import { provisionEmailDomain } from '../../../src/lib/emailDomains.js';

export async function emailAutomationAction(db,user,tenant,action,input) {
  if(action==='sender') return provisionEmailDomain(db,user,tenant,input);
  if(['create','save'].includes(action)) {
    try {validateEmailDefinition(input.definition);} catch(error) {throw Object.assign(error,{status:400});}
  }
  const result = await db.call('email_automations',user,tenant,action,input);
  if(action==='read') return {...result,starters:EMAIL_STARTERS};
  if(action==='preview') {
    const values={name:'Alex Example',firstName:'Alex',email:'alex@example.test',businessName:'Your business',appointment:'Example appointment',request:'your enquiry',service:'your service'};
    return {...result,messages:result.definition.steps.map(step=>renderTemplateEmail(step,values,{businessName:values.businessName,mailingAddress:'Business mailing address',unsubscribeUrl:'https://crm.e2local.com/email-unsubscribe.html',purpose:result.definition.purpose}))};
  }
  return result;
}
