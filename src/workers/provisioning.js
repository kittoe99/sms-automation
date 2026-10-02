import twilio from 'twilio';
const runtimeEnv=new Proxy({}, {get:(_,key)=>globalThis.Deno?.env.get(String(key)) ?? globalThis.process?.env?.[key]});
function webhookUrls(env) {
  const explicit=String(env.TWILIO_WEBHOOK_BASE_URL || '').trim().replace(/\/$/,'');
  const supabase=String(env.SUPABASE_URL || '').trim().replace(/\/$/,'');
  const base=explicit || (supabase ? `${supabase}/functions/v1/twilio-webhook` : '');
  if(!/^https:\/\//i.test(base)) throw Object.assign(new Error('A public HTTPS Twilio webhook base URL is required'),{permanent:true,code:'WEBHOOK_BASE_REQUIRED'});
  return {inbound:`${base}/inbound`,status:`${base}/status`};
}

function masterCredentials(env) {
  const sid=String(env.TWILIO_MASTER_ACCOUNT_SID || '').trim();
  const token=String(env.TWILIO_MASTER_AUTH_TOKEN || '').trim();
  if(!/^AC[a-f0-9]{32}$/i.test(sid) || !token) {
    throw Object.assign(new Error('Master Twilio credentials required'),{permanent:true,code:'TWILIO_MASTER_CREDENTIALS_REQUIRED'});
  }
  return {sid,token};
}

/**
 * Creates one child Twilio account and Messaging Service per CRM business.
 * Provider creation is deliberately checkpointed before and after each remote
 * mutation. A timeout is never replayed blindly: the next invocation marks the
 * job for reconciliation instead of creating a second paid/provider resource.
 */
export async function processProvisioning(job,db,{clientFactory=twilio,env=runtimeEnv}={}) {
  const state=await db.call('provision_credentials',job.id,job.lease_token);
  if(!state) throw Object.assign(new Error('Provider record unavailable'),{permanent:true,code:'PROVIDER_RECORD_MISSING'});
  if(state?.state==='creating_account' || state?.state==='creating_service') {
    return db.call('finish',job.id,job.lease_token,'submission_unknown','PROVISIONING_RECONCILIATION_REQUIRED',0);
  }
  if(['awaiting_number','ready','configured'].includes(state.state)) {
    return db.call('finish',job.id,job.lease_token,'completed',null,0);
  }
  const {sid,token}=masterCredentials(env);
  const urls=webhookUrls(env);
  const master=clientFactory(sid,token,{timeout:20000,autoRetry:false});
  let accountSid=state?.account_sid;
  let childToken=state?.auth_token;
  if(!accountSid) {
    await db.call('provision_checkpoint',job.id,job.lease_token,{state:'creating_account'});
    const account=await master.api.v2010.accounts.create({friendlyName:`${job.payload.name || job.tenant_id} [${job.tenant_id}]`});
    if(!/^AC[a-f0-9]{32}$/i.test(account?.sid || '') || !account?.authToken || account.sid===sid || account.ownerAccountSid!==sid) {
      throw Object.assign(new Error('Twilio returned an invalid subaccount'),{code:'INVALID_SUBACCOUNT_RESPONSE'});
    }
    accountSid=account.sid;
    childToken=account.authToken;
    await db.call('provision_checkpoint',job.id,job.lease_token,{state:'account_created',account_sid:account.sid,
      parent_account_sid:sid,account_friendly_name:account.friendlyName || `${job.payload.name || job.tenant_id} [${job.tenant_id}]`,auth_token:account.authToken});
  }
  if(!state?.messaging_service_sid) {
    if(!childToken) throw Object.assign(new Error('Child Twilio credentials are unavailable'),{permanent:true,code:'TWILIO_CHILD_CREDENTIALS_REQUIRED'});
    const child=clientFactory(accountSid,childToken,{timeout:20000,autoRetry:false});
    // On recovery, verify the stored credential and parent relationship before mutation.
    if(state.account_sid) {
      const account=await child.api.v2010.accounts(accountSid).fetch();
      if(account.sid!==accountSid || account.ownerAccountSid!==sid || accountSid===sid || account.status!=='active') {
        throw Object.assign(new Error('Stored subaccount ownership is invalid'),{permanent:true,code:'INVALID_SUBACCOUNT_OWNERSHIP'});
      }
    }
    await db.call('provision_checkpoint',job.id,job.lease_token,{state:'creating_service'});
    const service=await child.messaging.v1.services.create({friendlyName:`${job.payload.name || job.tenant_id} — SMS`,
      inboundRequestUrl:urls.inbound,inboundMethod:'POST',statusCallback:urls.status,useInboundWebhookOnNumber:false});
    if(!/^MG[a-f0-9]{32}$/i.test(service?.sid || '') || service.accountSid!==accountSid) throw Object.assign(new Error('Twilio returned an invalid Messaging Service'),{code:'INVALID_MESSAGING_SERVICE_RESPONSE'});
    await db.call('provision_checkpoint',job.id,job.lease_token,{state:'awaiting_number',messaging_service_sid:service.sid});
  }
  await db.call('finish',job.id,job.lease_token,'completed',null,0);
}
