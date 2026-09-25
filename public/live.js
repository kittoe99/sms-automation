import {runtimeConfig,getAccessToken,getTenantId} from './auth.js?v=20260924-auth-loop1';
let client,channel,poll,timer,refresh;
export async function connectSupabaseLive(onChange,onStatus) {
 if(!runtimeConfig.supabaseUrl || !runtimeConfig.supabasePublishableKey) return false;
 const {createClient}=await import('/vendor/supabase.js');
 if(!client) client=createClient(runtimeConfig.supabaseUrl,runtimeConfig.supabasePublishableKey,{accessToken:getAccessToken,auth:{persistSession:false,autoRefreshToken:false}});
 if(channel) await client.removeChannel(channel);
 clearInterval(poll);clearInterval(timer);
 const tenant=getTenantId();
 const changed=()=>{clearTimeout(refresh);refresh=setTimeout(onChange,250);};
 channel=client.channel(`crm:${tenant}`);
 for(const table of ['sms_messages','sms_thread_contacts','sms_automation_enrollments']) channel.on('postgres_changes',{event:'*',schema:'public',table,filter:`tenant_id=eq.${tenant}`},changed);
 channel.subscribe(status=>{
   onStatus(status==='SUBSCRIBED',status==='SUBSCRIBED'?'Live':'Reconnecting…');
   if(status==='SUBSCRIBED'){clearInterval(poll);poll=null;}
   else if(!poll) poll=setInterval(onChange,15000);
 });
 timer=setInterval(async()=>{const token=await getAccessToken();if(token)await client.realtime.setAuth(token);},45000);
 return true;
}
