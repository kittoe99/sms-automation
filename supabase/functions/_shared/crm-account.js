import {env} from './http.js';
export async function syncCrmLogin(db,subject,{fetchImpl=fetch}={}) {
 const secret=env('CRM_CLERK_SECRET_KEY');
 if(!secret) throw Object.assign(new Error('CRM account synchronization is not configured'),{status:503});
 const response=await fetchImpl(`https://api.clerk.com/v1/users/${encodeURIComponent(subject)}`,{
  headers:{Authorization:`Bearer ${secret}`},signal:AbortSignal.timeout(8000),
 });
 if(!response.ok) throw Object.assign(new Error('Could not load CRM account'),{status:response.status===404?401:503});
 const user=await response.json();
 if(user.id!==subject || !Number.isSafeInteger(user.updated_at)) throw Object.assign(new Error('Invalid CRM account'),{status:503});
 const name=[user.first_name,user.last_name].map(value=>value?.trim()).filter(Boolean).join(' ')||null;
 const email=user.email_addresses?.find(value=>value.id===user.primary_email_address_id)?.email_address.trim()||null;
 return db.call('sync_crm_account',subject,name,email,user.updated_at);
}
