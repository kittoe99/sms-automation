import twilio from 'twilio';
const fail=(message,code,permanent=false)=>Object.assign(new Error(message),{code,permanent});
const validSid=(prefix,value)=>new RegExp(`^${prefix}[a-f0-9]{32}$`,'i').test(value || '');

export async function processCompliance(job,db,{clientFactory=twilio,fetchImpl=fetch}={}) {
 const ctx=await db.call('compliance_job_context',job.id,job.lease_token);if(!ctx?.operation||!ctx.provider?.auth_token)throw fail('Compliance context unavailable','COMPLIANCE_CONTEXT_MISSING',true);
 const operation=ctx.operation;
 if(['completed','reconciled'].includes(operation.state))return db.call('finish',job.id,job.lease_token,'completed',null,0);
 if(['submitting','submission_unknown'].includes(operation.state))return db.call('finish',job.id,job.lease_token,'submission_unknown','COMPLIANCE_RECONCILIATION_REQUIRED',0);
 if(!validSid('AC',ctx.provider.account_sid))throw fail('Twilio child account is incomplete','TWILIO_CHILD_INVALID',true);
 const child=clientFactory(ctx.provider.account_sid,ctx.provider.auth_token,{timeout:20000,autoRetry:false});
 if(operation.operation==='activation_canary') {
  const [number,service,senders]=await Promise.all([child.incomingPhoneNumbers(ctx.provider.phone_number_sid).fetch(),child.messaging.v1.services(ctx.provider.messaging_service_sid).fetch(),child.messaging.v1.services(ctx.provider.messaging_service_sid).phoneNumbers.list({limit:100})]);
  if(number.accountSid!==ctx.provider.account_sid||!senders.some(x=>x.phoneNumberSid===ctx.provider.phone_number_sid)||!/^https:\/\//.test(service.inboundRequestUrl||'')||!/^https:\/\//.test(service.statusCallback||''))throw fail('Twilio sender or webhooks failed activation verification','ACTIVATION_VERIFICATION_FAILED',true);
  await db.call('queue_activation_canary',job.id,job.lease_token);return db.call('finish',job.id,job.lease_token,'completed',null,0);
 }
 if(operation.operation==='refresh_status') {
  if(operation.request?.reconcile&&ctx.uncertain_operation?.operation==='purchase_number'){
   const requested=ctx.uncertain_operation.request?.selection?.phoneNumber;
   if(!/^\+[1-9]\d{7,14}$/.test(requested||''))throw fail('Uncertain purchase has no valid phone selection','RECONCILIATION_INPUT_MISSING',true);
   const numbers=await child.incomingPhoneNumbers.list({phoneNumber:requested,limit:20}),owned=numbers.find(x=>x.phoneNumber===requested&&x.accountSid===ctx.provider.account_sid);
   if(!owned){await db.call('compliance_checkpoint',job.id,job.lease_token,'completed',{registrationState:'number_pending',reconciledOperationId:ctx.uncertain_operation.id,rejectionReason:null,rejectionCode:null});return db.call('finish',job.id,job.lease_token,'completed',null,0);}
   const senders=await child.messaging.v1.services(ctx.provider.messaging_service_sid).phoneNumbers.list({limit:100});
   if(!senders.some(x=>x.phoneNumberSid===owned.sid)){await db.call('compliance_checkpoint',job.id,job.lease_token,'completed',{registrationState:'submission_unknown',rejectionCode:'SENDER_ATTACHMENT_UNCONFIRMED',rejectionReason:'The number exists in the child account but is not attached to the Messaging Service. Staff action is required.'});return db.call('finish',job.id,job.lease_token,'completed',null,0);}
   await db.call('compliance_checkpoint',job.id,job.lease_token,'completed',{registrationState:ctx.registration.sender_type==='toll_free'?'verification_pending':'in_review',phoneNumberSid:owned.sid,phoneNumber:owned.phoneNumber,reconciledOperationId:ctx.uncertain_operation.id,rejectionReason:null,rejectionCode:null});return db.call('finish',job.id,job.lease_token,'completed',null,0);
  }
  if(ctx.registration.state==='canary_pending'&&ctx.registration.canary_message_sid){const message=await child.messages(ctx.registration.canary_message_sid).fetch();const registrationState=message.status==='delivered'?'ready': ['failed','undelivered'].includes(message.status)?'webhook_verified':'canary_pending';await db.call('compliance_checkpoint',job.id,job.lease_token,'completed',{registrationState,canaryMessageSid:message.sid,rejectionReason:message.errorMessage||null,rejectionCode:message.errorCode?String(message.errorCode):null});return db.call('finish',job.id,job.lease_token,'completed',null,0);}
  const auth=`Basic ${btoa(`${ctx.provider.account_sid}:${ctx.provider.auth_token}`)}`;let url;
  const checkingBrand=ctx.registration.sender_type==='local_a2p'&&!ctx.registration.brand_registration_sid&&ctx.registration.bundle_sid;
  if(checkingBrand)url=`https://messaging.twilio.com/v1/a2p/BrandRegistrations?A2PProfileBundleSid=${encodeURIComponent(ctx.registration.bundle_sid)}`;
  else if(ctx.registration.sender_type==='toll_free'&&ctx.registration.verification_sid)url=`https://messaging.twilio.com/v1/Tollfree/Verifications/${encodeURIComponent(ctx.registration.verification_sid)}`;
  else if(ctx.registration.sender_type==='toll_free'&&ctx.provider.phone_number_sid)url=`https://messaging.twilio.com/v1/Tollfree/Verifications?TollfreePhoneNumberSid=${encodeURIComponent(ctx.provider.phone_number_sid)}`;
  else if(ctx.provider.messaging_service_sid)url=`https://messaging.twilio.com/v1/Services/${encodeURIComponent(ctx.provider.messaging_service_sid)}/Compliance/Usa2p`;
  else return db.call('finish',job.id,job.lease_token,'cancelled','REGISTRATION_RESOURCE_PENDING',0);
  const response=await fetchImpl(url,{headers:{Authorization:auth},signal:AbortSignal.timeout(20000)});if(!response.ok)throw fail('Twilio status refresh failed',`TWILIO_${response.status}`,response.status<500);
  const rawValue=await response.json(),isTollFree=ctx.registration.sender_type==='toll_free',value=checkingBrand?(rawValue.brand_registrations||rawValue.data||[])[0]||rawValue:isTollFree?(rawValue.verifications||rawValue.tollfree_verifications||rawValue.data||[])[0]||rawValue:rawValue,raw=String(value.campaign_status||value.status||'').toUpperCase();let registrationState=['VERIFIED','APPROVED'].includes(raw)?'approved':['FAILED','REJECTED'].includes(raw)?'rejected':'in_review';
  if(checkingBrand&&registrationState==='approved')registrationState='campaign_pending';
  else if(ctx.registration.sender_type==='local_a2p'&&registrationState==='approved'&&!ctx.provider.phone_number_sid)registrationState='number_pending';
  let verifiedState=registrationState;if(registrationState==='approved'&&ctx.provider.phone_number_sid){const [number,service,senders]=await Promise.all([child.incomingPhoneNumbers(ctx.provider.phone_number_sid).fetch(),child.messaging.v1.services(ctx.provider.messaging_service_sid).fetch(),child.messaging.v1.services(ctx.provider.messaging_service_sid).phoneNumbers.list({limit:100})]);if(number.accountSid===ctx.provider.account_sid&&senders.some(x=>x.phoneNumberSid===ctx.provider.phone_number_sid)&&/^https:\/\//.test(service.inboundRequestUrl||'')&&/^https:\/\//.test(service.statusCallback||''))verifiedState='webhook_verified';}
  await db.call('compliance_checkpoint',job.id,job.lease_token,'completed',{registrationState:verifiedState,brandRegistrationSid:checkingBrand?value.sid:null,campaignSid:!checkingBrand&&!isTollFree?value.sid:null,verificationSid:isTollFree?value.sid:null,rejectionCode:value.failure_code||value.error_code||null,rejectionReason:value.failure_reason||value.rejection_reason||null,providerResourceSid:value.sid||null});
  return db.call('finish',job.id,job.lease_token,'completed',null,0);
 }
 if(operation.operation!=='purchase_number')throw fail('This compliance operation requires an embedded Twilio session','EMBEDDED_SESSION_REQUIRED',true);
 const number=operation.request?.selection?.phoneNumber;if(!/^\+[1-9]\d{7,14}$/.test(number || ''))throw fail('Choose a valid Twilio number','INVALID_PHONE_SELECTION',true);
 if(!validSid('AC',ctx.provider.account_sid)||!validSid('MG',ctx.provider.messaging_service_sid))throw fail('Twilio child account is incomplete','TWILIO_CHILD_INVALID',true);
 await db.call('compliance_checkpoint',job.id,job.lease_token,'submitting',{});
 let purchased;
 try {purchased=await child.incomingPhoneNumbers.create({phoneNumber:number});}
 catch(error){
  const ambiguous=!error.status || error.status>=500 || error.code==='ETIMEDOUT';await db.call('compliance_checkpoint',job.id,job.lease_token,ambiguous?'submission_unknown':'failed',{errorCode:String(error.code||error.status||'TWILIO_ERROR')});
  return db.call('finish',job.id,job.lease_token,ambiguous?'submission_unknown':'failed',ambiguous?'COMPLIANCE_RECONCILIATION_REQUIRED':'TWILIO_REJECTED',0);
 }
 if(!validSid('PN',purchased?.sid)||purchased.accountSid&&purchased.accountSid!==ctx.provider.account_sid)throw fail('Twilio returned an invalid phone resource','INVALID_PHONE_RESOURCE');
 try {await child.messaging.v1.services(ctx.provider.messaging_service_sid).phoneNumbers.create({phoneNumberSid:purchased.sid});}
 catch(error){await db.call('compliance_checkpoint',job.id,job.lease_token,'submission_unknown',{providerResourceSid:purchased.sid,errorCode:String(error.code||error.status||'ATTACH_UNKNOWN')});return db.call('finish',job.id,job.lease_token,'submission_unknown','COMPLIANCE_RECONCILIATION_REQUIRED',0);}
 await db.call('compliance_checkpoint',job.id,job.lease_token,'completed',{providerResourceSid:purchased.sid,phoneNumberSid:purchased.sid,phoneNumber:purchased.phoneNumber,messagingServiceSid:ctx.provider.messaging_service_sid});
 return db.call('finish',job.id,job.lease_token,'completed',null,0);
}
