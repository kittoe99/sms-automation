import {canOpenWorkspace} from './workspacePermissions.js';
import {dashboardIcon} from './dashboardIcons.js';

const item=(view,label,aliases='')=>({view,label,aliases});
export const workspaceGroups = [
 {id:'home',label:'Home',icon:'overview',daily:true,views:[item('overview','Home','overview dashboard')]},
 {id:'inbox',label:'Inbox',icon:'messaging',daily:true,views:[item('messaging','Messages','inbox conversations sms'),item('call','Calls','inbound calls recordings'),item('handoffs','Needs your help','handoffs leads requests')]},
 {id:'contacts',label:'Contacts',icon:'contacts',daily:true,views:[item('contacts','Contacts','customers directory'),item('optouts','Unsubscribed from SMS','opt-outs stop suppressed')]},
 {id:'bookings',label:'Bookings',icon:'bookings',daily:true,views:[item('bookings','Bookings','appointments')]},
 {id:'followups',label:'Follow-ups',icon:'forms',daily:true,views:[item('automation-activity','Activity','automation activity sequences enquiries'),item('form-followups','Form follow-ups','form automations'),item('contact-templates','Contact templates','direct automation templates'),item('email','Email','email groups campaigns')]},
 {id:'forms',label:'Forms',icon:'forms',daily:true,views:[item('web-forms','Forms','form builder submissions')]},
 {id:'ai',label:'AI assistants',icon:'voice',views:[item('inbound-ai','Text replies','inbound ai shadow live'),item('voice-agent','Voice agents','voice agent configuration')]},
 {id:'reports',label:'Reports',icon:'reports',views:[item('messages','Message history','sms log'),item('deliverability','Message delivery','deliverability delivery report')]},
 {id:'settings',label:'Settings',icon:'setup',views:[item('business-context','Business information','business context knowledge profile'),item('booking-setup','Booking availability','service availability schedules'),item('business-setup','SMS connection','sms activation business setup phone sender')]},
 {id:'admin',label:'Administration',icon:'platform',views:[item('platform-accounts','Users','platform accounts'),item('platform-businesses','Businesses','platform ownership'),item('platform-websites','Websites','hosting deployments domains'),item('platform-twilio','Twilio accounts','provider phone accounts')]},
];
export const groupForView=view=>workspaceGroups.find(group=>group.views.some(item=>item.view===view));
export function permittedGroups(staff,tenant) {
 return workspaceGroups.map(group=>({...group,views:group.views.filter(item=>
  (tenant||item.view.startsWith('platform-'))&&canOpenWorkspace(item.view,staff,tenant))})).filter(group=>group.views.length);
}
export function navigationMarkup({view,staff,tenant,query='',expanded=[]}) {
 const q=query.trim().toLowerCase();
 const link=(entry,label=entry.label)=>`<button type="button" class="nav-item ${view===entry.view?'active':''}" data-view="${entry.view}" ${view===entry.view?'aria-current="page"':''}>${label}</button>`;
 return permittedGroups(staff,tenant).map(group=>{
  const active=group.views.some(item=>item.view===view);
  if(q){const entries=group.views.filter(item=>`${group.label} ${item.label} ${item.aliases}`.toLowerCase().includes(q));return entries.length?`<section class="navigation-results"><p class="nav-label">${group.label}</p>${entries.map(item=>link(item)).join('')}</section>`:'';}
  if(group.daily)return `<button type="button" class="nav-item daily-link ${active?'active':''}" data-view="${group.views[0].view}" ${active?'aria-current="page"':''}>${dashboardIcon(group.icon)}<span>${group.label}</span></button>`;
  return `<details class="navigation-group" data-navigation-group="${group.id}" ${active||expanded.includes(group.id)?'open':''}><summary>${dashboardIcon(group.icon)}<span>${group.label}</span></summary>${group.views.map(item=>link(item)).join('')}${group.id==='admin'?'<div data-business-action></div>':''}</details>`;
 }).join('')||'<p class="muted navigation-empty">No matching pages.</p>';
}
