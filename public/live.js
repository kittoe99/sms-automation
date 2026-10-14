import {runtimeConfig,getAccessToken,getTenantId} from './auth.js?v=20261001-business-services';

// Retire subscriptions and timers together, including late SDK/subscription
// callbacks. Each authenticated business has exactly one live connection.
export function createLiveConnection({loadClient, getToken, setIntervalFn = setInterval, clearIntervalFn = clearInterval,
 setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout} = {}) {
 let client, channel, poll, tokenTimer, refreshTimer, generation = 0;
 function disconnect() {
  generation++;
  clearIntervalFn(poll);clearIntervalFn(tokenTimer);clearTimeoutFn(refreshTimer);
  poll = tokenTimer = refreshTimer = null;
  if (channel) {const old = channel;channel = null;void Promise.resolve(client.removeChannel(old)).catch(() => {});}
 }
 async function connect({tenant, onChange, onStatus}) {
  disconnect();const own = generation;
  if (!tenant) return false;
  let loaded;
  try{loaded=await loadClient();}catch(error){if(own!==generation)return false;throw error;}
  if (own !== generation) return false;
  client = loaded;
  const current = () => own === generation;
  const changed = () => {if (!current()) return;clearTimeoutFn(refreshTimer);refreshTimer=setTimeoutFn(() => {if(current())onChange();},250);};
  channel=client.channel(`crm:${tenant}`);
  for(const table of ['sms_messages','sms_thread_contacts','sms_automation_enrollments']) {
   channel.on('postgres_changes',{event:'*',schema:'public',table,filter:`tenant_id=eq.${tenant}`},changed);
  }
  channel.subscribe(status=>{
   if (!current()) return;
   onStatus(status==='SUBSCRIBED',status==='SUBSCRIBED'?'Live':'Reconnecting…');
   if(status==='SUBSCRIBED'){clearIntervalFn(poll);poll=null;}
   else if(!poll)poll=setIntervalFn(() => {if(current())onChange();},15000);
  });
  tokenTimer=setIntervalFn(async()=>{
   try {const token=await getToken();if(current()&&token)await client.realtime.setAuth(token);} catch {if(current())onStatus(false,'Reconnecting…');}
  },45000);
  return true;
 }
 return {connect,disconnect};
}

let client;
const connection=createLiveConnection({getToken:getAccessToken,loadClient:async()=>{
 if(!client){const {createClient}=await import('/vendor/supabase.js');client=createClient(runtimeConfig.supabaseUrl,runtimeConfig.supabasePublishableKey,{accessToken:getAccessToken,auth:{persistSession:false,autoRefreshToken:false}});}
 return client;
}});
export function disconnectSupabaseLive() {connection.disconnect();}
export async function connectSupabaseLive(onChange,onStatus) {
 if(!runtimeConfig.supabaseUrl||!runtimeConfig.supabasePublishableKey){connection.disconnect();return false;}
 return connection.connect({tenant:getTenantId(),onChange,onStatus});
}
