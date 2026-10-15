import {canOpenWorkspace} from './workspacePermissions.js';
import {dashboardIcon} from './dashboardIcons.js';

const item=(view,label,aliases='')=>({view,label,aliases});
export const workspaceGroups = [
 {id:'home',label:'Home',icon:'overview',daily:true,views:[item('overview','Home','overview dashboard')]},
 {id:'sms',label:'SMS',icon:'messaging',daily:true,views:[item('messaging','Inbox','messages conversations sms'),item('handoffs','Needs your help','handoffs leads requests'),item('contact-templates','Contact messages','direct automation templates follow-ups'),item('form-followups','Form messages','form follow-ups automations'),item('inbound-ai','AI replies','text replies inbound ai shadow live'),item('automation-activity','Follow-up activity','automation activity sequences enquiries'),item('messages','Message history','sms log reports'),item('deliverability','Delivery','deliverability delivery report')]},
 {id:'contacts',label:'Contacts',icon:'contacts',daily:true,views:[item('contacts','Contacts','customers directory'),item('optouts','Unsubscribed from SMS','opt-outs stop suppressed')]},
 {id:'bookings',label:'Bookings',icon:'bookings',daily:true,views:[item('bookings','Bookings','appointments')]},
 {id:'forms',label:'Forms',icon:'forms',daily:true,views:[item('web-forms','Forms','form builder submissions')]},
 {id:'voice',label:'Calls & voice',icon:'voice',views:[item('call','Calls','inbound calls recordings'),item('voice-agent','Voice agents','voice agent configuration ai assistants')]},
 {id:'email',label:'Email',icon:'messaging',daily:true,views:[item('email','Email','email groups campaigns')]},
 {id:'settings',label:'Settings',icon:'setup',views:[item('business-context','Business information','business context knowledge profile'),item('booking-setup','Booking availability','service availability schedules'),item('business-setup','SMS connection','sms activation business setup phone sender')]},
 {id:'admin',label:'Administration',icon:'platform',views:[item('platform-accounts','Users','platform accounts'),item('platform-businesses','Businesses','platform ownership'),item('platform-websites','Websites','hosting deployments domains'),item('platform-twilio','Twilio accounts','provider phone accounts'),item('platform-ai-connections','AI connections','mcp agents permissions audit')]},
];
export const groupForView=view=>workspaceGroups.find(group=>group.views.some(item=>item.view===view));
const smsSections = [
 {label:'Inbox',children:['messaging','handoffs']},
 {label:'Automations',children:['contact-templates','form-followups']},
 {label:'AI replies',children:['inbound-ai']},
 {label:'Activity',children:['automation-activity','messages','deliverability']},
];
export function navigationLevels(group,view) {
 if(group?.id!=='sms')return {primary:group,secondary:null};
 const sections=smsSections.map(section=>({...section,views:group.views.filter(entry=>section.children.includes(entry.view))})).filter(section=>section.views.length);
 const selected=sections.find(section=>section.children.includes(view));
 return {primary:{label:'SMS',views:sections.map(section=>({view:section.views[0].view,label:section.label,children:section.views.map(entry=>entry.view)}))},
  secondary:selected?{label:`SMS ${selected.label}`,views:selected.views}:null};
}
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

// Keep pointer/focus targets mounted while async page loads update the shell.
// Only permissions or search results change the navigation's structure.
const navigationState = new WeakMap();
export function syncNavigation(nav, options) {
 const groups=permittedGroups(options.staff,options.tenant);
 const key=JSON.stringify([groups,options.query?.trim().toLowerCase()||'']);
 const previous=navigationState.get(nav);
 const rebuilt=previous?.key!==key;
 if(rebuilt) {
  const expanded=[...nav.querySelectorAll('[data-navigation-group][open]')].map(node=>node.dataset.navigationGroup);
  nav.innerHTML=navigationMarkup({...options,expanded});
 }
 const activeGroup=groupForView(options.view);
 for(const node of nav.querySelectorAll('[data-view]')) {
  const active=node.classList.contains('daily-link')
   ? groupForView(node.dataset.view)?.id===activeGroup?.id : node.dataset.view===options.view;
  node.classList.toggle('active',active);
  if(active)node.setAttribute('aria-current','page');else node.removeAttribute('aria-current');
 }
 if(rebuilt||previous.view!==options.view) {
  const group=nav.querySelector(`[data-navigation-group="${activeGroup?.id}"]`);
  if(group)group.open=true;
 }
 navigationState.set(nav,{key,view:options.view});
 return rebuilt;
}

const tabState = new WeakMap();
export function syncNavigationTabs(tabs, group, view) {
 const key=JSON.stringify(group?.views||[]);
 tabs.hidden=!group||group.views.length<2;
 if(tabState.get(tabs)!==key) {
  tabs.innerHTML=tabs.hidden?'':group.views.map(item=>`<button type="button" role="tab" data-view="${item.view}" aria-controls="view-root">${item.label}</button>`).join('');
  tabState.set(tabs,key);
 }
 tabs.setAttribute('aria-label',group?.label||'Workspace');
 for(const node of tabs.querySelectorAll('[data-view]')) {
  const entry=group?.views.find(item=>item.view===node.dataset.view);
  const active=node.dataset.view===view||Boolean(entry?.children?.includes(view));
  node.setAttribute('aria-selected',String(active));node.tabIndex=active?0:-1;
 }
}
