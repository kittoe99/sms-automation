import twilio from 'twilio';
import {env} from '../_shared/http.js';

const sid=(prefix,value)=>new RegExp(`^${prefix}[a-f0-9]{32}$`,'i').test(value||'');
const fail=(message,status=400)=>Object.assign(new Error(message),{status});
const approvedProfile=p=>p?.status==='twilio-approved';
const LIMIT=100;

// Inventory and credentials come from the configured parent account, never from
// submitted browser credentials or arbitrary API URLs.
export function createTwilioConnections({clientFactory=twilio,environment=env}={}) {
 function parent() {
  const accountSid=environment('TWILIO_MASTER_ACCOUNT_SID'),authToken=environment('TWILIO_MASTER_AUTH_TOKEN');
  if(!sid('AC',accountSid)||!authToken)throw fail('The platform Twilio account is not configured.',503);
  return {accountSid,authToken,client:clientFactory(accountSid,authToken,{timeout:15000,autoRetry:false})};
 }
 async function account(selected) {
  if(!sid('AC',selected))throw fail('Choose a Twilio account.');
  const master=parent(),row=await master.client.api.v2010.accounts(selected).fetch();
  if(row.sid!==selected||row.ownerAccountSid!==master.accountSid||row.status!=='active')throw fail('This active account does not belong to the connected Twilio account.',403);
  const authToken=selected===master.accountSid?master.authToken:row.authToken;
  if(!authToken)throw fail('Twilio account credentials are unavailable.',503);
  return {row,authToken,parentSid:master.accountSid,client:clientFactory(selected,authToken,{timeout:15000,autoRetry:false})};
 }
 function urls() {
  const base=String(environment('SMS_WEBHOOK_BASE_URL')||`${environment('SUPABASE_URL')||''}/functions/v1/twilio-webhook`).replace(/\/$/,'');
  if(!/^https:\/\/[^\s]+$/.test(base))throw fail('The CRM SMS webhook is not configured.',503);
  return {inbound:`${base}/inbound`,status:`${base}/status`};
 }
 async function inventory(selected) {
  const context=await account(selected),c=context.client;
  const [profiles,brands,verifications,services]=await Promise.all([
   c.trusthub.v1.customerProfiles.list({limit:LIMIT,pageSize:50}),c.messaging.v1.brandRegistrations.list({limit:LIMIT,pageSize:50}),
   c.messaging.v1.tollfreeVerifications.list({limit:LIMIT,pageSize:50}),c.messaging.v1.services.list({limit:LIMIT,pageSize:50}),
  ]);
  const profileBySid=new Map(profiles.filter(approvedProfile).map(p=>[p.sid,p]));
  const options=[],unavailable=[];let truncated=[profiles,brands,verifications,services].some(x=>x.length===LIMIT);
  // Bound service fan-out and preserve failures as errors rather than reporting
  // an empty inventory when Twilio is unavailable or credentials lack access.
  for(const service of services) {
   if(service.accountSid!==selected)continue;
   const resource=c.messaging.v1.services(service.sid);
   const [numbers,campaigns]=await Promise.all([resource.phoneNumbers.list({limit:LIMIT,pageSize:50}),resource.usAppToPerson.list({limit:LIMIT,pageSize:50})]);
   truncated ||= numbers.length===LIMIT||campaigns.length===LIMIT;
   if(!numbers.length){unavailable.push({name:service.friendlyName,reason:'No phone number attached'});continue;}
   for(const number of numbers) {
    let registration,profile,brand,type,reason;
    const tollFree=/^\+1(800|888|877|866|855|844|833)/.test(number.phoneNumber||'');
    if(tollFree) {
     type='toll_free';registration=verifications.find(v=>v.tollfreePhoneNumberSid===number.sid&&v.status==='TWILIO_APPROVED'&&v.accountSid===selected);
     profile=profileBySid.get(registration?.customerProfileSid);
     if(!registration)reason='Toll-free verification is not approved';
     else if(registration.customerProfileSid&&!profile)reason='Associated business profile is not approved';
    } else {
     type='local_a2p';registration=campaigns.find(r=>r.campaignStatus==='VERIFIED'&&r.accountSid===selected&&r.messagingServiceSid===service.sid&&!r.mock);
     brand=brands.find(b=>b.sid===registration?.brandRegistrationSid&&b.status==='APPROVED'&&!b.mock&&b.accountSid===selected);
     profile=profileBySid.get(brand?.customerProfileBundleSid);
     if(!registration)reason='A2P campaign is not verified';
     else if(!brand||!profile)reason='A2P brand or associated business profile is not approved';
     else if(number.countryCode!=='US')reason='Only US A2P local numbers are supported';
    }
    if(!reason&&numbers.length!==1)reason='Use a Messaging Service with exactly one phone number so this business always uses its selected number';
    if(!reason&&!(number.capabilities||[]).includes('SMS'))reason='This number does not support SMS';
    if(reason){unavailable.push({name:service.friendlyName,phoneNumber:number.phoneNumber,reason});continue;}
    const target=urls();
    options.push({accountSid:selected,accountName:context.row.friendlyName,profileSid:profile?.sid||null,
     profileName:profile?.friendlyName||registration.businessName,legalBusinessName:registration.businessName||profile?.friendlyName,
     messagingServiceSid:service.sid,serviceName:service.friendlyName,phoneNumberSid:number.sid,phoneNumber:number.phoneNumber,
     senderType:type,approvalStatus:type==='toll_free'?'Toll-free verified':'A2P campaign verified',
     registrationSid:registration.sid,brandSid:brand?.sid||null,
     webhookReady:service.inboundRequestUrl===target.inbound&&service.statusCallback===target.status&&service.inboundMethod==='POST'&&!service.useInboundWebhookOnNumber,
     numberRegistrationNote:type==='local_a2p'?'Carrier registration must finish for this number. Activation still requires a successful delivery test.':null});
   }
  }
  return {context,options,unavailable,truncated};
 }
 return {
  async accounts(db,user) {
   const access=await db.call('twilio_connection_access',user,null),master=parent();
   const rows=await master.client.api.v2010.accounts.list({status:'active',limit:LIMIT,pageSize:50});
   const accounts=rows.filter(r=>r.ownerAccountSid===master.accountSid&&r.status==='active').map(r=>({sid:r.sid,name:r.friendlyName,
    isParent:r.sid===master.accountSid,assignedBusiness:access.bindings?.find(b=>b.accountSid===r.sid)||null}));
   return {accounts,truncated:rows.length===LIMIT};
  },
  async profiles(db,user,selected,tenant) {
   const access=await db.call('twilio_connection_access',user,tenant);
   const data=await inventory(selected);
   const binding=access.bindings?.find(b=>b.accountSid===selected);
   return {options:data.options.map(p=>({...p,assignedBusiness:binding||null})),unavailable:data.unavailable,truncated:data.truncated,
    business:access.business,connection:access.connection};
  },
  async connect(db,user,input) {
   if(input?.confirmedBusinessIdentity!==true)throw fail('Confirm that this Twilio profile belongs to the selected CRM business.');
   const tenant=input.tenantId;await db.call('twilio_connection_access',user,tenant);
   const data=await inventory(input.accountSid);
   const candidate=data.options.find(p=>p.messagingServiceSid===input.messagingServiceSid&&p.phoneNumberSid===input.phoneNumberSid&&p.registrationSid===input.registrationSid);
   if(!candidate)throw fail('That approved sender is no longer available. Refresh Twilio profiles and choose again.',409);
   const number=await data.context.client.incomingPhoneNumbers(candidate.phoneNumberSid).fetch();
   if(number.accountSid!==candidate.accountSid||number.phoneNumber!==candidate.phoneNumber||number.capabilities?.sms!==true)throw fail('Twilio number ownership could not be verified.',403);
   const reservation=await db.call('reserve_twilio_connection',user,tenant,{...candidate,revision:input.revision});
   if(reservation.alreadyConnected)return reservation;
   try {
    if(!candidate.webhookReady)await data.context.client.messaging.v1.services(candidate.messagingServiceSid).update({
     inboundRequestUrl:urls().inbound,inboundMethod:'POST',statusCallback:urls().status,useInboundWebhookOnNumber:false,
    });
    const verified=await data.context.client.messaging.v1.services(candidate.messagingServiceSid).fetch();
    if(verified.accountSid!==candidate.accountSid||verified.inboundRequestUrl!==urls().inbound||verified.statusCallback!==urls().status||verified.inboundMethod!=='POST'||verified.useInboundWebhookOnNumber)throw fail('Twilio webhook verification failed. Refresh and retry.',409);
    return await db.call('complete_twilio_connection',user,tenant,reservation.id,{...candidate,parentAccountSid:data.context.parentSid,authToken:data.context.authToken});
   } catch(error) {
    await db.call('fail_twilio_connection',user,tenant,reservation.id).catch(()=>{});
    throw error;
   }
  },
 };
}
