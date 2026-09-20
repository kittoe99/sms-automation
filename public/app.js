import { connectSupabaseLive } from './live.js';
import {
  apiFetch,
  getAccessToken,
  getSession,
  getTenantId,
  initAuth,
  isDemoMode,
  renderLoginScreen,
  runtimeConfig,
  showCrmApp,
  signOut,
  setTenantId,
} from './auth.js?v=20260916-manual-business1';

const state = {
  view: 'overview',
  categoryId: null,
  q: '',
  status: '',
  page: 1,
  pageSize: 50,
  totalPages: 1,
  categories: [],
  cadences: [],
  rulePresets: [],
  selected: null,
  conversationPhone: null,
  unreadOnly: false,
  contactStatus: '',
  contactTab: 'directory',
  sourceFilter: '',
  consentedOnly: false,
  tenants: [],
  tenant: null,
  automationBuilderOpen: false,
  automationPresetId: null,
  aiBuilderOpen: false,
  businessContextDraft: null,
  bookingSettingsDraft: null,
  bookingStatus: '',
};

const el = {
  title: document.getElementById('page-title'),
  sub: document.getElementById('page-sub'),
  kpi: document.getElementById('kpi'),
  root: document.getElementById('view-root'),
  pager: document.getElementById('pager'),
  pageInfo: document.getElementById('page-info'),
  prev: document.getElementById('prev-page'),
  next: document.getElementById('next-page'),
  pageSize: document.getElementById('page-size'),
  search: document.getElementById('search'),
  status: document.getElementById('status-filter'),
  navAutomations: document.getElementById('nav-automations'),
  drawer: document.getElementById('drawer'),
  drawerBackdrop: document.getElementById('drawer-backdrop'),
  drawerTitle: document.getElementById('drawer-title'),
  drawerBody: document.getElementById('drawer-body'),
  storeMeta: document.getElementById('store-meta'),
  toolbarSection: document.getElementById('toolbar-section'),
  sidebar: document.getElementById('sidebar'),
  sidebarTrigger: document.getElementById('sidebar-trigger'),
  sidebarClose: document.getElementById('sidebar-close'),
  sidebarBackdrop: document.getElementById('sidebar-backdrop'),
  tenantSelect: document.getElementById('tenant-select'),
  toolbarTenant: document.getElementById('toolbar-tenant'),
  tenantAvatar: document.getElementById('tenant-avatar'),
};

let drawerReturnFocus = null;

function syncOverlayLock() {
  const crm = document.querySelector('.crm');
  const hasOpenOverlay = Boolean(
    crm?.classList.contains('sidebar-open') || crm?.classList.contains('drawer-open'),
  );
  document.body.classList.toggle('ui-overlay-open', hasOpenOverlay);
}

el.tenantSelect?.addEventListener('change', () => {
  setTenantId(el.tenantSelect.value);
  location.reload();
});

window.addEventListener('clerk:organization-changed', () => location.reload());

document.getElementById('add-business')?.addEventListener('click', () => {
  const currentZone = state.tenant?.timeZone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'America/Denver';
  openDrawer('Add business', `
    <form id="add-business-form" class="compose">
      <label class="compose-label" for="business-name">Business name</label>
      <input id="business-name" maxlength="100" required placeholder="Business name" autocomplete="organization" />
      <label class="compose-label" for="business-timezone">Time zone</label>
      <input id="business-timezone" value="${esc(currentZone)}" required placeholder="America/Denver" />
      <p class="muted">Create an empty workspace. No user registration is required. A separate Twilio subaccount and Messaging Service will be prepared automatically under the parent billing account.</p>
      <div class="compose-actions"><span id="business-error" class="login-error" role="alert"></span>
        <button type="submit" class="btn">Add business</button>
      </div>
    </form>`);
  const form = el.drawerBody.querySelector('#add-business-form');
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const error = form.querySelector('#business-error');
    error.textContent = '';
    button.disabled = true;
    try {
      const response = await apiFetch('/api/businesses', { tenant: false, method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
          name: form.querySelector('#business-name').value.trim(),
          timeZone: form.querySelector('#business-timezone').value.trim(),
        }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not add business');
      setTenantId(data.business.id);
      location.reload();
    } catch (failure) {
      error.textContent = failure.message;
      button.disabled = false;
    }
  });
  el.drawerBody.querySelector('#business-name').focus();
});

function openBusinessSetup(provisioning = null) {
  if (provisioning) state.setupProvisioning = provisioning;
  state.view = 'business-setup';
  state.page = 1;
  setActiveNav();
  closeDrawer();
  closeSidebar();
  load();
}

function openBusinessContext() {
  state.view = 'business-context';
  state.page = 1;
  setActiveNav();
  closeDrawer();
  closeSidebar();
  load();
}

function refreshFromBackground() {
  if (el.root.querySelector('form[data-dirty="true"]')) return Promise.resolve(false);
  return load();
}

function onboardingStorageKey() {
  return `opek_sms_onboarding_${getTenantId() || state.tenant?.id || 'default'}`;
}

function readLocalOnboarding() {
  try {
    const raw = localStorage.getItem(onboardingStorageKey());
    if (!raw) return null;
    const data = JSON.parse(raw);
    if (!data || typeof data !== 'object') return null;
    return data;
  } catch {
    return null;
  }
}

function writeLocalOnboarding(data) {
  try {
    localStorage.setItem(onboardingStorageKey(), JSON.stringify({ ...data, localOnly: true }));
  } catch {
    // Private browsing etc. must not block onboarding.
  }
}

const bookingDays=['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const defaultBookingSettings=()=>({enabled:false,version:0,slotDurationMinutes:60,capacityPerSlot:1,minimumNoticeMinutes:120,maximumAdvanceDays:90,followUpEnabled:false,followUpDelayHours:24,followUpIntervalHours:48,followUpMaxAttempts:2,weeklyAvailability:{0:[],1:[],2:[],3:[],4:[],5:[],6:[]},dateExceptions:[],extraFields:[]});
const bookingKey=value=>String(value||'').trim().toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_|_$/g,'').slice(0,40);

async function renderBookingSetup(){
 setTitle(...titles['booking-setup']);el.kpi.innerHTML='';el.pager.hidden=true;
 if(!state.bookingSettingsDraft){const response=await apiFetch('/api/booking-settings'),data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load booking settings');state.bookingSettingsDraft={...defaultBookingSettings(),...data};}
 const draft=state.bookingSettingsDraft;
 const draw=()=>{
  const weekly=bookingDays.map((day,index)=>{const window=draft.weeklyAvailability?.[index]?.[0]||{};return `<div class="booking-window"><label><input type="checkbox" data-day-enabled="${index}" ${window.start?'checked':''}/> ${day}</label><input type="time" data-day-start="${index}" value="${esc(window.start||'09:00')}" ${window.start?'':'disabled'}/><span>to</span><input type="time" data-day-end="${index}" value="${esc(window.end||'17:00')}" ${window.start?'':'disabled'}/></div>`;}).join('');
  const exceptions=(draft.dateExceptions||[]).map((x,index)=>`<div class="booking-config-row" data-exception-row="${index}"><input type="date" value="${esc(x.date||'')}" data-exception-date/><label><input type="checkbox" data-exception-closed ${x.closed?'checked':''}/> Closed</label><input type="time" data-exception-start value="${esc(x.windows?.[0]?.start||'09:00')}" ${x.closed?'disabled':''}/><span>to</span><input type="time" data-exception-end value="${esc(x.windows?.[0]?.end||'17:00')}" ${x.closed?'disabled':''}/><button type="button" class="btn ghost" data-remove-exception="${index}">Remove</button></div>`).join('');
  const fields=(draft.extraFields||[]).map((f,index)=>`<div class="booking-field-row" data-field-row="${index}"><span class="drag-hint">${index+1}</span><input data-field-question maxlength="240" placeholder="Question to ask" value="${esc(f.question||'')}"/><input data-field-key maxlength="40" placeholder="field_key" value="${esc(f.key||'')}"/><select data-field-type><option value="short_text">Short text</option><option value="long_text">Long text</option><option value="number">Number</option><option value="boolean">Yes / no</option><option value="single_select">Single select</option></select><label><input type="checkbox" data-field-required ${f.required?'checked':''}/> Required</label><input data-field-options placeholder="Options, comma separated" value="${esc((f.options||[]).join(', '))}" ${f.type==='single_select'?'':'hidden'}/><button type="button" class="btn ghost" data-remove-field="${index}">Remove</button></div>`).join('');
  el.root.innerHTML=`<form id="booking-settings-form" class="setup-page" data-dirty="${draft._dirty?'true':'false'}"><section class="card setup-hero"><div><span class="eyebrow">Deterministic SMS booking</span><h2>Let customers book from a text.</h2><p class="muted">The AI collects values; Supabase checks the slot and creates the booking only after the customer replies YES.</p></div><label class="setup-radio"><input id="booking-enabled" type="checkbox" ${draft.enabled?'checked':''}/><span><strong>Enable booking by SMS</strong><small>Existing inbound answers continue normally when disabled.</small></span></label></section><div class="setup-layout"><div class="setup-main"><section class="card"><div class="card-head"><h2>Availability</h2></div><div class="setup-body"><div class="automation-form-grid"><label>Slot length (minutes)<input id="booking-duration" type="number" min="15" max="480" value="${esc(draft.slotDurationMinutes)}"/></label><label>Bookings allowed per slot<input id="booking-capacity" type="number" min="1" max="100" value="${esc(draft.capacityPerSlot)}"/><small class="muted">The slot stays open until this many confirmed bookings exist.</small></label><label>Minimum notice (minutes)<input id="booking-notice" type="number" min="0" max="43200" value="${esc(draft.minimumNoticeMinutes)}"/></label><label>Maximum advance (days)<input id="booking-advance" type="number" min="1" max="730" value="${esc(draft.maximumAdvanceDays)}"/></label></div><div class="booking-windows">${weekly}</div></div></section><section class="card"><div class="card-head"><h2>AI booking follow-ups</h2></div><div class="setup-body"><label class="setup-radio"><input id="booking-followup-enabled" type="checkbox" ${draft.followUpEnabled?'checked':''}/><span><strong>Follow up on unfinished bookings</strong><small>The AI sends a helpful reminder from approved business context and stops after the limit or any customer reply.</small></span></label><div class="automation-form-grid" style="margin-top:16px"><label>First follow-up after (hours)<input id="booking-followup-delay" type="number" min="1" max="720" value="${esc(draft.followUpDelayHours)}"/></label><label>Time between follow-ups (hours)<input id="booking-followup-interval" type="number" min="1" max="720" value="${esc(draft.followUpIntervalHours)}"/></label><label>Maximum follow-ups<input id="booking-followup-max" type="number" min="1" max="5" value="${esc(draft.followUpMaxAttempts)}"/></label></div></div></section><section class="card"><div class="card-head"><h2>Date exceptions</h2><button type="button" class="btn ghost" id="add-booking-exception">Add date</button></div><div class="setup-body" id="booking-exceptions">${exceptions||'<p class="muted">No closures or custom-date hours.</p>'}</div></section><section class="card"><div class="card-head"><div><h2>Extra questions</h2><span class="muted">Name, phone, address, date, and time are always collected.</span></div><button type="button" class="btn ghost" id="add-booking-field">Add question</button></div><div class="setup-body" id="booking-fields">${fields||'<p class="muted">No additional questions.</p>'}</div></section><div class="compose-actions"><span id="booking-settings-error" class="login-error" role="alert"></span><span id="booking-settings-saved" class="muted"></span><button class="btn" type="submit">Save booking setup</button></div></div><aside class="setup-side"><div class="card setup-card"><div class="card-head"><h2>How confirmation works</h2></div><div class="setup-body"><ol class="setup-help-list"><li>The assistant asks one missing question at a time.</li><li>The database validates the requested slot.</li><li>The customer receives a summary and replies YES.</li><li>The slot is checked again and booked atomically.</li></ol><p class="muted">Configuration version ${esc(draft.version||'new')}</p></div></div></aside></div></form>`;
  el.root.querySelectorAll('[data-field-type]').forEach((select,index)=>{select.value=draft.extraFields[index]?.type||'short_text';select.addEventListener('change',()=>{select.closest('[data-field-row]').querySelector('[data-field-options]').hidden=select.value!=='single_select';mark();});});
  const mark=()=>{draft._dirty=true;el.root.querySelector('#booking-settings-form')?.setAttribute('data-dirty','true');};
  const sync=()=>{draft.enabled=el.root.querySelector('#booking-enabled').checked;draft.slotDurationMinutes=Number(el.root.querySelector('#booking-duration').value);draft.capacityPerSlot=Number(el.root.querySelector('#booking-capacity').value);draft.minimumNoticeMinutes=Number(el.root.querySelector('#booking-notice').value);draft.maximumAdvanceDays=Number(el.root.querySelector('#booking-advance').value);draft.followUpEnabled=el.root.querySelector('#booking-followup-enabled').checked;draft.followUpDelayHours=Number(el.root.querySelector('#booking-followup-delay').value);draft.followUpIntervalHours=Number(el.root.querySelector('#booking-followup-interval').value);draft.followUpMaxAttempts=Number(el.root.querySelector('#booking-followup-max').value);draft.weeklyAvailability={};bookingDays.forEach((_,i)=>{const on=el.root.querySelector(`[data-day-enabled="${i}"]`).checked;draft.weeklyAvailability[i]=on?[{start:el.root.querySelector(`[data-day-start="${i}"]`).value,end:el.root.querySelector(`[data-day-end="${i}"]`).value}]:[];});draft.dateExceptions=[...el.root.querySelectorAll('[data-exception-row]')].map(row=>{const closed=row.querySelector('[data-exception-closed]').checked;return {date:row.querySelector('[data-exception-date]').value,closed,windows:closed?[]:[{start:row.querySelector('[data-exception-start]').value,end:row.querySelector('[data-exception-end]').value}]};});draft.extraFields=[...el.root.querySelectorAll('[data-field-row]')].map(row=>{const question=row.querySelector('[data-field-question]').value.trim(),type=row.querySelector('[data-field-type]').value;return {key:bookingKey(row.querySelector('[data-field-key]').value||question),question,type,required:row.querySelector('[data-field-required]').checked,options:type==='single_select'?row.querySelector('[data-field-options]').value.split(',').map(x=>x.trim()).filter(Boolean):[]};});};
  el.root.querySelectorAll('input,select').forEach(input=>input.addEventListener('input',()=>{sync();mark();}));
  el.root.querySelectorAll('[data-day-enabled]').forEach(box=>box.addEventListener('change',()=>{const i=box.dataset.dayEnabled;el.root.querySelector(`[data-day-start="${i}"]`).disabled=!box.checked;el.root.querySelector(`[data-day-end="${i}"]`).disabled=!box.checked;}));
  el.root.querySelectorAll('[data-exception-closed]').forEach(box=>box.addEventListener('change',()=>box.closest('[data-exception-row]').querySelectorAll('[type="time"]').forEach(x=>x.disabled=box.checked)));
  el.root.querySelector('#add-booking-exception')?.addEventListener('click',()=>{sync();draft.dateExceptions.push({date:'',closed:true,windows:[]});mark();draw();});
  el.root.querySelector('#add-booking-field')?.addEventListener('click',()=>{sync();draft.extraFields.push({key:'',question:'',type:'short_text',required:false,options:[]});mark();draw();});
  el.root.querySelectorAll('[data-remove-exception]').forEach(button=>button.addEventListener('click',()=>{sync();draft.dateExceptions.splice(Number(button.dataset.removeException),1);mark();draw();}));
  el.root.querySelectorAll('[data-remove-field]').forEach(button=>button.addEventListener('click',()=>{sync();draft.extraFields.splice(Number(button.dataset.removeField),1);mark();draw();}));
  el.root.querySelector('#booking-settings-form')?.addEventListener('submit',async event=>{event.preventDefault();sync();const error=el.root.querySelector('#booking-settings-error'),saved=el.root.querySelector('#booking-settings-saved'),button=event.currentTarget.querySelector('[type="submit"]');error.textContent='';saved.textContent='';button.disabled=true;try{const payload={...draft};delete payload._dirty;delete payload.version;const response=await apiFetch('/api/booking-settings',{method:'PUT',body:JSON.stringify(payload)}),data=await response.json();if(!response.ok)throw new Error(data.error||'Could not save booking setup');state.bookingSettingsDraft={...defaultBookingSettings(),...data};saved.textContent='Saved';draw();}catch(failure){error.textContent=failure.message;button.disabled=false;mark();}});
 };
 draw();
}

async function renderBookings(){
 setTitle(...titles.bookings);el.kpi.innerHTML='';el.pager.hidden=false;el.status.hidden=true;el.search.placeholder='Search name, phone, or address…';
 const params=new URLSearchParams({page:String(state.page),pageSize:String(state.pageSize)});if(state.q)params.set('q',state.q);if(state.bookingStatus)params.set('status',state.bookingStatus);
 const response=await apiFetch(`/api/bookings?${params}`),data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load bookings');state.totalPages=data.totalPages||1;renderPager(data);
 const rows=(data.bookings||[]).map(b=>`<tr data-booking-id="${esc(b.id)}"><td><strong>${esc(b.customer_name||'—')}</strong><br><span class="muted">${esc(b.customer_phone||b.contact_phone||'')}</span></td><td>${esc(fmtTime(b.appointment_at))}</td><td>${esc(b.service_address||'—')}</td><td><span class="status ${esc(b.status)}">${esc(b.status)}</span></td><td>${esc(b.source||'—')}</td></tr>`).join('');
 el.root.innerHTML=`<section class="card"><div class="card-head"><div><h2>Appointments</h2><span class="muted">${fmt(data.total)} booking${Number(data.total)===1?'':'s'}</span></div><select id="booking-status-filter"><option value="">All statuses</option><option value="confirmed">Confirmed</option><option value="cancelled">Cancelled</option><option value="requested">Requested</option></select></div><div class="table-scroll"><table class="data"><thead><tr><th>Customer</th><th>Date and time</th><th>Address</th><th>Status</th><th>Source</th></tr></thead><tbody>${rows||'<tr><td colspan="5" class="empty">No bookings yet.</td></tr>'}</tbody></table></div></section>`;
 const filter=el.root.querySelector('#booking-status-filter');filter.value=state.bookingStatus;filter.addEventListener('change',()=>{state.bookingStatus=filter.value;state.page=1;renderBookings();});
 el.root.querySelectorAll('[data-booking-id]').forEach(row=>row.addEventListener('click',async()=>{const id=row.dataset.bookingId,res=await apiFetch(`/api/bookings/${encodeURIComponent(id)}`),body=await res.json();if(!res.ok)throw new Error(body.error||'Could not load booking');const b=body.booking,answers=Object.entries(b.extra_answers||{}).map(([key,value])=>`<div class="row"><div class="k">${esc(key.replaceAll('_',' '))}</div><div class="v">${esc(value)}</div></div>`).join('');openDrawer(`Booking ${id}`,`<div class="kv"><div class="row"><div class="k">Customer</div><div class="v">${esc(b.customer_name||'—')}</div></div><div class="row"><div class="k">Phone</div><div class="v">${esc(b.customer_phone||b.contact_phone||'—')}</div></div><div class="row"><div class="k">Appointment</div><div class="v">${esc(fmtTime(b.appointment_at))} · ${esc(b.time_zone||'')}</div></div><div class="row"><div class="k">Address</div><div class="v">${esc(b.service_address||'—')}</div></div><div class="row"><div class="k">Status</div><div class="v">${esc(b.status)}</div></div>${answers}</div><div class="compose-actions"><span id="booking-action-error" class="login-error"></span><button class="btn ghost" id="booking-open-thread">Open conversation</button>${b.status==='confirmed'?'<button class="btn danger" id="booking-cancel">Cancel booking</button>':''}</div>`);el.drawerBody.querySelector('#booking-open-thread')?.addEventListener('click',()=>{state.view='messaging';state.conversationPhone=b.customer_phone||b.contact_phone;closeDrawer();setActiveNav();load();});el.drawerBody.querySelector('#booking-cancel')?.addEventListener('click',async event=>{if(!confirm('Cancel this booking and its pending reminders?'))return;event.currentTarget.disabled=true;const cancel=await apiFetch(`/api/bookings/${encodeURIComponent(id)}/cancel`,{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:'{}'}),result=await cancel.json();if(!cancel.ok){el.drawerBody.querySelector('#booking-action-error').textContent=result.error||'Cancellation failed';event.currentTarget.disabled=false;return;}closeDrawer();await renderBookings();});}));
}

async function fetchOnboarding() {
  const merged = { onboarding: {}, onboardingComplete: false, source: 'api' };
  try {
    const response = await apiFetch('/api/onboarding');
    if (response.ok) {
      const data = await response.json();
      merged.onboarding = data.onboarding || {};
      merged.onboardingComplete = Boolean(data.onboardingComplete);
      if (merged.onboardingComplete) {
        try { localStorage.removeItem(onboardingStorageKey()); } catch { /* noop */ }
      }
      return merged;
    }
    if (![404, 501, 502, 503].includes(response.status)) return merged;
  } catch {
    // Disconnected preview or undeployed route: fall through to the device copy.
  }
  const local = readLocalOnboarding();
  if (local) {
    merged.onboarding = local;
    merged.onboardingComplete = Boolean(local.completedAt);
    merged.source = 'local';
  }
  return merged;
}

async function saveOnboarding(payload) {
  try {
    const response = await apiFetch('/api/onboarding', { method: 'POST', body: JSON.stringify(payload) });
    if (response.ok) {
      try { localStorage.removeItem(onboardingStorageKey()); } catch { /* noop */ }
      return { data: await response.json(), source: 'api' };
    }
    const data = await response.json().catch(() => ({}));
    if (![404, 501, 502, 503].includes(response.status)) {
      throw new Error(data.error || data.detail || 'Could not save business context');
    }
  } catch (error) {
    if (error?.message && !/fetch|network|failed/i.test(error.message)) throw error;
  }
  const local = { ...payload, completedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
  writeLocalOnboarding(local);
  return { data: { onboarding: local, onboardingComplete: true }, source: 'local' };
}

function setupStepsHtml(current = 1) {
  const steps = ['Details', 'Twilio review', 'Approved'];
  return `<ol class="setup-steps" aria-label="Setup progress">${steps
    .map((label, i) => {
      const n = i + 1;
      const cls = n < current ? 'done' : n === current ? 'current' : '';
      return `<li class="${cls}"><span class="setup-step-n">${n}</span><span>${esc(label)}</span></li>`;
    })
    .join('')}</ol>`;
}

function sampleFieldsHtml(samples) {
  const list = samples.length ? samples : ['', ''];
  return list
    .map(
      (value, i) => `
      <div class="setup-sample" data-sample-row>
        <div class="setup-sample-head">
          <label class="compose-label" for="setup-sample-${i}">Sample ${i + 1} *</label>
          <span class="setup-count" data-count-for="setup-sample-${i}">${String(value || '').trim().length}/320</span>
        </div>
        <textarea id="setup-sample-${i}" data-sample-input rows="3" minlength="20" maxlength="320" required placeholder="Thanks for contacting Example Business. Reply STOP to opt out.">${esc(value || '')}</textarea>
        <div class="setup-sample-foot">
          <span class="muted" data-hint-for="setup-sample-${i}">20–320 characters. Include STOP/HELP wording.</span>
          ${list.length > 2 ? `<button type="button" class="btn ghost setup-sample-remove" data-remove-sample="${i}">Remove</button>` : ''}
        </div>
      </div>`
    )
    .join('');
}

function registrationControlsHtml(registration = {}, detailsComplete = false) {
  const registrationState = registration.state || 'draft';
  const button = (action, label) => `<button type="button" class="btn" data-registration-action="${action}">${label}</button>`;
  let action = '';
  if (!detailsComplete) action = '<p class="muted">Save the registration details first.</p>';
  else if (registrationState === 'draft') action = button('start', 'Start registration');
  else if (registrationState === 'profile_pending') action = button('session-brand-new', 'Open secure brand form');
  else if (registrationState === 'brand_pending') action = `${registration.brand_inquiry_id ? button('session-brand-resume', 'Resume brand form') : ''}${button('refresh', 'Check brand status')}`;
  else if (registrationState === 'campaign_pending') action = `${button(`session-campaign-${registration.campaign_inquiry_id ? 'resume' : 'new'}`, registration.campaign_inquiry_id ? 'Resume campaign form' : 'Open secure campaign form')}${registration.campaign_inquiry_id ? button('refresh', 'Check campaign status') : ''}`;
  else if (registrationState === 'number_pending') action = `<label><span class="compose-label">Area code</span><input id="registration-area-code" inputmode="numeric" maxlength="3" placeholder="720" /></label>${button('search-number', 'Find available numbers')}`;
  else if (registrationState === 'verification_pending') action = registration.sender_type === 'toll_free' ? button('session-toll_free-new', 'Open toll-free verification') : button('refresh', 'Check approval');
  else if (['in_review', 'approved', 'canary_pending'].includes(registrationState)) action = button('refresh', 'Refresh Twilio status');
  else if (registrationState === 'webhook_verified') action = `<label><span class="compose-label">Canary recipient</span><input id="registration-canary-phone" type="tel" placeholder="+15551234567" /></label>${button('canary', 'Send activation canary')}`;
  else if (registrationState === 'ready') action = button('activate', 'Enable sending');
  else if (registrationState === 'submission_unknown') action = button('reconcile', 'Reconcile uncertain operation');
  else if (registrationState === 'rejected') action = button(`session-${registration.sender_type === 'toll_free' ? 'toll_free' : registration.campaign_inquiry_id ? 'campaign' : 'brand'}-resubmit`, 'Correct and resubmit');
  return `<div class="card setup-card"><div class="card-head"><div><span class="eyebrow">Live registration</span><h2>${esc(registrationState.replaceAll('_', ' '))}</h2></div></div><div class="setup-body"><p class="muted">Paid submissions and number purchases always ask for confirmation. Legal answers stay in Twilio's secure form.</p><div class="compose-actions" style="align-items:stretch;flex-direction:column">${action}<span id="registration-action-error" class="login-error"></span></div>${registration.rejection_reason ? `<p class="login-error">${esc(registration.rejection_reason)}</p>` : ''}</div></div>`;
}

async function renderBusinessSetup() {
  setTitle(...titles['business-setup']);
  el.kpi.innerHTML = '';
  el.pager.hidden = true;
  el.storeMeta.textContent = state.tenant?.name || 'Your workspace';

  let provisioning = state.setupProvisioning || null;
  let onboardingState = state.setupOnboarding || null;
  let registration = state.setupRegistration || null;
  if (!provisioning || !onboardingState || !registration) {
    el.root.innerHTML = '<div class="card"><div class="empty">Loading business setup…</div></div>';
    try {
      const [provRes, onb, regRes] = await Promise.all([
        provisioning ? null : apiFetch('/api/provisioning'),
        onboardingState ? null : fetchOnboarding(),
        registration ? null : apiFetch('/api/twilio/registration'),
      ]);
      if (provRes && provRes.ok) provisioning = await provRes.json();
      if (onb) onboardingState = onb;
      if (regRes && regRes.ok) registration = await regRes.json();
    } catch (error) {
      console.error(error);
    }
  }
  state.setupProvisioning = provisioning;
  state.setupOnboarding = onboardingState || { onboarding: {}, onboardingComplete: false };
  state.setupRegistration = registration || { state: 'draft' };
  const details = provisioning?.details || {};
  const senderType = details.senderType || 'local_a2p';
  const brandType = details.brandType || 'standard';
  const samples = Array.isArray(details.sampleMessages) && details.sampleMessages.length
    ? details.sampleMessages.slice(0, 5)
    : ['', ''];
  const stateLabel = String(provisioning?.state || 'pending').replaceAll('_', ' ');
  const sendingEnabled = Boolean(provisioning?.sendingEnabled);

  el.root.innerHTML = `
    <div class="setup-page">
      <div class="setup-topbar">
        <button type="button" class="btn ghost" id="setup-back">← Back to dashboard</button>
        <span class="setup-status ${sendingEnabled ? 'ok' : ''}">${esc(sendingEnabled ? 'Sending enabled' : 'Sending disabled until Twilio approval')}</span>
      </div>
      <div class="card setup-hero">
        <div>
          <span class="eyebrow">Twilio registration · ${esc(state.tenant?.name || 'Business account')}</span>
          <h2>Complete business setup</h2>
          <p class="muted">Provide the information needed to choose a phone number and prepare the applicable Twilio registration. Legal identity and tax information are entered later in Twilio's secure form — this CRM does not store that here. Business context for SMS and AI lives on its own page under Setup → Business context.</p>
          ${setupStepsHtml(provisioning?.detailsComplete ? 2 : 1)}
        </div>
        <dl class="setup-facts">
          <div><dt>Status</dt><dd>${esc(stateLabel)}</dd></div>
          <div><dt>Details</dt><dd>${provisioning?.detailsComplete ? 'saved · registration submission is next' : 'required'}</dd></div>
          ${provisioning?.phoneNumber ? `<div><dt>Number</dt><dd>${esc(provisioning.phoneNumber)}</dd></div>` : ''}
        </dl>
      </div>
      <form id="business-setup-page-form" class="setup-layout">
        <div class="setup-main">
          <section class="card setup-card" aria-labelledby="setup-sender-h">
            <div class="card-head"><div><span class="eyebrow">Step 1</span><h2 id="setup-sender-h">Phone number</h2></div><span class="muted">Choose once per business</span></div>
            <div class="setup-body">
              <div class="setup-radio-grid" role="radiogroup" aria-label="Phone number type">
                <label class="setup-radio ${senderType === 'local_a2p' ? 'selected' : ''}">
                  <input type="radio" name="senderType" value="local_a2p" ${senderType === 'local_a2p' ? 'checked' : ''} />
                  <strong>US local number</strong>
                  <span>A2P 10DLC registration. Best for local presence. Requires brand type + area code.</span>
                </label>
                <label class="setup-radio ${senderType === 'toll_free' ? 'selected' : ''}">
                  <input type="radio" name="senderType" value="toll_free" ${senderType === 'toll_free' ? 'checked' : ''} />
                  <strong>US toll-free number</strong>
                  <span>Toll-free verification. No area code needed.</span>
                </label>
              </div>
              <div id="setup-local-fields" class="setup-grid-2">
                <label>
                  <span class="compose-label">Business registration type *</span>
                  <select id="setup-brand-type">
                    <option value="standard" ${brandType !== 'sole_proprietor' ? 'selected' : ''}>Registered business with EIN</option>
                    <option value="sole_proprietor" ${brandType === 'sole_proprietor' ? 'selected' : ''}>Sole proprietor (no EIN)</option>
                  </select>
                  <small class="muted">Sole proprietors get a separate low-volume path. Choose EIN when available.</small>
                </label>
                <label>
                  <span class="compose-label">Preferred area code *</span>
                  <input id="setup-area-code" inputmode="numeric" maxlength="3" minlength="3" pattern="[0-9]{3}" value="${esc(details.areaCode || '')}" placeholder="720" autocomplete="off" />
                  <small class="muted">Exactly 3 digits. Used when searching for a local number. Not needed for toll-free.</small>
                </label>
              </div>
            </div>
          </section>
          <section class="card setup-card" aria-labelledby="setup-identity-h">
            <div class="card-head"><div><span class="eyebrow">Step 2</span><h2 id="setup-identity-h">Business identity</h2></div><span class="muted">Must match public records</span></div>
            <div class="setup-body setup-grid-2">
              <label class="field-wide">
                <span class="compose-label">Legal business name *</span>
                <input id="setup-legal-name" maxlength="160" required value="${esc(details.legalBusinessName || state.tenant?.name || '')}" autocomplete="organization" placeholder="Bello Moving LLC" />
              </label>
              <label>
                <span class="compose-label">Registration notification email *</span>
                <input id="setup-email" type="email" maxlength="320" required value="${esc(details.notificationEmail || getSession()?.user?.email || '')}" autocomplete="email" placeholder="owner@example.com" />
              </label>
              <label>
                <span class="compose-label">Public website *</span>
                <input id="setup-website" type="url" inputmode="url" maxlength="2048" required pattern="https://.*" value="${esc(details.websiteUrl || '')}" placeholder="https://example.com" />
                <small class="muted">Must start with https:// and be publicly accessible. Twilio reviews this site.</small>
              </label>
            </div>
          </section>
          <section class="card setup-card" aria-labelledby="setup-use-h">
            <div class="card-head"><div><span class="eyebrow">Step 3</span><h2 id="setup-use-h">Messaging use case</h2></div><span class="muted">Twilio requires 40+ characters each</span></div>
            <div class="setup-body">
              <label>
                <span class="compose-label">How will this business use SMS? *</span>
                <textarea id="setup-campaign" minlength="40" maxlength="1500" rows="4" required placeholder="Describe the messages customers will receive and why.">${esc(details.campaignDescription || '')}</textarea>
                <small class="muted"><span data-count-for="setup-campaign">${String(details.campaignDescription || '').trim().length}/1500</span> · minimum 40 characters.</small>
              </label>
              <label>
                <span class="compose-label">How do customers agree to receive messages? *</span>
                <textarea id="setup-opt-in" minlength="40" maxlength="1500" rows="4" required placeholder="Describe the form, checkbox, keyword, or verbal workflow used to collect consent.">${esc(details.optInDescription || '')}</textarea>
                <small class="muted"><span data-count-for="setup-opt-in">${String(details.optInDescription || '').trim().length}/1500</span> · minimum 40 characters.</small>
              </label>
              <div>
                <div class="setup-samples-head">
                  <span class="compose-label">Sample messages * · 2–5 required</span>
                  <button type="button" class="btn ghost" id="setup-add-sample" ${samples.length >= 5 ? 'disabled' : ''}>Add sample</button>
                </div>
                <div id="setup-samples" class="setup-samples">${sampleFieldsHtml(samples)}</div>
              </div>
            </div>
          </section>
        </div>
        <aside class="setup-side">
          ${registrationControlsHtml(state.setupRegistration, Boolean(provisioning?.detailsComplete))}
          <div class="card setup-card setup-help">
            <div class="card-head"><h2>What happens next</h2></div>
            <ol class="setup-help-list">
              <li>We save this draft and pick a phone number for the subaccount.</li>
              <li>You complete Twilio's secure brand + campaign registration.</li>
              <li>Sending unlocks automatically after Twilio approval.</li>
            </ol>
            <div class="card-head" style="border-top:1px solid var(--border)"><h2>Required for approval</h2></div>
            <ul class="setup-help-list">
              <li>Sender: local A2P 10DLC or toll-free.</li>
              <li>Brand type + 3-digit area code (local only).</li>
              <li>Legal name, notification email, public https:// website.</li>
              <li>Use case + consent answers, 40+ characters each.</li>
              <li>2–5 samples, 20–320 chars each, with STOP/HELP wording.</li>
            </ul>
            <p class="muted">Keep descriptions specific: who gets messages, what triggers them, and exactly where consent is collected. Vague answers are the most common Twilio rejection. EIN and address are collected later in Twilio's secure form.</p>
          </div>
          <div class="card setup-card setup-actions">
            <span id="setup-error" class="login-error" role="alert"></span>
            <button type="submit" class="btn" id="setup-save">Save setup details</button>
            <button type="button" class="btn ghost" id="setup-cancel">Cancel</button>
          </div>
        </aside>
      </form>
    </div>`;

  const form = el.root.querySelector('#business-setup-page-form');
  const error = form.querySelector('#setup-error');
  const saveButton = form.querySelector('#setup-save');
  const radios = [...form.querySelectorAll('input[name="senderType"]')];
  const localFields = form.querySelector('#setup-local-fields');
  const brand = form.querySelector('#setup-brand-type');
  const area = form.querySelector('#setup-area-code');
  const campaign = form.querySelector('#setup-campaign');
  const optIn = form.querySelector('#setup-opt-in');
  const samplesWrap = form.querySelector('#setup-samples');
  const addSample = form.querySelector('#setup-add-sample');

  const reloadRegistration = async () => {
    state.setupRegistration = null;
    await renderBusinessSetup();
  };
  el.root.querySelectorAll('[data-registration-action]').forEach((button) => button.addEventListener('click', async () => {
    const action = button.dataset.registrationAction;
    const feedback = el.root.querySelector('#registration-action-error');
    feedback.textContent = '';
    button.disabled = true;
    try {
      if (action === 'start') {
        const response = await apiFetch('/api/twilio/registration/start', { method: 'POST', body: JSON.stringify({ senderType, country: 'US' }) });
        const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not start registration');
        return reloadRegistration();
      }
      if (action === 'refresh' || action === 'reconcile') {
        const response = await apiFetch(`/api/twilio/${action === 'refresh' ? 'status-refresh' : 'reconcile'}`, { method: 'POST', body: '{}' });
        const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not refresh registration');
        return reloadRegistration();
      }
      if (action === 'activate') {
        const response = await apiFetch('/api/twilio/activate', { method: 'POST', body: '{}' });
        const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Activation is not ready');
        return reloadRegistration();
      }
      if (action === 'canary') {
        const phone = el.root.querySelector('#registration-canary-phone')?.value.trim();
        if (!/^\+[1-9]\d{7,14}$/.test(phone || '')) throw new Error('Enter a canary recipient in E.164 format.');
        if (!confirm('Send one billable activation test SMS to this number?')) return;
        const response = await apiFetch('/api/twilio/canary', { method: 'POST', body: JSON.stringify({ phone, confirmed: true }) });
        const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Could not queue the canary');
        return reloadRegistration();
      }
      if (action === 'search-number') {
        const areaCode = el.root.querySelector('#registration-area-code')?.value.trim();
        const response = await apiFetch('/api/twilio/number-search', { method: 'POST', body: JSON.stringify({ areaCode }) });
        const body = await response.json(); if (!response.ok) throw new Error(body.error || 'Number search failed');
        openDrawer('Choose a Twilio number', `<div class="compose">${(body.numbers || []).map((number) => `<button type="button" class="btn ghost" data-purchase-number="${esc(number.phoneNumber)}">${esc(number.friendlyName || number.phoneNumber)} ${esc([number.locality, number.region].filter(Boolean).join(', '))}</button>`).join('') || '<p class="empty">No matching numbers are available.</p>'}<span id="purchase-number-error" class="login-error"></span></div>`);
        el.drawerBody.querySelectorAll('[data-purchase-number]').forEach((choice) => choice.addEventListener('click', async () => {
          if (!confirm(`Purchase ${choice.dataset.purchaseNumber}? This creates recurring Twilio charges.`)) return;
          choice.disabled = true;
          const purchase = await apiFetch('/api/twilio/paid-action', { method: 'POST', body: JSON.stringify({ confirmed: true, operation: 'purchase_number', selection: { phoneNumber: choice.dataset.purchaseNumber }, idempotencyKey: `purchase:${choice.dataset.purchaseNumber}` }) });
          const result = await purchase.json();
          if (!purchase.ok) { el.drawerBody.querySelector('#purchase-number-error').textContent = result.error || 'Purchase could not be queued'; choice.disabled = false; return; }
          closeDrawer(); await reloadRegistration();
        }));
        return;
      }
      if (action.startsWith('session-')) {
        const [, stage, sessionAction] = action.split('-');
        if (['new', 'resubmit'].includes(sessionAction) && !confirm('Continue to Twilio’s secure form? Submission may create registration charges.')) return;
        if (['new', 'resubmit'].includes(sessionAction)) {
          const charge = await apiFetch('/api/twilio/paid-action', { method: 'POST', body: JSON.stringify({ confirmed: true, operation: 'submit_registration', idempotencyKey: `registration:${stage}:${Date.now()}` }) });
          const result = await charge.json(); if (!charge.ok) throw new Error(result.error || 'Charge confirmation failed');
        }
        const response = await apiFetch('/api/twilio/registration-session', { method: 'POST', body: JSON.stringify({ stage, action: sessionAction }) });
        const session = await response.json(); if (!response.ok) throw new Error(session.error || 'Could not open Twilio registration');
        await import('/vendor/compliance-embed.js');
        globalThis.openTwilioComplianceEmbed({ inquiryId: session.inquiryId, sessionToken: session.sessionToken, onSubmitted: async () => { await apiFetch('/api/twilio/status-refresh', { method: 'POST', body: '{}' }); }, onClose: reloadRegistration });
      }
    } catch (error) {
      feedback.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  }));

  const syncSender = () => {
    const value = form.querySelector('input[name="senderType"]:checked')?.value || 'local_a2p';
    const local = value === 'local_a2p';
    localFields.hidden = !local;
    localFields.style.display = local ? '' : 'none';
    brand.required = local;
    area.required = local;
    form.querySelectorAll('.setup-radio').forEach((node) => {
      node.classList.toggle('selected', node.querySelector('input')?.checked);
    });
  };
  radios.forEach((r) => r.addEventListener('change', syncSender));
  syncSender();

  const bindCounter = (input) => {
    const counter = form.querySelector(`[data-count-for="${input.id}"]`);
    if (!counter || !input) return;
    const update = () => {
      counter.textContent = `${input.value.trim().length}/${input.maxLength > 0 ? input.maxLength : 1500}`;
    };
    input.addEventListener('input', update);
    update();
  };
  bindCounter(campaign);
  bindCounter(optIn);
  samplesWrap.querySelectorAll('[data-sample-input]').forEach(bindCounter);

  const refreshSamples = () => {
    const rows = [...samplesWrap.querySelectorAll('[data-sample-row]')];
    rows.forEach((row, i) => {
      row.querySelector('.compose-label').textContent = `Sample ${i + 1}`;
      row.querySelector('.compose-label').setAttribute('for', `setup-sample-${i}`);
      const input = row.querySelector('[data-sample-input]');
      input.id = `setup-sample-${i}`;
      const count = row.querySelector('[data-count-for]');
      if (count) count.setAttribute('data-count-for', input.id);
    });
    addSample.disabled = rows.length >= 5;
    samplesWrap.querySelectorAll('[data-remove-sample]').forEach((btn) => {
      btn.disabled = rows.length <= 2;
    });
  };
  refreshSamples();

  addSample.addEventListener('click', () => {
    const rows = [...samplesWrap.querySelectorAll('[data-sample-row]')];
    if (rows.length >= 5) return;
    const div = document.createElement('div');
    div.className = 'setup-sample';
    div.setAttribute('data-sample-row', '');
    div.innerHTML = `
      <div class="setup-sample-head">
        <label class="compose-label" for="setup-sample-new">Sample ${rows.length + 1} *</label>
        <span class="setup-count" data-count-for="setup-sample-new">0/320</span>
      </div>
      <textarea data-sample-input rows="3" minlength="20" maxlength="320" required placeholder="Your appointment is confirmed for tomorrow. Reply HELP for help."></textarea>
      <div class="setup-sample-foot"><span class="muted">20–320 characters. Include STOP/HELP wording.</span><button type="button" class="btn ghost setup-sample-remove">Remove</button></div>`;
    samplesWrap.appendChild(div);
    const input = div.querySelector('[data-sample-input]');
    bindCounter(input);
    refreshSamples();
    input.focus();
  });
  samplesWrap.addEventListener('click', (event) => {
    const btn = event.target.closest('[data-remove-sample], .setup-sample-remove');
    if (!btn) return;
    const rows = [...samplesWrap.querySelectorAll('[data-sample-row]')];
    if (rows.length <= 2) return;
    btn.closest('[data-sample-row]')?.remove();
    refreshSamples();
  });
  samplesWrap.addEventListener('input', (event) => {
    const input = event.target.closest?.('[data-sample-input]');
    if (!input) return;
    const row = input.closest('[data-sample-row]');
    const counter = row?.querySelector('[data-count-for]');
    if (counter) counter.textContent = `${input.value.trim().length}/320`;
  });

  const goOverview = () => {
    state.view = 'overview';
    state.page = 1;
    setActiveNav();
    load();
  };
  el.root.querySelector('#setup-back')?.addEventListener('click', goOverview);
  el.root.querySelector('#setup-cancel')?.addEventListener('click', goOverview);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const sender = form.querySelector('input[name="senderType"]:checked')?.value || 'local_a2p';
    const legalName = form.querySelector('#setup-legal-name').value.trim();
    const notifyEmail = form.querySelector('#setup-email').value.trim();
    const website = form.querySelector('#setup-website').value.trim();
    const campaignText = campaign.value.trim();
    const optInText = optIn.value.trim();
    const sampleMessages = [...samplesWrap.querySelectorAll('[data-sample-input]')].map((n) => n.value.trim()).filter(Boolean);
    const fail = (message, node) => {
      error.textContent = message;
      saveButton.disabled = false;
      (node || error).scrollIntoView?.({ block: 'nearest' });
      node?.focus?.();
    };
    error.textContent = '';
    saveButton.disabled = true;
    if (!legalName) return fail('Legal business name is required — use the exact registered name.', form.querySelector('#setup-legal-name'));
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(notifyEmail)) return fail('Valid notification email is required — Twilio status goes here.', form.querySelector('#setup-email'));
    if (!/^https:\/\/\S+/.test(website)) return fail('A public HTTPS website is required (must start with https://).', form.querySelector('#setup-website'));
    if (sender === 'local_a2p' && !/^[0-9]{3}$/.test(area.value.trim())) return fail('A three-digit area code is required for a local number.', area);
    if (campaignText.length < 40 || campaignText.length > 1500) return fail('Campaign description must be 40–1500 characters — describe who gets messages and why.', campaign);
    if (optInText.length < 40 || optInText.length > 1500) return fail('Opt-in description must be 40–1500 characters — describe the exact consent workflow.', optIn);
    if (sampleMessages.length < 2 || sampleMessages.length > 5) return fail('Provide 2–5 sample messages.', samplesWrap.querySelector('[data-sample-input]'));
    const badSample = sampleMessages.findIndex((s) => s.length < 20 || s.length > 320);
    if (badSample >= 0) return fail(`Sample ${badSample + 1} must be 20–320 characters.`, samplesWrap.querySelectorAll('[data-sample-input]')[badSample]);
    try {
      if (!form.reportValidity()) {
        saveButton.disabled = false;
        return;
      }
      const response = await apiFetch('/api/provisioning/details', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
        senderType: sender, brandType: brand.value, areaCode: area.value.trim(),
        legalBusinessName: legalName, notificationEmail: notifyEmail, websiteUrl: website,
        campaignDescription: campaignText, optInDescription: optInText, sampleMessages,
      }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || data.detail || 'Could not save setup details');
      state.setupProvisioning = data;
      state.view = 'overview';
      setActiveNav();
      await load();
    } catch (failure) {
      error.textContent = failure.message;
      saveButton.disabled = false;
      error.scrollIntoView({ block: 'nearest' });
    }
  });
}

function onboardingDefaults(provisioning) {
  const twilio = provisioning?.details || {};
  const saved = state.setupOnboarding?.onboarding || {};
  const splitLines = (value) => String(value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const asLines = (value) => Array.isArray(value) ? value.filter(Boolean) : splitLines(value);
  const services = asLines(saved.services);
  const locations = asLines(saved.locations);
  const faqs = asLines(saved.faqs);
  const pricing = asLines(saved.pricing),policies=asLines(saved.policies);
  const defaults = {
    businessName: saved.businessName || twilio.legalBusinessName || state.tenant?.name || '',
    websiteUrl: saved.websiteUrl || twilio.websiteUrl || '',
    summary: saved.summary || '',
    servicesText: services.join('\n'),
    locationsText: locations.length ? locations.join('\n') : (saved.businessName || twilio.legalBusinessName ? '' : 'United States'),
    hours: saved.hours || '',
    contactPhone: saved.contactPhone || '',
    contactEmail: saved.contactEmail || twilio.notificationEmail || '',
    tone: saved.tone || '',
    faqsText: faqs.join('\n'),
    pricingText: pricing.join('\n'),
    policiesText: policies.join('\n'),
    bookingRules: saved.bookingRules || '',
    handoff: saved.handoff || '',
  };
  return state.businessContextDraft ? { ...defaults, ...state.businessContextDraft } : defaults;
}

async function renderBusinessContext() {
  setTitle(...titles['business-context']);
  el.kpi.innerHTML = '';
  el.pager.hidden = true;
  el.storeMeta.textContent = state.tenant?.name || 'Your workspace';

  const cachedOnboarding = state.setupOnboarding || null;
  let provisioning = state.setupProvisioning || null;
  // Always refetch server truth when opening this view: a cached copy from an
  // earlier save (or another device) must never masquerade as what is stored.
  if (!cachedOnboarding || !provisioning) {
    el.root.innerHTML = '<div class="card"><div class="empty">Loading business context…</div></div>';
  }
  try {
    const [onb, provRes] = await Promise.all([
      fetchOnboarding(),
      provisioning ? null : apiFetch('/api/provisioning'),
    ]);
    // Never let an empty/failed response or a device-only fallback clobber a
    // known-good server copy. An api result is trusted when it carries data;
    // a device copy is used only when there is nothing cached yet.
    const apiHasData = onb && onb.source === 'api' &&
      (onb.onboardingComplete || Object.keys(onb.onboarding || {}).length > 0);
    if (onb && (apiHasData || (!cachedOnboarding && onb.source !== 'api'))) state.setupOnboarding = onb;
    if (provRes && provRes.ok) provisioning = await provRes.json();
  } catch (error) {
    console.error(error);
  }
  const onboardingState = state.setupOnboarding || { onboarding: {}, onboardingComplete: false };
  state.setupOnboarding = onboardingState;
  state.setupProvisioning = provisioning;
  const defaults = onboardingDefaults(provisioning);
  const localNote = state.setupOnboarding.source === 'local';
  el.root.innerHTML = `
    <div class="setup-page">
      <div class="setup-topbar">
        <button type="button" class="btn ghost" id="setup-back">← Back to dashboard</button>
        <span class="setup-status ${state.setupOnboarding.onboardingComplete && !localNote ? 'ok' : ''}">${esc(localNote ? 'Saved on this device only — not synced' : state.setupOnboarding.onboardingComplete ? 'Context saved' : 'Context required for smarter SMS + AI')}</span>
      </div>
      <div class="card setup-hero">
        <div>
          <span class="eyebrow">Business context · ${esc(state.tenant?.name || 'Business account')}</span>
          <h2>Help SMS and AI sound like you.</h2>
          <p class="muted">Separate from the Twilio registration — nothing here is sent to Twilio. This context powers smarter follow-ups and AI replies: what you sell, where, when you're open, and how you want to sound.</p>
        </div>
        <dl class="setup-facts">
          <div><dt>Business context</dt><dd>${state.setupOnboarding.onboardingComplete ? 'saved' : 'required'}</dd></div>
          ${state.setupOnboarding.onboarding?.updatedAt ? `<div><dt>Updated</dt><dd>${esc(fmtTime(state.setupOnboarding.onboarding.updatedAt))}</dd></div>` : ''}
        </dl>
      </div>
      <form id="business-context-form" class="setup-layout">
        <div class="setup-main">
          <section class="card setup-card" aria-labelledby="ctx-fetch-h">
            <div class="card-head"><div><span class="eyebrow">Start from the website</span><h2 id="ctx-fetch-h">Fetch business details</h2></div><span class="muted">Same reader as Get Started</span></div>
            <div class="setup-body">
              <div class="setup-fetch-row">
                <label class="setup-fetch-url">
                  <span class="compose-label">Website to read</span>
                  <input id="ctx-fetch-url" type="text" inputmode="url" maxlength="2048" value="${esc(defaults.fetchUrl || defaults.websiteUrl)}" placeholder="yourbusiness.com" autocomplete="off" />
                </label>
                <button type="button" class="btn" id="ctx-fetch">Fetch details</button>
              </div>
              <p class="muted" style="margin:0" id="ctx-fetch-note">Reads the public homepage and prefills the form below. Review everything before saving — fetched text is a draft, not the truth.</p>
            </div>
          </section>
          <section class="card setup-card" aria-labelledby="ctx-business-h">
            <div class="card-head"><div><span class="eyebrow">Basics · Get Started step 1</span><h2 id="ctx-business-h">Business identity</h2></div><span class="muted">Prefilled where possible</span></div>
            <div class="setup-body setup-grid-2">
              <label>
                <span class="compose-label">Your business name *</span>
                <input id="ctx-name" maxlength="120" required value="${esc(defaults.businessName)}" placeholder="Business name" autocomplete="organization" />
              </label>
              <label>
                <span class="compose-label">Website <span class="muted">Optional</span></span>
                <input id="ctx-website" type="url" inputmode="url" maxlength="2048" pattern="https://.*" value="${esc(defaults.websiteUrl)}" placeholder="yourbusiness.com" autocomplete="off" />
                <small class="muted">Public site, starting with https://.</small>
              </label>
              <label class="field-wide">
                <span class="compose-label">What does this business do? <span class="muted">Optional · 20+ characters</span></span>
                <textarea id="ctx-summary" maxlength="2000" rows="3" placeholder="Two or three sentences: what you do and who you serve.">${esc(defaults.summary)}</textarea>
                <small class="muted"><span data-count-for="ctx-summary">${defaults.summary.trim().length}/2000</span> · shown to AI before every reply.</small>
              </label>
              <label class="field-wide">
                <span class="compose-label">Services you sell *</span>
                <textarea id="ctx-services" rows="4" required placeholder="One service per line">${esc(defaults.servicesText)}</textarea>
                <small class="muted"><span data-count-for="ctx-services">${defaults.servicesText.split('\n').filter(Boolean).length} services</span> · 1–30 services, one per line, 160 characters max each.</small>
              </label>
              <label class="field-wide">
                <span class="compose-label">Service areas *</span>
                <textarea id="ctx-areas" rows="3" required placeholder="Cities, regions, or territories you serve">${esc(defaults.locationsText)}</textarea>
                <small class="muted"><span data-count-for="ctx-areas">${defaults.locationsText.split('\n').filter(Boolean).length} areas</span> · 1–20 areas, one per line, 160 characters max each.</small>
              </label>
            </div>
          </section>
          <section class="card setup-card" aria-labelledby="ctx-reach-h">
            <div class="card-head"><div><span class="eyebrow">Availability</span><h2 id="ctx-reach-h">When and how to reach you</h2></div><span class="muted">AI uses this in replies</span></div>
            <div class="setup-body setup-grid-2">
              <label>
                <span class="compose-label">Business hours</span>
                <input id="ctx-hours" maxlength="200" value="${esc(defaults.hours)}" placeholder="Mon–Fri 8am–6pm, Sat 9am–2pm" autocomplete="off" />
                <small class="muted">Free text — AI quotes it when customers ask if you're open.</small>
              </label>
              <label>
                <span class="compose-label">Main contact phone</span>
                <input id="ctx-phone" type="tel" maxlength="32" value="${esc(defaults.contactPhone)}" placeholder="+15551234567" autocomplete="tel" />
                <small class="muted">Offered when a customer asks to call.</small>
              </label>
              <label>
                <span class="compose-label">Main contact email</span>
                <input id="ctx-email" type="email" maxlength="320" value="${esc(defaults.contactEmail)}" placeholder="help@example.com" autocomplete="email" />
              </label>
            </div>
          </section>
          <section class="card setup-card" aria-labelledby="ctx-voice-h">
            <div class="card-head"><div><span class="eyebrow">AI voice</span><h2 id="ctx-voice-h">How should replies sound?</h2></div><span class="muted">Guides tone + handoff</span></div>
            <div class="setup-body">
              <label>
                <span class="compose-label">Brand voice</span>
                <select id="ctx-tone">
                  <option value="" ${!defaults.tone ? 'selected' : ''}>Default assistant voice</option>
                  <option value="friendly" ${defaults.tone === 'friendly' ? 'selected' : ''}>Friendly and helpful</option>
                  <option value="professional" ${defaults.tone === 'professional' ? 'selected' : ''}>Professional and direct</option>
                  <option value="casual" ${defaults.tone === 'casual' ? 'selected' : ''}>Warm and casual</option>
                </select>
              </label>
              <label>
                <span class="compose-label">Key facts for AI <span class="muted">Optional · one per line</span></span>
                <textarea id="ctx-faqs" rows="4" maxlength="8000" placeholder="Estimates are free within 20 miles.&#10;We book 2–3 days out in peak season.">${esc(defaults.faqsText)}</textarea>
                <small class="muted"><span data-count-for="ctx-faqs">${defaults.faqsText.split('\n').filter(Boolean).length} facts</span> · up to 20, 300 characters max each. Pricing, booking, policies.</small>
              </label>
              <label>
                <span class="compose-label">Pricing facts <span class="muted">Optional · one per line</span></span>
                <textarea id="ctx-pricing" rows="4" maxlength="20000" placeholder="Service call: $99&#10;After-hours surcharge: $25">${esc(defaults.pricingText)}</textarea>
                <small class="muted">Approved structured pricing outranks imported pages.</small>
              </label>
              <label>
                <span class="compose-label">Policies <span class="muted">Optional · one per line</span></span>
                <textarea id="ctx-policies" rows="4" maxlength="12000" placeholder="Cancellations are free with 24 hours notice.">${esc(defaults.policiesText)}</textarea>
              </label>
              <label>
                <span class="compose-label">Booking rules <span class="muted">AI captures requests but never confirms them</span></span>
                <textarea id="ctx-booking" maxlength="2000" rows="3" placeholder="Collect service, address, preferred date, and contact email. Staff must confirm availability.">${esc(defaults.bookingRules)}</textarea>
              </label>
              <label>
                <span class="compose-label">When should AI hand off to a human? <span class="muted">Optional</span></span>
                <textarea id="ctx-handoff" maxlength="1000" rows="3" placeholder="e.g. Angry customers, pricing disputes, or anything about refunds.">${esc(defaults.handoff)}</textarea>
              </label>
            </div>
          </section>
        </div>
        <aside class="setup-side">
          <div class="card setup-card setup-help">
            <div class="card-head"><h2>Why this helps</h2></div>
            <ol class="setup-help-list">
              <li>Follow-ups reference what you actually sell.</li>
              <li>AI answers hours, areas, and pricing from your facts.</li>
              <li>Handoff rules keep tricky conversations human.</li>
            </ol>
            <p class="muted">Identity fields are copied from the Get Started first step. Voice fields tune AI replies only — nothing here is sent to Twilio.</p>
          </div>
          <div class="card setup-card setup-actions">
            <span id="ctx-error" class="login-error" role="alert"></span>
            ${localNote ? '<p class="login-error" style="margin:0">Not synced — the server could not be reached, so this is stored only in this browser. Other devices and the live AI will NOT see it. Reconnect and save again to sync.</p>' : ''}
            <button type="submit" class="btn" id="ctx-save">Save business context</button>
            <button type="button" class="btn ghost" id="ctx-cancel">Cancel</button>
          </div>
        </aside>
      </form>
    </div>`;

  const form = el.root.querySelector('#business-context-form');
  const error = form.querySelector('#ctx-error');
  const saveButton = form.querySelector('#ctx-save');
  const nameInput = form.querySelector('#ctx-name');
  const websiteInput = form.querySelector('#ctx-website');
  const summaryInput = form.querySelector('#ctx-summary');
  const servicesInput = form.querySelector('#ctx-services');
  const areasInput = form.querySelector('#ctx-areas');
  const hoursInput = form.querySelector('#ctx-hours');
  const phoneInput = form.querySelector('#ctx-phone');
  const emailInput = form.querySelector('#ctx-email');
  const toneInput = form.querySelector('#ctx-tone');
  const faqsInput = form.querySelector('#ctx-faqs');
  const pricingInput=form.querySelector('#ctx-pricing'),policiesInput=form.querySelector('#ctx-policies'),bookingInput=form.querySelector('#ctx-booking');
  const handoffInput = form.querySelector('#ctx-handoff');
  if (state.businessContextDraft) form.dataset.dirty = 'true';

  const captureDraft = () => {
    state.businessContextDraft = {
      businessName: nameInput.value,
      websiteUrl: websiteInput.value,
      fetchUrl: form.querySelector('#ctx-fetch-url')?.value || '',
      summary: summaryInput.value,
      servicesText: servicesInput.value,
      locationsText: areasInput.value,
      hours: hoursInput.value,
      contactPhone: phoneInput.value,
      contactEmail: emailInput.value,
      tone: toneInput.value,
      faqsText: faqsInput.value,
      pricingText: pricingInput.value,
      policiesText: policiesInput.value,
      bookingRules: bookingInput.value,
      handoff: handoffInput.value,
    };
    form.dataset.dirty = 'true';
  };
  form.addEventListener('input', captureDraft);
  form.addEventListener('change', captureDraft);

  const goOverview = () => {
    state.businessContextDraft = null;
    state.view = 'overview';
    state.page = 1;
    setActiveNav();
    load();
  };
  el.root.querySelector('#setup-back')?.addEventListener('click', goOverview);
  el.root.querySelector('#ctx-cancel')?.addEventListener('click', goOverview);

  const lines = (value) => String(value || '').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  const bindCount = (input, format) => {
    const counter = form.querySelector(`[data-count-for="${input.id}"]`);
    if (!counter) return;
    const update = () => {
      counter.textContent = format(input.value);
    };
    input.addEventListener('input', update);
    update();
  };
  bindCount(summaryInput, (v) => `${v.trim().length}/2000`);
  bindCount(servicesInput, (v) => `${lines(v).length} services`);
  bindCount(areasInput, (v) => `${lines(v).length} areas`);
  bindCount(faqsInput, (v) => `${lines(v).length} facts`);

  const fetchUrlInput = form.querySelector('#ctx-fetch-url');
  const fetchButton = form.querySelector('#ctx-fetch');
  const fetchNote = form.querySelector('#ctx-fetch-note');
  const refreshCounts = () => {
    summaryInput.dispatchEvent(new Event('input'));
    servicesInput.dispatchEvent(new Event('input'));
    areasInput.dispatchEvent(new Event('input'));
    faqsInput.dispatchEvent(new Event('input'));
  };
  fetchButton?.addEventListener('click', async () => {
    const url = fetchUrlInput.value.trim() || websiteInput.value.trim();
    if (!url) {
      error.textContent = 'Enter a website address to fetch.';
      fetchUrlInput.focus();
      return;
    }
    const hasContent = [nameInput, summaryInput, servicesInput, areasInput, hoursInput, phoneInput, emailInput, faqsInput, pricingInput, policiesInput, bookingInput, handoffInput]
      .some((n) => n.value.trim());
    if (hasContent && !confirm('Replace the form contents with freshly fetched website details?')) return;
    error.textContent = '';
    fetchButton.disabled = true;
    const original = fetchButton.textContent;
    fetchButton.textContent = 'Fetching…';
    try {
      const payload = JSON.stringify({ websiteUrl: url });
      let response = await apiFetch('/api/enrich-website', { method: 'POST', body: payload });
      let data = await response.json().catch(() => ({}));
      if (response.status === 404 && runtimeConfig.apiBase) {
        // The deployed Edge API predates the new route — retry on the local preview server.
        try {
          const headers = { 'Content-Type': 'application/json' };
          const token = await getAccessToken();
          if (token) headers.Authorization = `Bearer ${token}`;
          const tenantId = getTenantId();
          if (tenantId) headers['X-Tenant-ID'] = tenantId;
          response = await fetch('/api/enrich-website', { method: 'POST', headers, body: payload });
          data = await response.json().catch(() => ({}));
        } catch {
          // Fall through to the not-deployed message below.
        }
      }
      if (response.status === 404) throw new Error('Website fetch is not deployed yet. Fill in the form manually for now.');
      if (!response.ok) throw new Error(data.error || 'That website could not be read. Check the address and try again.');
      if (data.businessName) nameInput.value = String(data.businessName).slice(0, 120);
      if (data.websiteUrl && !websiteInput.value.trim()) {
        websiteInput.value = String(data.websiteUrl);
        fetchUrlInput.value = String(data.websiteUrl);
      }
      if (data.summary) summaryInput.value = String(data.summary).slice(0, 2000);
      if (Array.isArray(data.services) && data.services.length) servicesInput.value = data.services.join('\n');
      if (Array.isArray(data.locations) && data.locations.length) areasInput.value = data.locations.join('\n');
      if (data.hours) hoursInput.value = String(data.hours).slice(0, 200);
      if (data.contactPhone) phoneInput.value = String(data.contactPhone).slice(0, 32);
      refreshCounts();
      captureDraft();
      const host = (() => { try { return new URL(data.websiteUrl || url).hostname; } catch { return url; } })();
      fetchNote.textContent = `Populated from ${host} — review every field and save. Fetched text is a draft, not the truth.`;
      nameInput.focus();
    } catch (failure) {
      error.textContent = failure.message;
    } finally {
      fetchButton.disabled = false;
      fetchButton.textContent = original;
    }
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const businessName = nameInput.value.trim();
    const websiteUrl = websiteInput.value.trim();
    const summary = summaryInput.value.trim();
    const services = lines(servicesInput.value);
    const locations = lines(areasInput.value);
    const hours = hoursInput.value.trim();
    const contactPhone = phoneInput.value.trim();
    const contactEmail = emailInput.value.trim();
    const tone = toneInput.value;
    const faqs = lines(faqsInput.value);
    const pricing=lines(pricingInput.value),policies=lines(policiesInput.value),bookingRules=bookingInput.value.trim();
    const handoff = handoffInput.value.trim();
    const fail = (message, node) => {
      error.textContent = message;
      saveButton.disabled = false;
      node?.focus?.();
    };
    error.textContent = '';
    saveButton.disabled = true;
    if (!businessName) return fail('Business name is required.', nameInput);
    if (websiteUrl && !/^https:\/\/\S+/.test(websiteUrl)) return fail('Website must start with https:// — or leave it blank.', websiteInput);
    if (summary && (summary.length < 20 || summary.length > 2000)) return fail('Summary must be 20–2000 characters — or leave it blank.', summaryInput);
    if (!services.length || services.length > 30 || services.some((s) => s.length > 160)) {
      return fail('Add 1–30 services, one per line, with no more than 160 characters per service.', servicesInput);
    }
    if (!locations.length || locations.length > 20 || locations.some((s) => s.length > 160)) {
      return fail('Add 1–20 service areas, one per line, with no more than 160 characters per area.', areasInput);
    }
    if (hours.length > 200) return fail('Hours must be 200 characters or fewer.', hoursInput);
    if (contactPhone.length > 32) return fail('Contact phone must be 32 characters or fewer.', phoneInput);
    if (contactEmail && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(contactEmail)) return fail('Enter a valid contact email.', emailInput);
    if (tone && !['friendly', 'professional', 'casual'].includes(tone)) return fail('Choose a brand voice.', toneInput);
    if (faqs.length > 20 || faqs.some((s) => s.length > 300)) {
      return fail('Add up to 20 FAQs, one per line, with no more than 300 characters each.', faqsInput);
    }
    if (handoff.length > 1000) return fail('Handoff rule must be 1000 characters or fewer.', handoffInput);
    if (pricing.length > 200 || policies.length > 100 || bookingRules.length > 2000) return fail('Pricing, policies, or booking rules exceed the allowed limits.', bookingInput);
    try {
      if (!form.reportValidity()) {
        saveButton.disabled = false;
        return;
      }
      const result = await saveOnboarding({ businessName, websiteUrl, summary, services, locations, hours, contactPhone, contactEmail, tone, faqs, pricing, policies, bookingRules, handoff });
      state.setupOnboarding = {
        onboarding: result.data.onboarding || {},
        onboardingComplete: Boolean(result.data.onboardingComplete),
        source: result.source,
      };
      state.businessContextDraft = null;
      state.view = 'overview';
      setActiveNav();
      await load();
    } catch (failure) {
      error.textContent = failure.message;
      saveButton.disabled = false;
    }
  });
  nameInput.focus();
}

const titles = {
  overview: ['Dashboard', 'Your messages, contacts, and follow-ups in one place.'],
  messaging: ['Messaging', 'Inbox of customer responses and conversations'],
  call: ['Calls', 'Track inbound calls from your customers.'],
  messages: ['Messages', 'Searchable CRM log for every SMS'],
  contacts: ['Contacts', 'Find customers and manage your contacts.'],
  optouts: ['Opt-Outs', 'Numbers that asked to stop receiving SMS'],
  deliverability: ['Deliverability', 'Delivery outcomes across the message store'],
  automations: ['Automations', 'Lifecycle-driven SMS sequences and enrollment rules'],
  'business-setup': ['Business setup', 'Phone number and Twilio registration for this business.'],
  'business-context': ['Business context', 'What you sell, where, and how replies should sound.'],
  knowledge: ['AI knowledge', 'Approve evidence, review leads, and resolve human handoffs.'],
  bookings: ['Bookings', 'Confirmed appointments created securely for this business.'],
  'booking-setup': ['Booking setup', 'Availability and questions collected before an SMS booking.'],
};

async function renderKnowledge() {
  setTitle(...titles.knowledge);el.kpi.innerHTML='';el.pager.hidden=true;el.root.innerHTML='<div class="card"><div class="empty">Loading approved knowledge…</div></div>';
  const response=await apiFetch('/api/knowledge'),data=await response.json();if(!response.ok)throw new Error(data.error||'Could not load knowledge');
  const versions=data.sourceVersions||[],sources=data.sources||[],leads=data.leads||[],handoffs=data.handoffs||[];
  const rows=sources.map(source=>{const draft=versions.find(v=>v.source_id===source.id&&v.status==='ready'),archived=source.status==='archived';return `<tr><td><strong>${esc(source.title||source.type)}</strong><br><span class="muted">${esc(source.origin||source.storage_path||'Manual')}</span></td><td><span class="status ${esc(source.status)}">${esc(source.status)}</span></td><td>${source.active_version_id?'Approved':'Not live'}</td><td>${archived?'—':`${draft?`<button class="btn ghost" data-approve-version="${esc(draft.id)}">Review & approve v${draft.version}</button>`:`<button class="btn ghost" data-refresh-source="${esc(source.id)}">Refresh</button>`} <button class="btn ghost" data-archive-source="${esc(source.id)}">Archive</button>`}</td></tr>`;}).join('');
  el.root.innerHTML=`<div class="setup-page"><div class="card setup-hero"><div><span class="eyebrow">Approved source of truth</span><h2>Ground every SMS answer.</h2><p class="muted">Imports remain drafts until you approve them. Unsupported or conflicting questions create a human handoff.</p></div><dl class="setup-facts"><div><dt>Approved profile</dt><dd>${data.profile?'active':'required'}</dd></div><div><dt>Sources</dt><dd>${sources.length}</dd></div></dl></div>
  <div class="setup-layout"><div class="setup-main"><section class="card"><div class="card-head"><div><span class="eyebrow">Sources</span><h2>Websites and private documents</h2></div></div><div class="setup-body"><form id="knowledge-url-form" class="setup-fetch-row"><label class="setup-fetch-url"><span class="compose-label">Public HTTPS website</span><input id="knowledge-url" type="url" required placeholder="https://example.com" /></label><button class="btn">Import draft</button></form><form id="knowledge-file-form" class="setup-fetch-row" style="margin-top:12px"><label class="setup-fetch-url"><span class="compose-label">PDF, DOCX, TXT, or Markdown · max 10 MB</span><input id="knowledge-file" type="file" required accept=".pdf,.docx,.txt,.md,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,text/plain,text/markdown" /></label><button class="btn">Upload draft</button></form><p id="knowledge-error" class="login-error" role="alert"></p><div class="table-wrap"><table><thead><tr><th>Source</th><th>Processing</th><th>Live</th><th></th></tr></thead><tbody>${rows||'<tr><td colspan="4" class="empty">No imported sources yet.</td></tr>'}</tbody></table></div></div></section>
  <section class="card"><div class="card-head"><div><span class="eyebrow">CRM</span><h2>Open leads and handoffs</h2></div></div><div class="setup-body"><div class="table-wrap"><table><thead><tr><th>Type</th><th>Summary / reason</th><th>Priority</th><th>Status</th></tr></thead><tbody>${[...handoffs.map(x=>({...x,_type:'Handoff',_text:x.reason})),...leads.map(x=>({...x,_type:'Lead',_text:x.summary}))].map(x=>`<tr><td>${x._type}</td><td>${esc(x._text||'Customer follow-up')}</td><td>${esc(x.priority)}</td><td>${esc(x.status)}</td></tr>`).join('')||'<tr><td colspan="4" class="empty">Nothing needs attention.</td></tr>'}</tbody></table></div></div></section></div>
  <aside class="setup-side"><div class="card setup-card setup-help"><div class="card-head"><h2>Precedence</h2></div><ol class="setup-help-list"><li>Structured business profile</li><li>Admin-authored FAQs, pricing, policies</li><li>Approved imported content</li><li>Automation style instructions</li></ol><p class="muted">Scanned documents are intentionally rejected in v1.</p></div></aside></div></div>`;
  const error=el.root.querySelector('#knowledge-error'),reload=()=>renderKnowledge().catch(console.error);
  el.root.querySelector('#knowledge-url-form')?.addEventListener('submit',async event=>{event.preventDefault();error.textContent='';const origin=el.root.querySelector('#knowledge-url').value.trim();try{const res=await apiFetch('/api/knowledge/sources',{method:'POST',body:JSON.stringify({type:'website',title:new URL(origin).hostname,origin})});const body=await res.json();if(!res.ok)throw new Error(body.error||'Import failed');await reload();}catch(e){error.textContent=e.message;}});
  el.root.querySelector('#knowledge-file-form')?.addEventListener('submit',async event=>{event.preventDefault();error.textContent='';const file=el.root.querySelector('#knowledge-file').files?.[0];if(!file)return;try{const sign=await apiFetch('/api/knowledge/uploads/sign',{method:'POST',body:JSON.stringify({fileName:file.name,size:file.size,contentType:file.type||'text/plain'})}),signed=await sign.json();if(!sign.ok)throw new Error(signed.error||'Upload could not start');const uploadUrl=/^https?:/.test(signed.signedUrl)?signed.signedUrl:`${runtimeConfig.supabaseUrl||''}${signed.signedUrl}`;const upload=await fetch(uploadUrl,{method:'PUT',headers:{'Content-Type':file.type||'text/plain'},body:file});if(!upload.ok)throw new Error('Private upload failed');const create=await apiFetch('/api/knowledge/sources',{method:'POST',body:JSON.stringify({type:'file',title:file.name,storagePath:signed.path})});const created=await create.json();if(!create.ok)throw new Error(created.error||'Import failed');await reload();}catch(e){error.textContent=e.message;}});
  el.root.querySelectorAll('[data-refresh-source]').forEach(button=>button.addEventListener('click',async()=>{await apiFetch(`/api/knowledge/sources/${button.dataset.refreshSource}/refresh`,{method:'POST',body:'{}'});await reload();}));
  el.root.querySelectorAll('[data-archive-source]').forEach(button=>button.addEventListener('click',async()=>{if(!confirm('Archive this source and remove it from live AI retrieval?'))return;const res=await apiFetch(`/api/knowledge/sources/${button.dataset.archiveSource}`,{method:'DELETE'}),body=await res.json();if(!res.ok){error.textContent=body.error||'Archive failed';return;}await reload();}));
  el.root.querySelectorAll('[data-approve-version]').forEach(button=>button.addEventListener('click',()=>{const draft=versions.find(v=>v.id===button.dataset.approveVersion),source=sources.find(s=>s.id===draft?.source_id),previous=versions.find(v=>v.id===source?.active_version_id),oldText=String(previous?.extracted_text||''),newText=String(draft?.extracted_text||'');openDrawer(`Review ${source?.title||'knowledge'} v${draft?.version||''}`,`<div class="kv"><div class="row"><div class="k">Change</div><div class="v">${previous?`${newText.length-oldText.length>=0?'+':''}${newText.length-oldText.length} characters`:'First approved version'}</div></div><div class="row"><div class="k">Previous approved text</div><div class="v"><pre style="white-space:pre-wrap;max-height:220px;overflow:auto">${esc(oldText.slice(0,8000)||'No previous version')}</pre></div></div><div class="row"><div class="k">New extracted text</div><div class="v"><pre style="white-space:pre-wrap;max-height:320px;overflow:auto">${esc(newText.slice(0,12000))}</pre></div></div></div><div class="compose-actions"><span id="approve-error" class="login-error"></span><button class="btn" id="approve-knowledge-now">Approve and make live</button></div>`);el.drawerBody.querySelector('#approve-knowledge-now')?.addEventListener('click',async event=>{event.currentTarget.disabled=true;const res=await apiFetch(`/api/knowledge/versions/${draft.id}/approve`,{method:'POST',body:'{}'}),body=await res.json();if(!res.ok){el.drawerBody.querySelector('#approve-error').textContent=body.error||'Approval failed';event.currentTarget.disabled=false;return;}closeDrawer();await reload();});}));
}

function contactTypeLabel(source) {
  const labels = {
    prebooking: 'Lead', booking: 'Appointment', contact: 'Inquiry',
    phone_agent: 'Phone contact', customer: 'Customer', in_home_estimate: 'Inquiry',
  };
  return labels[source] || String(source).replaceAll('_', ' ');
}

document.getElementById('nav').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-view]');
  if (!btn) return;
  state.view = btn.dataset.view;
  state.categoryId = btn.dataset.category || null;
  state.page = 1;
  if (state.view !== 'messaging') state.conversationPhone = null;
  if (state.view === 'automations' && !btn.dataset.category) {
    state.categoryId = null;
  }
  setActiveNav();
  closeSidebar();
  load();
});

function setSidebarOpen(open) {
  const isOpen = Boolean(open);
  document.querySelector('.crm')?.classList.toggle('sidebar-open', isOpen);
  el.sidebarTrigger?.classList.toggle('is-open', isOpen);
  el.sidebarTrigger?.setAttribute('aria-expanded', String(isOpen));
  el.sidebarTrigger?.setAttribute('aria-label', isOpen ? 'Close navigation' : 'Open navigation');
  if (el.sidebarBackdrop) el.sidebarBackdrop.tabIndex = isOpen ? 0 : -1;
  syncOverlayLock();
  if (isOpen) requestAnimationFrame(() => el.sidebarClose?.focus());
}

function closeSidebar({ restoreFocus = false } = {}) {
  setSidebarOpen(false);
  if (restoreFocus) el.sidebarTrigger?.focus();
}

el.sidebarTrigger?.addEventListener('click', () => {
  const isOpen = document.querySelector('.crm')?.classList.contains('sidebar-open');
  setSidebarOpen(!isOpen);
});
el.sidebarClose?.addEventListener('click', () => closeSidebar({ restoreFocus: true }));
el.sidebarBackdrop?.addEventListener('click', () => closeSidebar({ restoreFocus: true }));
document.addEventListener('keydown', (event) => {
  if (event.key !== 'Escape') return;
  if (!el.drawer?.hidden) {
    closeDrawer();
    return;
  }
  closeSidebar({ restoreFocus: true });
});

document.getElementById('refresh').addEventListener('click', () => load());
document.getElementById('drawer-close').addEventListener('click', closeDrawer);
el.drawerBackdrop?.addEventListener('click', closeDrawer);

el.prev.addEventListener('click', () => {
  if (state.page > 1) {
    state.page -= 1;
    load();
  }
});
el.next.addEventListener('click', () => {
  if (state.page < state.totalPages) {
    state.page += 1;
    load();
  }
});
el.pageSize.addEventListener('change', () => {
  state.pageSize = Number(el.pageSize.value) || 50;
  state.page = 1;
  load();
});

let searchTimer;
el.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.q = el.search.value.trim();
    state.page = 1;
    load();
  }, 250);
});
el.status.addEventListener('change', () => {
  state.status = el.status.value;
  state.page = 1;
  load();
});

function setActiveNav() {
  const onAutomations = state.view === 'automations';
  if (el.navAutomations) el.navAutomations.hidden = !onAutomations;

  document.querySelectorAll('.nav-item').forEach((node) => {
    let active = false;
    if (onAutomations && node.dataset.category) {
      active = node.dataset.view === 'automations' && node.dataset.category === state.categoryId;
    } else if (!node.dataset.category) {
      active = node.dataset.view === state.view;
    }
    node.classList.toggle('active', active);
  });

  const parent = document.getElementById('nav-automations-root');
  if (parent) {
    parent.classList.toggle('parent-open', onAutomations && Boolean(state.categoryId));
    parent.classList.toggle('expanded', onAutomations);
    parent.setAttribute('aria-expanded', String(onAutomations));
  }
}

function syncSidebarBrand() {
  const name = state.tenant?.shortName || state.tenant?.name || 'Opek';
  const brandName = document.getElementById('sidebar-brand-name');
  if (brandName) brandName.textContent = name;
  const dot = document.getElementById('tenant-dot');
  if (dot) {
    const initials = String(name).trim().slice(0, 1).toUpperCase() || 'O';
    dot.textContent = initials;
  }
}

function initNavFind() {
  const input = document.getElementById('nav-find');
  if (!input || input.dataset.bound) return;
  input.dataset.bound = 'true';
  input.addEventListener('input', () => {
    const q = input.value.trim().toLowerCase();
    document.querySelectorAll('#nav .nav-item').forEach((item) => {
      const hay = `${item.textContent || ''} ${item.dataset.find || ''}`.toLowerCase();
      item.hidden = Boolean(q) && !hay.includes(q);
    });
    document.querySelectorAll('#nav section').forEach((section) => {
      const visible = [...section.querySelectorAll('.nav-item')].some((n) => !n.hidden);
      section.hidden = !visible;
    });
    if (q && el.navAutomations && !el.navAutomations.hidden) {
      el.navAutomations.querySelectorAll('.nav-item').forEach((item) => {
        const hay = `${item.textContent || ''}`.toLowerCase();
        item.hidden = !hay.includes(q);
      });
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key.toLowerCase() !== 'f' || event.metaKey || event.ctrlKey || event.altKey) return;
    const tag = String(document.activeElement?.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    event.preventDefault();
    input.focus();
  });
}

async function load() {
  document.getElementById('crm-app').dataset.view = state.view;
  el.search.closest('.search-wrap').hidden = ['overview', 'call', 'deliverability', 'business-setup', 'business-context', 'booking-setup', 'knowledge'].includes(state.view);
  el.status.hidden = !['messages', 'deliverability'].includes(state.view) && !(state.view === 'automations' && state.categoryId);
  if (state.view === 'business-setup') el.pager.hidden = true;
  try {
    if (!state.categories.length) {
      const catRes = await apiFetch('/api/categories');
      if (catRes.status === 401 || catRes.status === 403) {
        await forceLogin('Session expired. Please sign in again.');
        return;
      }
      const catJson = await catRes.json();
      state.categories = catJson.categories || [];
      state.cadences = catJson.cadences || [];
      state.rulePresets = catJson.rulePresets || [];
      renderNavAutomations();
    }

    if (state.view === 'overview') await renderOverview();
    else if (state.view === 'messaging') await renderMessaging();
    else if (state.view === 'call') await renderCall();
    else if (state.view === 'contacts') await renderContacts();
    else if (state.view === 'optouts') await renderOptOuts();
    else if (state.view === 'deliverability') await renderDeliverability();
    else if (state.view === 'automations') await renderAutomations();
    else if (state.view === 'business-setup') await renderBusinessSetup();
    else if (state.view === 'business-context') await renderBusinessContext();
    else if (state.view === 'booking-setup') await renderBookingSetup();
    else if (state.view === 'bookings') await renderBookings();
    else if (state.view === 'knowledge') await renderKnowledge();
    else await renderMessages();
  } catch (err) {
    console.error(err);
    el.root.innerHTML = `<div class="card"><div class="empty">Failed to load CRM data.</div></div>`;
  }
}

function renderNavAutomations() {
  if (!el.navAutomations) return;
  el.navAutomations.innerHTML = state.categories
    .map(
      (c) => `
      <button type="button" class="nav-item nav-subitem" data-view="automations" data-category="${esc(
        c.id
      )}" data-find="${esc(`${c.name} ${c.description || ''}`.toLowerCase())}">
        ${esc(c.name)}
      </button>`
    )
    .join('');
  const count = document.getElementById('nav-automations-count');
  if (count) {
    const n = state.categories.length;
    count.hidden = !n;
    count.textContent = String(n);
  }
  initNavFind();
}

function openAutomationGroup(categoryId = null) {
  state.view = 'automations';
  state.categoryId = categoryId;
  state.automationBuilderOpen = false;
  state.automationPresetId = null;
  state.aiBuilderOpen = false;
  state.page = 1;
  setActiveNav();
  load();
}

async function renderCall() {
  setTitle(...titles.call);
  el.kpi.innerHTML = '';
  el.status.disabled = true;
  el.pager.hidden = true;
  el.storeMeta.textContent = 'Inbound calls';
  const params = new URLSearchParams({ page: String(state.page), pageSize: String(state.pageSize) });
  const response = await apiFetch(`/api/calls?${params}`);
  if (!response.ok) throw new Error('Could not load inbound calls');
  const data = await response.json();
  state.totalPages = data.totalPages || 1;
  renderPager(data);
  el.pager.hidden = !(data.total > 0);
  el.root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Inbound calls</h2><span class="muted">${fmt(data.total || 0)} calls</span></div>
      <div class="table-scroll"><table class="data">
        <thead><tr><th>Caller</th><th>Received</th><th>Status</th><th>Duration</th></tr></thead>
        <tbody>${(data.calls || []).filter(call => call.direction === 'inbound').map(call => `
          <tr><td>${esc(call.phone || 'Unknown caller')}</td><td>${esc(fmtTime(call.started_at))}</td>
          <td>${esc(call.status || 'Unknown')}</td><td>${call.duration_secs == null ? '—' : `${Math.max(0, Math.round(Number(call.duration_secs) || 0))} sec`}</td></tr>
        `).join('') || '<tr><td colspan="4"><div class="empty">No inbound calls yet.</div></td></tr>'}</tbody>
      </table></div>
    </div>`;
}

async function renderOverview() {
  setTitle(...titles.overview);
  el.pager.hidden = true;
  el.status.disabled = true;

  let data = {};
  let provisioning = null;
  let totalsAvailable = false;
  try {
    const res = await apiFetch('/api/overview');
    if (res.status === 401 || res.status === 403) {
      await forceLogin('Session expired. Please sign in again.');
      return;
    }
    if (!res.ok) throw new Error('Could not load dashboard totals');
    data = await res.json();
    totalsAvailable = true;
  } catch (err) {
    console.error(err);
  }
  try {
    const response = await apiFetch('/api/provisioning');
    if (response.ok) provisioning = await response.json();
  } catch (error) { console.error(error); }
  state.setupProvisioning = provisioning;
  let onboardingComplete = state.setupOnboarding?.onboardingComplete;
  if (onboardingComplete == null) {
    try {
      const onb = await fetchOnboarding();
      state.setupOnboarding = onb;
      onboardingComplete = onb.onboardingComplete;
    } catch (error) { console.error(error); onboardingComplete = false; }
  }
  el.kpi.innerHTML = [
    kpiCard('Conversations', totalsAvailable ? data.conversationCount ?? data.contactCount ?? 0 : '—'),
    kpiCard('Total SMS', totalsAvailable ? data.total ?? 0 : '—'),
    kpiCard('Delivery rate', data.deliveryRate == null ? '—' : `${data.deliveryRate}%`),
  ].join('');
  el.storeMeta.textContent = state.tenant?.name || 'Your workspace';

  el.root.innerHTML = `
    ${totalsAvailable ? '' : '<p class="muted" role="status">Message totals are unavailable. Select Refresh to try again.</p>'}
    ${provisioning && !provisioning.sendingEnabled ? `
      <details class="card dashboard-details" open>
        <summary>Business messaging setup</summary>
        <p><strong>${esc({pending:'Preparing Twilio account',creating_account:'Creating Twilio subaccount',account_created:'Twilio subaccount created',creating_service:'Creating Messaging Service',awaiting_number:'Ready for phone number and registration',submission_unknown:'Twilio setup needs review',ready:'Messaging setup complete'}[provisioning.state] || String(provisioning.state || 'Setup pending').replaceAll('_',' '))}</strong></p>
        <p class="muted">${provisioning.state === 'awaiting_number'
          ? 'This business now has a separate Twilio subaccount under the parent billing account. Select and purchase its phone number, then complete the applicable campaign registration before enabling sending.'
          : provisioning.state === 'submission_unknown'
            ? 'Twilio may have created a resource before the response was interrupted. Review the parent Twilio account and reconcile it before retrying.'
            : 'Setup runs in the background. Sending stays disabled until a phone number and the applicable registration are complete.'}</p>
        <p class="muted">Twilio details: ${provisioning.detailsComplete ? 'saved · registration submission is next' : 'required'}</p>
        <button type="button" class="btn" data-complete-business-setup>${provisioning.detailsComplete ? 'Review setup details' : 'Complete business setup'}</button>
        <p class="muted" style="margin-top:12px">Business context for SMS + AI: ${onboardingComplete ? 'saved' : 'required'}</p>
        <button type="button" class="btn ghost" data-open-business-context>${onboardingComplete ? 'Review business context' : 'Add business context'}</button>
      </details>` : ''}
    <div class="dashboard-actions" aria-label="Quick actions">
      <button type="button" class="dashboard-action" data-dashboard-view="messaging"><strong>Open inbox <span aria-hidden="true">→</span></strong><span>Read and reply to customers</span></button>
      <button type="button" class="dashboard-action" data-dashboard-view="contacts"><strong>View contacts <span aria-hidden="true">→</span></strong><span>Find a customer or lead</span></button>
      <button type="button" class="dashboard-action" data-dashboard-view="automations"><strong>Manage follow-ups <span aria-hidden="true">→</span></strong><span>Review your automated messages</span></button>
    </div>
    <details class="card dashboard-details">
      <summary>More message statistics</summary>
      <dl class="dashboard-stats">
        <div><dt>Delivered messages</dt><dd>${totalsAvailable ? fmt(data.counts?.delivered ?? 0) : '—'}</dd></div>
        <div><dt>Opted-out contacts</dt><dd>${totalsAvailable ? fmt(data.optedOutTotal ?? 0) : '—'}</dd></div>
      </dl>
      <button type="button" class="btn ghost" data-dashboard-view="deliverability">View delivery report</button>
      <button type="button" class="btn ghost" data-dashboard-view="optouts">View opt-outs</button>
    </details>
    <div class="card">
      <div class="card-head">
        <h2>Follow-ups</h2>
        <button type="button" class="btn ghost" data-dashboard-view="automations">Manage</button>
      </div>
      <div class="dashboard-groups">
        ${state.categories
          .map((c) => {
            const s = data.byCategory?.find((x) => x.id === c.id);
            return `
              <div class="dashboard-group">
              <button type="button" class="dashboard-group-open" data-open-automation="${esc(
                c.id
              )}">
                <strong>${esc(c.name)}</strong><span aria-hidden="true">→</span>
              </button>
              <details><summary>Details</summary>
                <p>${esc(c.description || 'Automated customer follow-up.')}</p>
                <p class="muted">${totalsAvailable ? fmt(s?.total ?? 0) : '—'} messages · ${
                  s?.deliveryRate == null ? '—' : `${s.deliveryRate}% delivered`
                }</p>
                <p class="muted">${automationBlankLabel(c)}</p>
              </details></div>`;
          })
          .join('') || '<p class="empty">No follow-ups yet. Select Manage to create one.</p>'}
      </div>
    </div>
  `;

  if (globalThis.SMS_CONFIG?.apiBase) {
    el.root.insertAdjacentHTML('beforeend', '<details class="card dashboard-details" id="worker-status"><summary>Automation status</summary><div class="worker-status-content muted">Open to check automation status.</div></details>');
    const details = el.root.querySelector('#worker-status');
    details.addEventListener('toggle', async () => {
      if (!details.open) return;
      const node = details.querySelector('.worker-status-content');
      try {
        const response = await apiFetch('/api/operations');
        if (!response.ok) throw new Error('Status is temporarily unavailable');
        const data = await response.json();
        const active = (data.workers || []).filter(w => Date.now() - new Date(w.seen_at).getTime() < 120000);
        node.innerHTML = `<p>Scheduling: ${data.scheduler?.scheduler_enabled ? 'On' : 'Paused'} · ${active.length} worker connections active</p>` +
          (data.jobs || []).map(j => `<p>${esc(j.queue.replaceAll('_', ' '))}: ${fmt(j.count)} ${esc(j.status.replaceAll('_', ' '))}</p>`).join('') +
          (data.problems || []).map(j => `<p>${esc(j.status === 'submission_unknown' ? 'Needs review — delivery could not be confirmed. Automatic retry is held.' : j.error_code || 'Job failed')}${j.status === 'failed' ? ` <button class="btn ghost" data-retry-job="${esc(j.id)}">Retry</button>` : ''}</p>`).join('');
        node.querySelectorAll('[data-retry-job]').forEach(button => button.addEventListener('click', async () => {
          button.disabled = true;
          const res = await apiFetch(`/api/jobs/${encodeURIComponent(button.dataset.retryJob)}/retry`, { method: 'POST' });
          button.textContent = res.ok ? 'Queued' : 'Retry unavailable';
        }));
      } catch (error) { node.textContent = error.message; }
    });
  }
  el.root.querySelectorAll('[data-dashboard-view]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelector(`.nav-item[data-view="${btn.dataset.dashboardView}"]`)?.click();
    });
  });
  el.root.querySelector('[data-complete-business-setup]')?.addEventListener('click', () => {
    openBusinessSetup();
  });
  el.root.querySelector('[data-open-business-context]')?.addEventListener('click', () => {
    openBusinessContext();
  });

  el.root.querySelectorAll('[data-open-automation]').forEach((btn) => {
    btn.addEventListener('click', () => openAutomationGroup(btn.getAttribute('data-open-automation')));
  });
}

function automationBlankLabel(category) {
  if (category.id === 'quote-requests') return 'Quote Request drip · 6 steps';
  if (category.id === 'appointment-reminders') return 'Appointment reminder · 24h before';
  if (category.custom && category.rule) {
    return `${category.rule.firstSendAt ? `Scheduled ${fmtTime(category.rule.firstSendAt)}` : cadenceDisplay(category.rule)} · ${category.rule.repeatCount} send${
      category.rule.repeatCount === 1 ? '' : 's'
    }${category.activeAutomation ? '' : ' · inactive'}`;
  }
  return 'No automations yet';
}

function cadenceDisplay(rule) {
  if (rule?.cadence !== 'custom') {
    return state.cadences.find((cadence) => cadence.id === rule?.cadence)?.label || 'Custom';
  }
  return `Every ${rule.intervalCount} ${rule.intervalUnit}${rule.intervalCount === 1 ? '' : 's'}`;
}

function automationBuilderHtml(group = null) {
  const initialPreset = group
    ? null
    : state.rulePresets.find((preset) => preset.id === state.automationPresetId) || state.rulePresets[0] || null;
  const draftType = group?.kind === 'quote' || group?.id === 'quote-requests' || initialPreset?.id === 'quote-followup'
    ? 'Quote follow-up'
    : initialPreset?.id === 'review-request' ? 'Review request'
      : initialPreset?.id === 'new-lead-nurture' ? 'New lead nurture'
        : initialPreset?.id === 'customer-reengagement' ? 'Customer re-engagement'
          : 'Custom';
  const rule = group?.rule || initialPreset?.rule || {
    cadence: 'daily',
    intervalCount: 1,
    intervalUnit: 'day',
    repeatCount: 3,
    deliveryMode: 'deterministic',
    template: 'Hi {{first_name}}, {{business_name}} here about your {{service_name}}. How can we help with the next step? Reply STOP to opt out.',
    startHour: 9,
    endHour: 19,
    firstSendAt: null,
    steps: [],
  };
  const steps = rule.steps?.length
    ? rule.steps
    : Array.from({ length: rule.repeatCount || 1 }, (_, index) => ({
        id: `send-${index + 1}`,
        template: rule.template,
        delayCount: rule.intervalCount,
        delayUnit: rule.intervalUnit,
      }));
  return `
    <form class="automation-builder card" id="automation-builder">
      <div class="card-head">
        <div>
          <span class="eyebrow">Ready-made automation rules</span>
          <h2>${group ? 'Edit automation' : 'Create automation'}</h2>
        </div>
        <button type="button" class="btn ghost" id="cancel-automation-builder">Cancel</button>
      </div>
      <div class="automation-form-grid">
        <label class="field-wide">
          <span class="compose-label">Start with an automation</span>
          <select id="automation-preset">
            <option value="">${group ? 'Keep the current rule' : 'Start from scratch'}</option>
            ${state.rulePresets.map((preset) => `<option value="${esc(preset.id)}" ${!group && preset.id === initialPreset?.id ? 'selected' : ''}>${esc(preset.label)} — ${esc(preset.description)}</option>`).join('')}
          </select>
          <small class="muted" id="automation-preset-description">${esc(initialPreset?.description || 'Choose a proven sequence, then adjust any timing or message if needed.')}</small>
        </label>
        <label class="field-wide">
          <span class="compose-label">Automation name</span>
          <input id="automation-name" maxlength="100" required value="${esc(group?.name || initialPreset?.defaultName || '')}" placeholder="Post-job follow-up" />
        </label>
        <label class="field-wide">
          <span class="compose-label">Description</span>
          <input id="automation-description" maxlength="300" value="${esc(group?.description || initialPreset?.description || '')}" placeholder="What this automation is for" />
        </label>
        <label>
          <span class="compose-label">Cadence</span>
          <select id="automation-cadence">
            ${state.cadences
              .map(({ id, label }) => `<option value="${esc(id)}" ${rule.cadence === id ? 'selected' : ''}>${esc(label)}</option>`)
              .join('')}
          </select>
        </label>
        <div class="custom-interval" id="custom-interval" ${rule.cadence === 'custom' ? '' : 'hidden'}>
          <label>
            <span class="compose-label">Every</span>
            <input id="automation-interval-count" type="number" min="1" max="365" value="${esc(rule.intervalCount)}" />
          </label>
          <label>
            <span class="compose-label">Unit</span>
            <select id="automation-interval-unit">
              ${['day', 'week', 'month'].map((unit) => `<option value="${unit}" ${rule.intervalUnit === unit ? 'selected' : ''}>${unit}${unit === rule.intervalUnit && rule.intervalCount === 1 ? '' : 's'}</option>`).join('')}
            </select>
          </label>
        </div>
        <label>
          <span class="compose-label">Number of sends</span>
          <input id="automation-repeat-count" type="number" min="1" max="30" value="${esc(steps.length)}" required />
        </label>
        <div class="send-window-fields">
          <label>
            <span class="compose-label">Send after</span>
            <select id="automation-start-hour">${hourOptions(rule.startHour, 0, 23)}</select>
          </label>
          <label>
            <span class="compose-label">Send before</span>
            <select id="automation-end-hour">${hourOptions(rule.endHour, 1, 24)}</select>
          </label>
        </div>
        <label class="field-wide">
          <span class="compose-label">First send date and time (optional)</span>
          <input id="automation-first-send" type="datetime-local" value="${esc(toDateTimeLocal(rule.firstSendAt))}" />
          <small class="muted">Set this for a scheduled campaign. Leave blank to start after the first message delay.</small>
        </label>
        <div class="field-wide automation-ai-generator">
          <div class="automation-message-head">
            <div><span class="compose-label">Draft the full sequence with AI</span><small class="muted">AI fills every message editor once. Review and edit the drafts, then save explicitly. Scheduled sends never call AI.</small></div>
            <button type="button" class="btn ghost" id="generate-automation-messages">Draft all messages with AI</button>
          </div>
          <div class="automation-form-grid">
            <label><span class="compose-label">Automation type</span><select id="automation-draft-type">
              ${['Quote follow-up','Hiring follow-up','Review request','New lead nurture','Customer re-engagement','Custom'].map((type)=>`<option value="${esc(type)}" ${type===draftType?'selected':''}>${esc(type)}</option>`).join('')}
            </select></label>
            <label><span class="compose-label">Service, role, or subject</span><input id="automation-context-label" maxlength="160" required value="${esc(rule.contextLabel||'')}" placeholder="Roof replacement, HVAC tune-up, Service technician" /></label>
            <label class="field-wide"><span class="compose-label">Automation goal</span><input id="automation-draft-goal" maxlength="500" value="" placeholder="Help the customer decide and invite questions" /></label>
            <label><span class="compose-label">Tone</span><input id="automation-draft-tone" maxlength="120" value="Friendly and professional" /></label>
            <label><span class="compose-label">Optional drafting instructions</span><input id="automation-draft-instructions" maxlength="1000" placeholder="Mention financing without promising approval" /></label>
          </div>
          <small class="muted" id="automation-draft-status">20 new generations are available per rolling 24 hours for each business.</small>
        </div>
        <div class="field-wide automation-message-head">
          <div>
            <span class="compose-label">Automated messages</span>
            <small class="muted">Each delay is measured after enrollment or the previous successful send.</small>
          </div>
          <button type="button" class="btn ghost" id="add-automation-message">Add message</button>
        </div>
        <div class="field-wide automation-step-editor" id="automation-step-editor">
          ${automationStepRows(steps)}
        </div>
        <label class="check field-wide">
          <input id="automation-active" type="checkbox" ${group?.activeAutomation === false ? '' : 'checked'} />
          Active and available for enrollment
        </label>
      </div>
      <div class="automation-builder-actions">
        <span class="login-error" id="automation-builder-error"></span>
        <button type="submit" class="btn" id="save-automation-group">${group ? 'Save changes' : 'Create automation'}</button>
      </div>
    </form>`;
}

function automationStepRows(steps) {
  return steps
    .map(
      (step, index) => `
      <div class="automation-step-row" data-step-row>
        <div class="automation-step-title">
          <strong>Message ${index + 1}</strong>
          <button type="button" class="btn ghost remove-automation-message" ${steps.length === 1 ? 'disabled' : ''}>Remove</button>
        </div>
        <div class="automation-step-delay">
          <label>
            <span class="compose-label">Delay</span>
            <input class="step-delay-count" type="number" min="0" max="365" value="${esc(step.delayCount ?? 1)}" required />
          </label>
          <label>
            <span class="compose-label">Unit</span>
            <select class="step-delay-unit">
              ${['day', 'week', 'month'].map((unit) => `<option value="${unit}" ${step.delayUnit === unit ? 'selected' : ''}>${unit}${Number(step.delayCount) === 1 ? '' : 's'}</option>`).join('')}
            </select>
          </label>
        </div>
        <label>
          <span class="compose-label">Message</span>
          <textarea class="step-template" maxlength="1600" rows="4" required>${esc(step.template || '')}</textarea>
        </label>
      </div>`
    )
    .join('');
}

function toDateTimeLocal(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  try {
    const parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone: state.tenant?.timeZone || undefined,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
      })
        .formatToParts(date)
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value])
    );
    return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
  } catch {
    return '';
  }
}

function hourOptions(selected, start, end) {
  return Array.from({ length: end - start + 1 }, (_, index) => start + index)
    .map((hour) => `<option value="${hour}" ${Number(selected) === hour ? 'selected' : ''}>${hour === 24 ? '12:00 AM' : new Date(2000, 0, 1, hour).toLocaleTimeString([], { hour: 'numeric' })}</option>`)
    .join('');
}

function bindAutomationBuilder(group = null) {
  const form = el.root.querySelector('#automation-builder');
  if (!form) return;
  const cadence = form.querySelector('#automation-cadence');
  const presetSelect = form.querySelector('#automation-preset');
  const customInterval = form.querySelector('#custom-interval');
  const repeatCount = form.querySelector('#automation-repeat-count');
  const stepEditor = form.querySelector('#automation-step-editor');
  const protectedRule=Boolean(group?.system&&(group.kind==='quote'||group.id==='quote-requests'));
  let generatedDraft=group?.rule?.generationProvenance||null;
  let generatedBodies=null;
  const cadenceDefaults = Object.fromEntries(
    state.cadences.map((item) => [item.id, [item.intervalCount, item.intervalUnit]])
  );

  const readSteps = () =>
    [...form.querySelectorAll('[data-step-row]')].map((row, index) => ({
      id: `send-${index + 1}`,
      delayCount: Number(row.querySelector('.step-delay-count').value),
      delayUnit: row.querySelector('.step-delay-unit').value,
      template: row.querySelector('.step-template').value,
    }));

  const renderSteps = (steps) => {
    stepEditor.innerHTML = automationStepRows(steps);
    repeatCount.value = String(steps.length);
    stepEditor.querySelectorAll('.remove-automation-message').forEach((button) => {
      button.addEventListener('click', () => {
        const rows = readSteps();
        const index = [...stepEditor.querySelectorAll('[data-step-row]')].indexOf(
          button.closest('[data-step-row]')
        );
        if (rows.length > 1 && index >= 0) rows.splice(index, 1);
        renderSteps(rows);
      });
    });
  };

  const defaultDelay = () =>
    cadence.value === 'custom'
      ? [
          Number(form.querySelector('#automation-interval-count').value) || 1,
          form.querySelector('#automation-interval-unit').value,
        ]
      : cadenceDefaults[cadence.value] || [1, 'day'];

  const resizeSteps = (size) => {
    const rows = readSteps();
    const desired = Math.min(Math.max(Number(size) || 1, 1), 30);
    const [delayCount, delayUnit] = defaultDelay();
    while (rows.length < desired) {
      rows.push({
        id: `send-${rows.length + 1}`,
        delayCount,
        delayUnit,
        template: rows.at(-1)?.template || 'Hi {{first_name}}, {{business_name}} here about your {{service_name}}. How can we help with the next step? Reply STOP to opt out.',
      });
    }
    rows.length = desired;
    renderSteps(rows);
  };

  presetSelect?.addEventListener('change', () => {
    const preset = state.rulePresets.find((item) => item.id === presetSelect.value);
    if (!preset) {
      form.querySelector('#automation-preset-description').textContent = 'Adjust the current timing and messages below.';
      return;
    }
    const rule = preset.rule || {};
    form.querySelector('#automation-name').value = preset.defaultName || preset.label;
    form.querySelector('#automation-description').value = preset.description || '';
    form.querySelector('#automation-preset-description').textContent = preset.description || '';
    cadence.value = rule.cadence || 'custom';
    form.querySelector('#automation-interval-count').value = String(rule.intervalCount || 1);
    form.querySelector('#automation-interval-unit').value = rule.intervalUnit || 'day';
    customInterval.hidden = cadence.value !== 'custom';
    form.querySelector('#automation-start-hour').innerHTML = hourOptions(rule.startHour ?? 9, 0, 23);
    form.querySelector('#automation-end-hour').innerHTML = hourOptions(rule.endHour ?? 19, 1, 24);
    form.querySelector('#automation-first-send').value = '';
    renderSteps((rule.steps || []).map((step, index) => ({ ...step, id: `send-${index + 1}` })));
  });

  cadence?.addEventListener('change', () => {
    customInterval.hidden = cadence.value !== 'custom';
    const [delayCount, delayUnit] = defaultDelay();
    renderSteps(readSteps().map((step) => ({ ...step, delayCount, delayUnit })));
  });
  repeatCount?.addEventListener('change', () => resizeSteps(repeatCount.value));
  form.querySelector('#add-automation-message')?.addEventListener('click', () => {
    resizeSteps(readSteps().length + 1);
  });
  renderSteps(readSteps());
  if(protectedRule){
    [cadence,customInterval,repeatCount,form.querySelector('#automation-start-hour'),form.querySelector('#automation-end-hour'),form.querySelector('#automation-first-send'),form.querySelector('#add-automation-message'),presetSelect]
      .filter(Boolean).forEach(node=>{node.disabled=true;node.querySelectorAll?.('input,select,button').forEach(child=>child.disabled=true);});
    form.querySelectorAll('.step-delay-count,.step-delay-unit,.remove-automation-message').forEach(node=>node.disabled=true);
  }
  form.querySelector('#generate-automation-messages')?.addEventListener('click',async()=>{
    const button=form.querySelector('#generate-automation-messages'),status=form.querySelector('#automation-draft-status');
    const contextLabel=form.querySelector('#automation-context-label').value.trim();
    if(!contextLabel){status.textContent='Enter the service, role, or subject first.';return;}
    const currentSteps=readSteps();button.disabled=true;status.textContent='Drafting the complete sequence…';
    try{
      const response=await apiFetch('/api/automation-drafts',{method:'POST',headers:{'Idempotency-Key':crypto.randomUUID()},body:JSON.stringify({
        automationType:form.querySelector('#automation-draft-type').value,customType:form.querySelector('#automation-draft-type').value==='Custom'?form.querySelector('#automation-name').value.trim():null,
        contextLabel,goal:form.querySelector('#automation-draft-goal').value.trim(),tone:form.querySelector('#automation-draft-tone').value.trim(),instructions:form.querySelector('#automation-draft-instructions').value.trim(),
        steps:currentSteps.map(({delayCount,delayUnit},stepIndex)=>({stepIndex,delayCount,delayUnit}))
      })});
      const created=await response.json();if(!response.ok)throw new Error(created.detail||created.error||'Could not start AI drafting');
      let draft;
      for(let attempt=0;attempt<60;attempt++){
        await new Promise(resolve=>setTimeout(resolve,1000));
        const poll=await apiFetch(`/api/automation-drafts/${encodeURIComponent(created.draftId)}`);draft=await poll.json();
        if(!poll.ok)throw new Error(draft.detail||draft.error||'Could not check AI draft');
        if(draft.status==='completed'||draft.status==='failed')break;
      }
      if(draft?.status!=='completed')throw new Error(draft?.errorCode?'AI drafting failed. Try again without changing your saved messages.':'AI drafting is taking longer than expected. Your saved messages were not changed.');
      const messages=[...(draft.messages||[])].sort((a,b)=>a.stepIndex-b.stepIndex);
      if(messages.length!==currentSteps.length)throw new Error('AI returned an incomplete sequence. Your messages were not changed.');
      generatedBodies=messages.map(item=>item.message);
      generatedDraft={draftId:draft.draftId,generatedAt:draft.completedAt,promptVersion:draft.promptVersion,contextLabel,edited:false};
      renderSteps(currentSteps.map((step,index)=>({...step,template:generatedBodies[index]})));
      if(protectedRule)form.querySelectorAll('.step-delay-count,.step-delay-unit,.remove-automation-message').forEach(node=>node.disabled=true);
      status.textContent='Draft complete. Review every message, make any edits, then click Save changes.';
    }catch(err){status.textContent=err.message||'AI drafting failed. Your messages were not changed.';}finally{button.disabled=false;}
  });
  form.querySelector('#cancel-automation-builder')?.addEventListener('click', () => {
    state.automationBuilderOpen = false;
    state.automationPresetId = null;
    renderAutomations();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('#save-automation-group');
    const error = form.querySelector('#automation-builder-error');
    button.disabled = true;
    error.textContent = '';
    const steps = readSteps();
    const firstSendValue = form.querySelector('#automation-first-send').value;
    const firstSendAt = firstSendValue || null;
    const payload = {
      name: form.querySelector('#automation-name').value.trim(),
      description: form.querySelector('#automation-description').value.trim(),
      activeAutomation: form.querySelector('#automation-active').checked,
      rule: {
        cadence: cadence.value,
        intervalCount: Number(form.querySelector('#automation-interval-count').value),
        intervalUnit: form.querySelector('#automation-interval-unit').value,
        repeatCount: steps.length,
        deliveryMode: 'deterministic',
        ...(group?.rule?.trigger?{trigger:group.rule.trigger}:{}),
        contextLabel: form.querySelector('#automation-context-label').value.trim(),
        startHour: Number(form.querySelector('#automation-start-hour').value),
        endHour: Number(form.querySelector('#automation-end-hour').value),
        template: steps[0]?.template.trim(),
        firstSendAt,
        steps,
        ...(generatedDraft?{generationProvenance:{...generatedDraft,edited:Boolean(generatedBodies&&steps.some((step,index)=>step.template.trim()!==generatedBodies[index]))}}:{}),
      },
    };
    try {
      const response = await apiFetch(
        group ? `/api/automation-groups/${encodeURIComponent(group.id)}` : '/api/automation-groups',
        { method: group ? 'PUT' : 'POST', body: JSON.stringify(payload) }
      );
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail || json.error || 'Could not save group');
      state.categories = [];
      state.categoryId = json.group.id;
      state.automationBuilderOpen = false;
      state.automationPresetId = null;
      await load();
    } catch (err) {
      error.textContent = err.message || 'Could not save group';
      button.disabled = false;
    }
  });
}

function groupAiBuilderHtml(group) {
  return `
    <form class="automation-builder card" id="group-ai-builder">
      <div class="card-head">
        <div>
          <span class="eyebrow">Group AI behavior</span>
          <h2>${esc(group.name)} instructions</h2>
        </div>
        <button type="button" class="btn ghost" id="cancel-group-ai">Cancel</button>
      </div>
      <div class="automation-form-grid">
        <label class="check field-wide">
          <input id="group-ai-enabled" type="checkbox" ${group.ai?.enabled ? 'checked' : ''} />
          Enable these AI instructions
        </label>
        <label class="check field-wide">
          <input id="group-ai-default-inbound" type="checkbox" ${group.ai?.defaultForInbound ? 'checked' : ''} />
          Respond to eligible inbound texts even when the customer is not enrolled in this group
        </label>
        <label class="check field-wide">
          <input id="group-ai-grounded" type="checkbox" ${group.ai?.grounded_enabled||group.ai?.groundedEnabled ? 'checked' : ''} />
          Answer only from approved business knowledge
        </label>
        <label class="check field-wide">
          <input id="group-ai-shadow" type="checkbox" ${(group.ai?.shadow_mode??group.ai?.shadowMode??true) ? 'checked' : ''} />
          Shadow mode (record evaluations without replying or creating CRM work)
        </label>
        <label class="field-wide">
          <span class="compose-label">Staff alert phone</span>
          <input id="group-ai-alert-phone" type="tel" placeholder="+15551234567" value="${esc(group.ai?.alert_phone||group.ai?.alertPhone||'')}" />
          <small class="muted">One deduplicated alert is queued for an unsupported conversation. Use E.164.</small>
        </label>
        <label class="field-wide">
          <span class="compose-label">Inbound reply AI instructions</span>
          <textarea id="group-ai-instructions" maxlength="6000" rows="8" placeholder="Describe the goal, questions to ask, tone, escalation conditions, and facts the AI may use.">${esc(group.ai?.instructions || '')}</textarea>
          <small class="muted">Style and workflow guidance only. Approved structured facts and sources remain authoritative.</small>
        </label>
      </div>
      <div class="automation-builder-actions">
        <span class="login-error" id="group-ai-error"></span>
        <button type="submit" class="btn" id="save-group-ai">Save inbound reply AI</button>
      </div>
    </form>`;
}

function bindGroupAiBuilder(group) {
  const form = el.root.querySelector('#group-ai-builder');
  if (!form) return;
  form.querySelector('#cancel-group-ai')?.addEventListener('click', () => {
    state.aiBuilderOpen = false;
    renderAutomations();
  });
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const button = form.querySelector('#save-group-ai');
    const error = form.querySelector('#group-ai-error');
    button.disabled = true;
    error.textContent = '';
    try {
      const response = await apiFetch(
        `/api/automation-groups/${encodeURIComponent(group.id)}/ai-instructions`,
        {
          method: 'PUT',
          body: JSON.stringify({
            enabled: form.querySelector('#group-ai-enabled').checked,
            defaultForInbound: form.querySelector('#group-ai-default-inbound').checked,
            instructions: form.querySelector('#group-ai-instructions').value.trim(),
            groundedEnabled: form.querySelector('#group-ai-grounded').checked,
            shadowMode: form.querySelector('#group-ai-shadow').checked,
            alertPhone: form.querySelector('#group-ai-alert-phone').value.trim()||null,
          }),
        }
      );
      const json = await response.json();
      if (!response.ok) throw new Error(json.detail || json.error || 'Could not save AI instructions');
      state.categories = [];
      state.aiBuilderOpen = false;
      await load();
    } catch (err) {
      error.textContent = err.message || 'Could not save AI instructions';
      button.disabled = false;
    }
  });
}

async function renderAutomations() {
  const category = state.categoryId
    ? state.categories.find((c) => c.id === state.categoryId)
    : null;

  if (!category) {
    setTitle(...titles.automations);
    el.pager.hidden = true;
    el.status.disabled = true;
    el.search.placeholder = 'Search automations…';

    const res = await apiFetch('/api/overview');
    const data = await res.json();
    const groups = data.byCategory || [];
    el.kpi.innerHTML = [
      kpiCard('Groups', state.categories.length),
      kpiCard(
        'Automation SMS',
        groups.reduce((n, g) => n + (g.total || 0), 0)
      ),
    ].join('');
    el.storeMeta.textContent = `${state.categories.length} automation groups`;

    el.root.innerHTML = `
      <div class="card">
        <div class="card-head">
          <div>
            <h2>Automation groups</h2>
            <span class="muted">System sequences and ${fmt(state.rulePresets.length)} ready-made rule variations</span>
          </div>
          <button type="button" class="btn" id="new-automation-group">Create automation</button>
        </div>
        ${state.automationBuilderOpen ? automationBuilderHtml() : ''}
        <div class="card-head" style="border-top:1px solid var(--border)">
          <div>
            <h2>Ready-made automations</h2>
            <span class="muted">Choose one to create it with proven timing and editable messages.</span>
          </div>
        </div>
        <div class="category-grid automation-template-grid">
          ${state.rulePresets.map((preset) => `
            <button type="button" class="category-tile as-button" data-create-automation-preset="${esc(preset.id)}">
              <h3>${esc(preset.label)}</h3>
              <p>${esc(preset.description)}</p>
              <p class="muted">${fmt(preset.rule?.steps?.length || 0)} messages · AI drafted by default</p>
              <div class="blank">Use this automation</div>
            </button>`).join('')}
        </div>
        <div class="card-head" style="border-top:1px solid var(--border)">
          <h2>Your automation groups</h2>
        </div>
        <div class="category-grid">
          ${state.categories
            .map((c) => {
              const s = groups.find((x) => x.id === c.id);
              return `
                <button type="button" class="category-tile as-button" data-open-automation="${esc(
                  c.id
                )}">
                  <h3>${esc(c.name)}</h3>
                  <p>${esc(c.description || '')}</p>
                  <p class="muted">${fmt(s?.total || 0)} messages · ${
                    s?.deliveryRate == null ? '—' : `${s.deliveryRate}% delivered`
                  }</p>
                  <div class="blank">${automationBlankLabel(c)}</div>
                </button>`;
            })
            .join('')}
        </div>
      </div>
    `;

    el.root.querySelectorAll('[data-open-automation]').forEach((btn) => {
      btn.addEventListener('click', () =>
        openAutomationGroup(btn.getAttribute('data-open-automation'))
      );
    });
    el.root.querySelector('#new-automation-group')?.addEventListener('click', () => {
      state.automationPresetId = null;
      state.automationBuilderOpen = true;
      renderAutomations();
    });
    el.root.querySelectorAll('[data-create-automation-preset]').forEach((button) => {
      button.addEventListener('click', () => {
        state.automationPresetId = button.getAttribute('data-create-automation-preset');
        state.automationBuilderOpen = true;
        renderAutomations();
        el.root.querySelector('#automation-builder')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      });
    });
    bindAutomationBuilder();
    return;
  }

  setTitle(category.name, `Automations · ${category.description || 'Group workspace'}`);
  el.pager.hidden = false;
  el.status.disabled = false;
  el.search.placeholder = 'Search this group…';

  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
    category: category.id,
  });
  if (state.q) params.set('q', state.q);
  if (state.status) params.set('status', state.status);

  const res = await apiFetch(`/api/messages?${params}`);
  const data = await res.json();
  state.totalPages = data.totalPages || 1;
  renderKpis(data.summary || {});
  renderPager(data);
  el.storeMeta.textContent = `${fmt(data.total)} messages in ${category.name}`;

  let enrollments = [];
  let sequence = null;
  try {
    const enr = await apiFetch(
      `/api/enrollments?category=${encodeURIComponent(category.id)}&pageSize=100`
    ).then((r) => r.json());
    enrollments = enr.enrollments || [];
  } catch {
    enrollments = [];
  }

  try {
    const seqRes = await apiFetch(`/api/automations/${category.id}`).then((r) => r.json());
    sequence = seqRes.sequence || null;
  } catch {
    sequence = null;
  }

  const cadenceNote =
    category.id === 'quote-requests'
      ? 'Cadence: 1 text/day for 3 days, then 1 after 48h, another after 48h, and a final text after 7 days. Messages are saved templates and are delivered without a send-time AI call. Marketing sends stay between 9am and 7pm. A customer reply postpones the next touch for at least 24 hours; a booking, opt-out, manual removal, or final send ends the sequence.'
      : category.id === 'appointment-reminders'
        ? 'Sends one fixed-template SMS ~24 hours before an upcoming appointment without using AI. New bookings enroll automatically, booking changes reschedule the reminder, and cancellations or expired appointments remove it without sending.'
        : category.custom
          ? `${category.rule.firstSendAt ? `First send scheduled for ${fmtTime(category.rule.firstSendAt)}.` : `${cadenceDisplay(category.rule)} cadence.`} ${category.rule.repeatCount} custom message${category.rule.repeatCount === 1 ? '' : 's'} constrained to ${category.rule.startHour}:00–${category.rule.endHour}:00 in the business account timezone. Messages use saved deterministic templates.`
          : '';

  const triggerNote =
    category.kind === 'quote' || category.id === 'quote-requests'
      ? 'Quote created — the contact is enrolled automatically after submitting a quote request. Its saved messages may be drafted as a complete sequence in the dashboard, but every scheduled send is deterministic.'
      : category.kind === 'reminder' || category.id === 'appointment-reminders'
        ? 'Booking created or updated — the reminder is scheduled automatically and uses the fixed template without AI.'
        : category.rule?.trigger
          ? String(category.rule.trigger)
          : 'Contact enrolled manually or through an integration.';

  const sequenceHtml = sequence
    ? `
      <div class="drip-sequence" style="margin:0 16px 16px">
        <h3 style="margin:0 0 8px">${esc(sequence.name)}</h3>
        <p class="muted" style="margin:0 0 12px">${esc(sequence.description || '')}</p>
        <div class="automation-trigger" style="margin:0 0 14px;padding:10px 12px;border:1px solid var(--border);border-radius:10px">
          <strong>Trigger</strong><br><span class="muted">${esc(triggerNote)}</span>
        </div>
        <ol class="drip-steps">
          ${(sequence.steps || [])
            .map(
              (s, i) => `
            <li>
              <div class="drip-step-head"><strong>Step ${i + 1}</strong> · ${esc(s.label || s.id)}</div>
              <div class="muted drip-step-body">${esc(s.template)}</div>
            </li>`
            )
            .join('')}
        </ol>
        ${cadenceNote ? `<p class="muted" style="margin:12px 0 0">${esc(cadenceNote)}</p>` : ''}
        <p class="muted" style="margin:8px 0 0">Group AI: ${category.ai?.enabled ? 'custom instructions enabled' : 'default assistant behavior'}</p>
      </div>`
    : `<div class="blank" style="margin:0 16px 16px">No automations yet in this group</div>`;

  el.root.innerHTML = `
    <div class="automation-subnav card" style="margin-bottom:12px">
      <div class="card-head">
        <div>
          <h2>${esc(category.name)}</h2>
          <p class="muted" style="margin:4px 0 0">${esc(category.description || '')}</p>
        </div>
        <div class="automation-head-actions">
          <button type="button" class="btn ghost" id="edit-group-ai">Inbound reply AI</button>
          ${category.custom||(category.kind==='quote'||category.id==='quote-requests') ? '<button type="button" class="btn ghost" id="edit-automation-group">Edit messages</button>' : ''}
          ${category.custom ? '<button type="button" class="btn danger" id="delete-automation-group">Delete</button>' : ''}
          <button type="button" class="btn ghost" id="back-automations">All groups</button>
        </div>
      </div>
      ${state.aiBuilderOpen ? groupAiBuilderHtml(category) : ''}
      ${state.automationBuilderOpen && (category.custom||category.kind==='quote'||category.id==='quote-requests') ? automationBuilderHtml(category) : ''}
      <div class="subcat-chips">
        ${state.categories
          .map(
            (c) => `
          <button type="button" class="chip ${c.id === category.id ? 'active' : ''}" data-open-automation="${esc(
            c.id
          )}">${esc(c.name)}</button>`
          )
          .join('')}
      </div>
      ${sequenceHtml}
      <div class="card-head" style="border-top:1px solid var(--border)">
        <h2>Enrolled contacts</h2>
        <span class="muted">${fmt(enrollments.length)}${
          category.id === 'appointment-reminders' ? ' enrolled' : ' SMS-consented'
        }</span>
      </div>
      <div class="table-scroll" style="max-height:320px">
        <table class="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Source</th>
              <th>Enrolled</th>
              <th>Drip</th>
              <th>Next send</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${
              enrollments.length
                ? enrollments
                    .map((e) => {
                      const drip = e.metadata?.drip || null;
                      const stepTotal =
                        category.id === 'appointment-reminders'
                          ? 1
                          : category.id === 'quote-requests'
                            ? 6
                            : category.custom
                              ? category.rule?.repeatCount || null
                              : null;
                      const dripLabel = drip
                        ? `${esc(drip.status || '—')}${
                            drip.stepIndex != null && stepTotal != null
                              ? ` · step ${Number(drip.stepIndex) + 1}/${stepTotal}`
                              : drip.stepIndex != null
                                ? ` · step ${Number(drip.stepIndex) + 1}`
                                : ''
                          }`
                        : 'pending seed';
                      return `
              <tr>
                <td>${esc(e.name || '—')}</td>
                <td>${esc(e.phone || '—')}</td>
                <td class="muted">${esc(e.source || '—')}</td>
                <td class="muted">${esc(fmtTime(e.enrolled_at))}</td>
                <td class="muted">${dripLabel}</td>
                <td class="muted">${esc(drip?.nextSendAt ? fmtTime(drip.nextSendAt) : '—')}</td>
                <td>
                  <button type="button" class="btn ghost unenroll-btn"
                    data-enrollment-id="${esc(e.id)}"
                    data-phone="${esc(e.phone || '')}"
                    data-category="${esc(e.category_id || category.id)}">Remove</button>
                </td>
              </tr>`;
                    })
                    .join('')
                : `<tr><td colspan="7"><div class="empty">${
                    category.id === 'appointment-reminders'
                      ? 'No enrollments yet. New bookings with a valid future date auto-enroll.'
                      : 'No enrollments yet. Enroll consented contacts from Contacts.'
                  }</div></td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>
    ${messagesTable(data.messages || [])}
  `;

  el.root.querySelector('#back-automations')?.addEventListener('click', () => openAutomationGroup(null));
  el.root.querySelector('#edit-automation-group')?.addEventListener('click', () => {
    state.aiBuilderOpen = false;
    state.automationBuilderOpen = true;
    renderAutomations();
  });
  el.root.querySelector('#edit-group-ai')?.addEventListener('click', () => {
    state.automationBuilderOpen = false;
    state.aiBuilderOpen = true;
    renderAutomations();
  });
  el.root.querySelector('#delete-automation-group')?.addEventListener('click', async () => {
    if (!confirm(`Delete “${category.name}”? Existing enrollments will be removed.`)) return;
    const response = await apiFetch(`/api/automation-groups/${encodeURIComponent(category.id)}`, {
      method: 'DELETE',
    });
    const json = await response.json();
    if (!response.ok) {
      alert(json.detail || json.error || 'Could not delete group');
      return;
    }
    state.categories = [];
    state.categoryId = null;
    state.automationBuilderOpen = false;
    await load();
  });
  el.root.querySelectorAll('[data-open-automation]').forEach((btn) => {
    btn.addEventListener('click', () => openAutomationGroup(btn.getAttribute('data-open-automation')));
  });
  bindUnenrollButtons();
  bindAutomationBuilder(category.custom||category.kind==='quote'||category.id==='quote-requests' ? category : null);
  bindGroupAiBuilder(category);
  bindMessageRows(data.messages || []);
}

async function renderMessaging() {
  setTitle(...titles.messaging);
  el.pager.hidden = false;
  el.status.disabled = true;
  el.search.placeholder = 'Search conversations…';

  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  if (state.q) params.set('q', state.q);
  if (state.unreadOnly) params.set('unread', '1');

  const listRes = await apiFetch(`/api/conversations?${params}`);
  const list = await listRes.json();
  state.totalPages = list.totalPages || 1;
  renderPager(list);

  el.kpi.innerHTML = [
    kpiCard('Conversations', list.total || 0),
    kpiCard('Unread', list.unreadTotal || 0),
  ].join('');
  el.storeMeta.textContent = `${fmt(list.total)} conversations · ${fmt(list.unreadTotal || 0)} unread`;

  const conversations = list.conversations || [];
  if (
    state.conversationPhone &&
    !conversations.some((c) => c.phone === state.conversationPhone) &&
    !state.q
  ) {
    // keep selection even if not on this page
  } else if (!state.conversationPhone && conversations[0]) {
    state.conversationPhone = conversations[0].phone;
  }

  let thread = null;
  let voiceCalls = [];
  if (state.conversationPhone) {
    const [detail, callsRes] = await Promise.all([
      apiFetch(`/api/conversations/${encodeURIComponent(state.conversationPhone)}`).then((r) =>
        r.json()
      ),
      apiFetch(`/api/conversations/${encodeURIComponent(state.conversationPhone)}/calls`).then((r) =>
        r.json()
      ),
    ]);
    thread = detail.conversation || null;
    voiceCalls = Array.isArray(callsRes?.calls) ? callsRes.calls : [];
    if (thread?.unreadCount) {
      await apiFetch(`/api/conversations/${encodeURIComponent(state.conversationPhone)}/read`, {
        method: 'POST',
      });
      thread.unreadCount = 0;
      const match = conversations.find((c) => c.phone === state.conversationPhone);
      if (match) match.unreadCount = 0;
    }
  }

  el.root.innerHTML = `
    <div class="messaging">
      <div class="inbox card">
        <div class="card-head">
          <h2>Inbox</h2>
          <label class="unread-toggle">
            <input type="checkbox" id="unread-only" ${state.unreadOnly ? 'checked' : ''} />
            Unread only
          </label>
        </div>
        <div class="inbox-list">
          ${
            conversations.length
              ? conversations
                  .map((c) => {
                    const active = c.phone === state.conversationPhone ? 'active' : '';
                    const unread = c.unreadCount > 0 ? 'unread' : '';
                    const preview =
                      c.lastDirection === 'inbound'
                        ? c.lastBody || '(empty)'
                        : `You: ${c.lastBody || '(empty)'}`;
                    return `
              <button type="button" class="inbox-item ${active} ${unread}" data-phone="${esc(
                      c.phone
                    )}">
                <div class="inbox-top">
                  <strong>${esc(c.name || c.phone)}</strong>
                  <span class="muted">${esc(fmtTimeShort(c.lastMessageAt))}</span>
                </div>
                ${c.name ? `<div class="muted inbox-phone">${esc(c.phone)}</div>` : ''}
                <div class="inbox-preview">${esc(preview)}</div>
                ${
                  c.unreadCount
                    ? `<span class="badge">${fmt(c.unreadCount)}</span>`
                    : ''
                }
              </button>`;
                  })
                  .join('')
              : `<div class="empty">No conversations yet. Inbound replies and outbound SMS will appear here.</div>`
          }
        </div>
      </div>
      <div class="thread card">
        ${
          thread
            ? `
          <div class="card-head thread-head">
            <div>
              <h2>${esc(thread.name || thread.phone)}</h2>
              <p class="muted">${esc(thread.phone)} · ${fmt(thread.messageCount)} messages${
                thread.aiPausedAt ? ' · AI paused' : ''
              }</p>
            </div>
            <div class="thread-actions">
              <button type="button" class="btn btn-ghost" id="ai-pause-btn">
                ${thread.aiPausedAt ? 'Resume AI' : 'Pause AI'}
              </button>
            </div>
          </div>
          <div class="thread-scroll" id="thread-scroll">
            ${(thread.messages || [])
              .map(
                (m) => `
              <div class="bubble ${m.direction === 'inbound' ? 'in' : 'out'}${
                  m.meta?.role === 'assistant' ? ' ai' : ''
                }">
                <div class="bubble-meta">
                  <span>${
                    m.direction === 'inbound'
                      ? 'Customer'
                      : m.meta?.role === 'assistant'
                        ? 'AI'
                        : 'Opek'
                  }</span>
                  ${
                    m.meta?.role === 'assistant'
                      ? `<span class="ai-pill">Gradient</span>`
                      : ''
                  }
                  <span>${esc(fmtTime(m.createdAt))}</span>
                  ${
                    m.direction === 'outbound'
                      ? `<span class="status ${esc(m.deliverability)}">${esc(
                          m.deliverability
                        )}</span>`
                      : ''
                  }
                </div>
                <div class="bubble-body">${esc(m.body || '(empty)')}</div>
              </div>`
              )
              .join('') || `<div class="empty">No messages in this thread.</div>`}
          </div>
          ${voiceCallsPanel(voiceCalls)}
          <form class="reply-box" id="reply-form">
            <textarea id="reply-body" rows="2" placeholder="${
              thread.optedOut ? 'Contact opted out — opt in before sending' : 'Reply via SMS…'
            }" maxlength="1600" ${thread.optedOut ? 'disabled' : ''}></textarea>
            <button type="submit" class="btn" ${thread.optedOut ? 'disabled' : ''}>Send</button>
          </form>
          <p class="reply-hint muted" id="reply-hint">${
            thread.optedOut
              ? 'This number is opted out. Use Opt-Outs or the contact drawer to opt them back in.'
              : ''
          }</p>
        `
            : `<div class="empty">Select a conversation to view the thread.</div>`
        }
      </div>
    </div>
  `;

  el.root.querySelector('#unread-only')?.addEventListener('change', (e) => {
    state.unreadOnly = e.target.checked;
    state.page = 1;
    load();
  });

  el.root.querySelectorAll('[data-phone]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.conversationPhone = btn.getAttribute('data-phone');
      load();
    });
  });

  const scroll = el.root.querySelector('#thread-scroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;

  el.root.querySelector('#ai-pause-btn')?.addEventListener('click', async () => {
    if (!state.conversationPhone) return;
    const paused = Boolean(thread?.aiPausedAt);
    const path = paused ? 'resume' : 'pause';
    try {
      const res = await apiFetch(
        `/api/conversations/${encodeURIComponent(state.conversationPhone)}/ai/${path}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'crm_pause' }),
        }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail || json.error || 'AI pause failed');
      await load();
    } catch (err) {
      const hint = el.root.querySelector('#reply-hint');
      if (hint) hint.textContent = err.message || 'Failed to update AI pause';
    }
  });

  const form = el.root.querySelector('#reply-form');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const textarea = el.root.querySelector('#reply-body');
    const hint = el.root.querySelector('#reply-hint');
    const body = textarea?.value.trim() || '';
    if (!body || !state.conversationPhone) return;
    hint.textContent = 'Sending…';
    try {
      const res = await apiFetch(
        `/api/conversations/${encodeURIComponent(state.conversationPhone)}/reply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ body }),
        }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail || json.error || 'Send failed');
      textarea.value = '';
      hint.textContent = '';
      await load();
    } catch (err) {
      hint.textContent = err.message || 'Failed to send';
    }
  });
}

async function renderMessages() {
  el.search.placeholder = 'Search phone, body, SID…';
  setTitle(...titles.messages);
  state.categoryId = null;

  el.pager.hidden = false;
  el.status.disabled = false;

  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  if (state.q) params.set('q', state.q);
  if (state.status) params.set('status', state.status);

  const res = await apiFetch(`/api/messages?${params}`);
  const data = await res.json();
  state.totalPages = data.totalPages || 1;
  renderKpis(data.summary || {});
  renderPager(data);
  el.storeMeta.textContent = `${fmt(data.total)} matching messages`;
  el.root.innerHTML = messagesTable(data.messages || []);
  bindMessageRows(data.messages || []);
}

async function renderContacts() {
  setTitle(...titles.contacts);
  el.pager.hidden = false;
  el.status.disabled = true;
  el.search.placeholder = 'Search name, phone, email…';

  if (state.contactTab === 'activity') {
    await renderLocalContacts();
    return;
  }

  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  if (state.q) params.set('q', state.q);
  if (state.sourceFilter) params.set('source', state.sourceFilter);
  if (state.consentedOnly) params.set('consented', '1');

  const res = await apiFetch(`/api/directory?${params}`);
  const data = await res.json();
  state.totalPages = data.totalPages || 1;
  renderPager(data);

  const rows = data.contacts || [];
  const consentedCount = rows.filter((c) => c.canEnroll || c.smsMarketingConsent === true).length;
  el.kpi.innerHTML = [
    kpiCard('Contacts', data.configured === false ? '—' : data.total ?? rows.length),
    kpiCard('SMS consent (this page)', consentedCount),
  ].join('');
  el.storeMeta.textContent = data.configured
    ? `${fmt(data.total ?? rows.length)} contacts`
    : 'No contacts yet.';

  el.root.innerHTML = `
    <div class="card">
      <div class="card-head contact-tabs">
        <div class="subcat-chips" style="padding:0">
          <button type="button" class="chip active" data-contact-tab="directory">Contacts</button>
          <button type="button" class="chip" data-contact-tab="activity">SMS activity</button>
        </div>
        <div class="contact-filters">
          <label class="unread-toggle">
            <input type="checkbox" id="consented-only" ${state.consentedOnly ? 'checked' : ''} />
            Has SMS consent
          </label>
          <select id="source-filter" aria-label="Contact type">
            <option value="">All contact types</option>
            ${[
              ['prebooking', 'Lead'],
              ['booking', 'Appointment'],
              ['contact', 'Inquiry'],
              ['phone_agent', 'Phone contact'],
              ['customer', 'Customer'],
            ]
              .map(
                ([s, label]) =>
                  `<option value="${s}" ${state.sourceFilter === s ? 'selected' : ''}>${label}</option>`
              )
              .join('')}
          </select>
        </div>
      </div>
      <p class="muted directory-note">
        Choose an automation group to enroll a contact. Sending SMS requires consent.
      </p>
      ${
        data.configured === false
          ? `<div class="empty">${esc(
              'No contacts yet.'
            )}</div>`
          : `
      <div class="table-scroll">
        <table class="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Contact type</th>
              <th>Consent</th>
              <th>Enrolled</th>
              <th>Automation group</th>
              <th>Message</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows.length
                ? rows
                    .map((c) => {
                      const canEnroll = c.canEnroll || c.smsMarketingConsent === true;
                      return `
              <tr class="contact-row" data-name="${esc(
                        c.name || ''
                      )}">
                <td>${esc(c.name || '—')}</td>
                <td>${esc(c.phone || '—')}</td>
                <td class="muted">${esc((c.sources || [c.primarySource]).filter(Boolean).map(contactTypeLabel).join(', '))}</td>
                <td>${
                  c.smsMarketingConsent === true
                    ? '<span class="consent ok">Yes</span>'
                    : c.smsMarketingConsent === false
                      ? '<span class="consent out">No</span>'
                      : '<span class="muted">n/a</span>'
                }</td>
                <td class="muted wrap">
                  ${
                    (c.enrollments || []).length
                      ? (c.enrollments || [])
                          .map((id) => {
                            const label =
                              state.categories.find((x) => x.id === id)?.name || id;
                            return `<span class="enrolled-chip">
                      ${esc(label)}
                      <button type="button" class="unenroll-x unenroll-btn" title="Remove"
                        data-phone="${esc(c.phone)}" data-category="${esc(id)}">×</button>
                    </span>`;
                          })
                          .join(' ')
                      : '—'
                  }
                </td>
                <td>
                  <div class="enroll-row">
                    <select class="enroll-select" data-phone="${esc(c.phone)}" data-name="${esc(
                      c.name || ''
                    )}" data-source="${esc(c.primarySource || '')}" data-email="${esc(
                      c.email || ''
                    )}">
                      <option value="">Choose group…</option>
                      ${state.categories
                        .filter(
                          (cat) =>
                            cat.activeAutomation !== false &&
                            (canEnroll || cat.id === 'appointment-reminders')
                        )
                        .map(
                          (cat) =>
                            `<option value="${esc(cat.id)}" ${
                              (c.enrollments || []).includes(cat.id) ? 'disabled' : ''
                            }>${esc(cat.name)}${
                              (c.enrollments || []).includes(cat.id) ? ' (enrolled)' : ''
                            }</option>`
                        )
                        .join('')}
                    </select>
                    <button type="button" class="btn ghost enroll-btn">Enroll</button>
                  </div>
                </td>
                <td>
                  ${
                    canEnroll
                      ? `<button type="button" class="btn ghost message-btn"
                      data-phone="${esc(c.phone)}"
                      data-name="${esc(c.name || '')}">Message</button>`
                      : `<span class="muted">—</span>`
                  }
                </td>
              </tr>`;
                    })
                    .join('')
                : `<tr><td colspan="7"><div class="empty">No contacts found.</div></td></tr>`
            }
          </tbody>
        </table>
      </div>`
      }
    </div>
  `;

  el.root.querySelectorAll('[data-contact-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.contactTab = btn.getAttribute('data-contact-tab');
      state.page = 1;
      load();
    });
  });
  el.root.querySelector('#source-filter')?.addEventListener('change', (e) => {
    state.sourceFilter = e.target.value;
    state.page = 1;
    load();
  });
  el.root.querySelector('#consented-only')?.addEventListener('change', (e) => {
    state.consentedOnly = e.target.checked;
    state.page = 1;
    load();
  });
  el.root.querySelectorAll('.enroll-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const row = btn.closest('tr');
      const select = row?.querySelector('.enroll-select');
      const phone = select?.getAttribute('data-phone');
      const categoryId = select?.value;
      if (!phone || !categoryId) return;
      let appointmentDate = null;
      let preferredTime = null;
      if (categoryId === 'appointment-reminders') {
        appointmentDate = window.prompt('Appointment date (YYYY-MM-DD)');
        if (!appointmentDate) return;
        preferredTime = window.prompt(
          'Preferred time or window (optional, for example "morning 8-12")'
        );
      }
      btn.disabled = true;
      try {
        const res = await apiFetch('/api/directory/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone,
            categoryId,
            name: select.getAttribute('data-name') || null,
            email: select.getAttribute('data-email') || null,
            source: select.getAttribute('data-source') || null,
            appointmentDate,
            preferredTime: preferredTime || null,
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.detail || json.error || 'Enroll failed');
        await load();
      } catch (err) {
        alert(err.message || 'Failed to enroll');
        btn.disabled = false;
      }
    });
  });
  bindUnenrollButtons();
  el.root.querySelectorAll('.message-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      openMessageComposer({
        phone: btn.getAttribute('data-phone'),
        name: btn.getAttribute('data-name') || '',
      });
    });
  });
}

function openMessageComposer({ phone, name }) {
  openDrawer(
    'Custom SMS',
    `
    <div class="compose">
      <div class="kv">
        <div class="row"><div class="k">To</div><div class="v">${esc(name || phone)}</div></div>
        <div class="row"><div class="k">Phone</div><div class="v" id="compose-phone">${esc(
          phone
        )}</div></div>
      </div>
      <label class="compose-label" for="compose-category">Optional automation group</label>
      <select id="compose-category">
        <option value="">None</option>
        ${state.categories
          .map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`)
          .join('')}
      </select>
      <label class="compose-label" for="compose-body">Message</label>
      <textarea id="compose-body" rows="6" maxlength="1600" placeholder="Write your SMS…"></textarea>
      <div class="compose-actions">
        <span class="muted" id="compose-count">0 / 1600</span>
        <button type="button" class="btn" id="compose-send">Send SMS</button>
      </div>
      <p class="muted" id="compose-hint"></p>
    </div>
  `
  );

  const body = el.drawerBody.querySelector('#compose-body');
  const count = el.drawerBody.querySelector('#compose-count');
  const hint = el.drawerBody.querySelector('#compose-hint');
  const sendBtn = el.drawerBody.querySelector('#compose-send');

  body?.addEventListener('input', () => {
    count.textContent = `${body.value.length} / 1600`;
  });

  sendBtn?.addEventListener('click', async () => {
    const text = body?.value.trim() || '';
    const categoryId = el.drawerBody.querySelector('#compose-category')?.value || null;
    if (!text) {
      hint.textContent = 'Enter a message first.';
      return;
    }
    sendBtn.disabled = true;
    hint.textContent = 'Sending…';
    try {
      const res = await apiFetch('/api/directory/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, body: text, categoryId, name: name || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail || json.error || 'Send failed');
      hint.textContent = 'Queued for sending';
      body.value = '';
      count.textContent = '0 / 1600';
      setTimeout(() => {
        closeDrawer();
        state.view = 'messaging';
        state.conversationPhone = json.to || phone;
        setActiveNav();
        load();
      }, 700);
    } catch (err) {
      hint.textContent = err.message || 'Failed to send';
      sendBtn.disabled = false;
    }
  });
}

function bindUnenrollButtons() {
  el.root.querySelectorAll('.unenroll-btn').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const phone = btn.getAttribute('data-phone');
      const categoryId = btn.getAttribute('data-category');
      const enrollmentId = btn.getAttribute('data-enrollment-id');
      if (!enrollmentId && (!phone || !categoryId)) return;
      if (!confirm('Remove this contact from the automation group?')) return;
      btn.disabled = true;
      try {
        const res = await apiFetch('/api/directory/unenroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ phone, categoryId, enrollmentId }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.detail || json.error || 'Remove failed');
        await load();
      } catch (err) {
        alert(err.message || 'Failed to remove enrollment');
        btn.disabled = false;
      }
    });
  });
}

async function renderLocalContacts() {
  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  if (state.q) params.set('q', state.q);
  if (state.contactStatus) params.set('status', state.contactStatus);

  const res = await apiFetch(`/api/contacts?${params}`);
  const data = await res.json();
  state.totalPages = data.totalPages || 1;
  renderPager(data);
  el.kpi.innerHTML = [
    kpiCard('Contacts', data.contactTotal ?? data.total ?? 0),
    kpiCard('Active', data.activeTotal ?? 0),
    kpiCard('Opted out', data.optedOutTotal ?? 0),
  ].join('');
  el.storeMeta.textContent = `${fmt(data.total)} SMS activity contacts`;

  const rows = data.contacts || [];
  el.root.innerHTML = `
    <div class="card">
      <div class="card-head contact-tabs">
        <div class="subcat-chips" style="padding:0">
          <button type="button" class="chip" data-contact-tab="directory">Contacts</button>
          <button type="button" class="chip active" data-contact-tab="activity">SMS activity</button>
        </div>
        <select id="contact-status" aria-label="Consent filter">
          <option value="">All consent</option>
          <option value="active" ${state.contactStatus === 'active' ? 'selected' : ''}>Active</option>
          <option value="opted_out" ${
            state.contactStatus === 'opted_out' ? 'selected' : ''
          }>Opted out</option>
        </select>
      </div>
      <div class="table-scroll">
        <table class="data">
          <thead>
            <tr>
              <th>Phone</th>
              <th>Name</th>
              <th>Consent</th>
              <th>Messages</th>
              <th>Last status</th>
              <th>Last activity</th>
            </tr>
          </thead>
          <tbody>
            ${
              rows.length
                ? rows
                    .map(
                      (c) => `
              <tr data-contact="${esc(c.phone)}" data-name="${esc(c.name || '')}" class="contact-row">
                <td>${esc(c.phone)}</td>
                <td class="muted">${esc(c.name || '—')}</td>
                <td>${consentBadge(c)}</td>
                <td>${fmt(c.messageCount)}</td>
                <td><span class="status ${esc(c.lastDeliverability || '')}">${esc(
                        c.lastDeliverability || '—'
                      )}</span></td>
                <td class="muted">${esc(fmtTime(c.lastMessageAt))}</td>
              </tr>`
                    )
                    .join('')
                : `<tr><td colspan="6"><div class="empty">No SMS activity contacts yet.</div></td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  el.root.querySelectorAll('[data-contact-tab]').forEach((btn) => {
    btn.addEventListener('click', () => {
      state.contactTab = btn.getAttribute('data-contact-tab');
      state.page = 1;
      load();
    });
  });
  el.root.querySelector('#contact-status')?.addEventListener('change', (e) => {
    state.contactStatus = e.target.value;
    state.page = 1;
    load();
  });
  bindContactRows(rows);
}

async function renderOptOuts() {
  setTitle(...titles.optouts);
  el.pager.hidden = false;
  el.status.disabled = true;
  el.search.placeholder = 'Search opted-out numbers…';

  const params = new URLSearchParams({
    page: String(state.page),
    pageSize: String(state.pageSize),
  });
  if (state.q) params.set('q', state.q);

  const res = await apiFetch(`/api/opt-outs?${params}`);
  const data = await res.json();
  state.totalPages = data.totalPages || 1;
  renderPager(data);
  el.kpi.innerHTML = [
    kpiCard('Opted out', data.total || 0),
    kpiCard('Active contacts', data.activeTotal ?? 0),
    kpiCard('All contacts', data.contactTotal ?? 0),
  ].join('');
  el.storeMeta.textContent = `${fmt(data.total)} opted-out numbers`;

  const rows = data.contacts || [];
  el.root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Opt-out list</h2>
        <span class="muted">STOP / UNSUBSCRIBE / CANCEL / END / QUIT</span>
      </div>
      <div class="table-scroll">
        <table class="data">
          <thead>
            <tr>
              <th>Phone</th>
              <th>Name</th>
              <th>Keyword</th>
              <th>Source</th>
              <th>Opted out at</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            ${
              rows.length
                ? rows
                    .map(
                      (c) => `
              <tr data-contact="${esc(c.phone)}">
                <td>${esc(c.phone)}</td>
                <td class="muted">${esc(c.name || '—')}</td>
                <td><code>${esc((c.optOutKeyword || '—').toUpperCase())}</code></td>
                <td class="muted">${esc(c.optOutSource || '—')}</td>
                <td class="muted">${esc(fmtTime(c.optedOutAt))}</td>
                <td>
                  <button type="button" class="btn ghost opt-in-btn" data-opt-in="${esc(
                    c.phone
                  )}">Opt back in</button>
                </td>
              </tr>`
                    )
                    .join('')
                : `<tr><td colspan="6"><div class="empty">No opt-outs yet. Customer STOP replies will appear here.</div></td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>
  `;

  el.root.querySelectorAll('[data-opt-in]').forEach((btn) => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const phone = btn.getAttribute('data-opt-in');
      const evidence = prompt('Record how and when this contact agreed to receive SMS:');
    if (!evidence?.trim()) return;
    const response = await apiFetch(`/api/contacts/${encodeURIComponent(phone)}/opt-in`, { method: 'POST', body: JSON.stringify({ evidence }) });
    if (!response.ok) { alert((await response.json()).error || 'Could not record consent'); return; }
      await load();
    });
  });

  bindContactRows(rows);
}

function bindContactRows(rows) {
  el.root.querySelectorAll('[data-contact]').forEach((row) => {
    row.addEventListener('click', (e) => {
      if (e.target.closest('button, select, a, input')) return;
      const contact = rows.find(c => c.phone === row.getAttribute('data-contact'));
      if (contact) openDrawer(contact.name || contact.phone, contactDetail(contact));
    });
  });
}

function consentBadge(c) {
  if (c.optedOut) {
    return `<span class="consent out">Opted out</span>`;
  }
  return `<span class="consent ok">Active</span>`;
}

async function renderDeliverability() {
  setTitle(...titles.deliverability);
  el.pager.hidden = true;
  el.status.disabled = true;

  const [res,operationsRes] = await Promise.all([apiFetch('/api/deliverability'),apiFetch('/api/operations')]);
  const data = await res.json(),operations=operationsRes.ok?await operationsRes.json():{},grounded=operations.grounded||{};
  const estimatedUsd = value => value == null ? 'Rate not set' : `$${(Number(value)/1000000).toFixed(4)}`;
  renderKpis(data);
  el.storeMeta.textContent = `${fmt(data.total)} messages tracked`;

  const counts = data.counts || {};
  const keys = Object.keys(counts).filter((k) => counts[k] > 0);
  el.root.innerHTML = `
    <div class="card">
      <div class="card-head"><h2>Status breakdown</h2></div>
      <div class="facet-grid">
        ${
          keys.length
            ? keys
                .map(
                  (k) => `
          <div class="facet">
            <div class="n">${fmt(counts[k])}</div>
            <div class="l">${esc(k)}</div>
          </div>`
                )
                .join('')
            : `<div class="empty" style="grid-column:1/-1">No deliverability data yet.</div>`
        }
      </div>
    </div>
    <div class="card" style="margin-top:16px">
      <div class="card-head"><div><span class="eyebrow">Grounded AI operations</span><h2>Knowledge, handoffs, and compliance</h2></div></div>
      <div class="facet-grid">
        <div class="facet"><div class="n">${fmt(grounded.ingestionFailures||0)}</div><div class="l">Ingestion failures</div></div>
        <div class="facet"><div class="n">${fmt(grounded.retrievalMisses||0)}</div><div class="l">Retrieval misses · 30d</div></div>
        <div class="facet"><div class="n">${fmt(grounded.aiValidationFailures||0)}</div><div class="l">AI validation failures · 30d</div></div>
        <div class="facet"><div class="n">${Math.round(Number(grounded.handoffRate||0)*100)}%</div><div class="l">Handoff rate · 30d</div></div>
        <div class="facet"><div class="n">${fmt(grounded.aiUsage?.runs||0)}</div><div class="l">AI runs this month</div></div>
        <div class="facet"><div class="n">${estimatedUsd(grounded.aiUsage?.estimatedCostMicros)}</div><div class="l">Estimated AI cost · month</div></div>
        <div class="facet"><div class="n">${estimatedUsd(grounded.smsUsage?.estimatedCostMicros)}</div><div class="l">Estimated SMS cost · month</div></div>
        <div class="facet"><div class="n">${fmt(grounded.smsUsage?.segments||0)}</div><div class="l">SMS segments · month</div></div>
        <div class="facet"><div class="n">${fmt(grounded.responseLatencyP95Ms||0)}ms</div><div class="l">AI latency p95 · 30d</div></div>
        <div class="facet"><div class="n">${fmt(grounded.deliveryFailures||0)}</div><div class="l">Delivery failures · 30d</div></div>
        <div class="facet"><div class="n">${esc(grounded.registration?.state||'not started')}</div><div class="l">Twilio registration</div></div>
      </div>
      <div class="table-wrap"><table><thead><tr><th>Queue</th><th>Backlog</th><th>Oldest age</th><th>Failed</th></tr></thead><tbody>${(grounded.queues||[]).map(q=>`<tr><td>${esc(q.queue)}</td><td>${fmt(q.backlog)}</td><td>${q.oldest_age_seconds==null?'—':fmt(q.oldest_age_seconds)+'s'}</td><td>${fmt(q.failed)}</td></tr>`).join('')||'<tr><td colspan="4" class="empty">No grounded-AI queue activity.</td></tr>'}</tbody></table></div>
    </div>
  `;
}

function messagesTable(messages) {
  return `
    <div class="card">
      <div class="table-scroll">
        <table class="data">
          <thead>
            <tr>
              <th>Deliverability</th>
              <th>To</th>
              <th>Category</th>
              <th>Preview</th>
              <th>SID</th>
              <th>Updated</th>
            </tr>
          </thead>
          <tbody>
            ${
              messages.length
                ? messages
                    .map((m) => {
                      const cat =
                        state.categories.find((c) => c.id === m.categoryId)?.name ||
                        m.categoryId ||
                        '—';
                      return `
                  <tr data-id="${esc(m.id)}">
                    <td><span class="status ${esc(m.deliverability)}">${esc(
                        m.deliverability
                      )}</span></td>
                    <td>${esc(m.to || '—')}</td>
                    <td class="muted">${esc(cat)}</td>
                    <td class="wrap muted">${esc(m.body || '—')}</td>
                    <td class="muted">${esc(m.sid || m.id)}</td>
                    <td class="muted">${esc(fmtTime(m.updatedAt || m.createdAt))}</td>
                  </tr>`;
                    })
                    .join('')
                : `<tr><td colspan="6"><div class="empty">No messages match these filters.</div></td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>
  `;
}

function bindMessageRows(messages) {
  const byId = new Map(messages.map((m) => [m.id, m]));
  el.root.querySelectorAll('[data-id]').forEach((row) => {
    row.addEventListener('click', () => {
      const msg = byId.get(row.getAttribute('data-id'));
      if (msg) openDrawer('Message', messageDetail(msg));
    });
  });
}

function messageDetail(m) {
  const cat =
    state.categories.find((c) => c.id === m.categoryId)?.name || m.categoryId || '—';
  return `
    <div class="kv">
      <div class="row"><div class="k">Deliverability</div><div class="v"><span class="status ${esc(
        m.deliverability
      )}">${esc(m.deliverability)}</span></div></div>
      <div class="row"><div class="k">To</div><div class="v">${esc(m.to || '—')}</div></div>
      <div class="row"><div class="k">From</div><div class="v">${esc(m.from || '—')}</div></div>
      <div class="row"><div class="k">Category</div><div class="v">${esc(cat)}</div></div>
      <div class="row"><div class="k">Body</div><div class="v">${esc(m.body || '—')}</div></div>
      <div class="row"><div class="k">SID</div><div class="v">${esc(m.sid || m.id)}</div></div>
      <div class="row"><div class="k">Error</div><div class="v">${esc(
        m.errorCode ? `${m.errorCode} ${m.errorMessage || ''}` : '—'
      )}</div></div>
      <div class="row"><div class="k">Created</div><div class="v">${esc(fmtTime(m.createdAt))}</div></div>
      <div class="row"><div class="k">Updated</div><div class="v">${esc(fmtTime(m.updatedAt))}</div></div>
      <div class="row">
        <div class="k">Status history</div>
        <div class="timeline">
          ${(m.statusHistory || [])
            .map(
              (h) =>
                `<div class="item"><strong>${esc(h.status)}</strong> · ${esc(fmtTime(h.at))}${
                  h.errorCode ? ` · err ${esc(h.errorCode)}` : ''
                }</div>`
            )
            .join('') || '<div class="item muted">No history</div>'}
        </div>
      </div>
    </div>
  `;
}

function contactDetail(c) {
  if (!c) return `<div class="empty">Contact not found</div>`;
  return `
    <div class="kv">
      <div class="row"><div class="k">Phone</div><div class="v">${esc(
        c.phone
      )}</div></div>
      <div class="row"><div class="k">Name</div><div class="v">${esc(
        c.name || '—'
      )}</div></div>
      <div class="row"><div class="k">Consent</div><div class="v">${consentBadge(c)}</div></div>
      <div class="row"><div class="k">Opt-out keyword</div><div class="v">${esc(
        c.optOutKeyword ? c.optOutKeyword.toUpperCase() : '—'
      )}</div></div>
      <div class="row"><div class="k">Opted out at</div><div class="v">${esc(
        fmtTime(c.optedOutAt)
      )}</div></div>
      <div class="row"><div class="k">Messages</div><div class="v">${fmt(c.messageCount)} · ${fmt(
        c.inboundCount || 0
      )} in / ${fmt(c.outboundCount || 0)} out</div></div>
      <div class="row"><div class="k">Last status</div><div class="v"><span class="status ${esc(
        c.lastDeliverability || ''
      )}">${esc(c.lastDeliverability || '—')}</span></div></div>
      <div class="row"><div class="k">Recent messages</div>
        <div class="timeline">
          ${(c.messages || [])
            .slice(0, 20)
            .map(
              (m) =>
                `<div class="item"><span class="status ${esc(m.deliverability)}">${esc(
                  m.deliverability
                )}</span> · ${esc(m.direction)} · ${esc(m.body || '(empty)')}</div>`
            )
            .join('') || '<div class="item muted">No messages</div>'}
        </div>
      </div>
      <div class="row">
        <div class="k">Actions</div>
        <div class="v contact-actions">
          ${
            c.optedOut
              ? `<button type="button" class="btn" id="drawer-opt-in">Opt back in</button>`
              : `<button type="button" class="btn ghost" id="drawer-opt-out">Mark opted out</button>`
          }
          <button type="button" class="btn ghost" id="drawer-open-thread">Open thread</button>
        </div>
      </div>
    </div>
  `;
}


function renderKpis(summary) {
  const c = summary.counts || {};
  el.kpi.innerHTML = [
    kpiCard('Total SMS', summary.total || 0),
    kpiCard('Conversations', summary.conversationCount || summary.contactCount || 0),
    kpiCard('Opted out', summary.optedOutTotal || 0),
    kpiCard('Delivered', c.delivered || 0),
    kpiCard('Delivery rate', summary.deliveryRate == null ? '—' : `${summary.deliveryRate}%`),
  ].join('');
}

function kpiCard(label, value) {
  const notes = {
    'Total SMS': 'Across all channels',
    Conversations: 'Customer threads',
    'Opted out': 'Suppressed contacts',
    Delivered: 'Confirmed by carrier',
    'Delivery rate': 'Successful delivery',
    Groups: 'Configured workspaces',
    'Automation SMS': 'Sequence activity',
  };
  return `<article class="kpi"><div class="label">${esc(label)}</div><div class="value">${esc(
    value
  )}</div><p>${esc(notes[label] || 'Current total')}</p></article>`;
}

function renderPager(data) {
  el.pageInfo.textContent = `Page ${data.page || 1} of ${data.totalPages || 1} · ${fmt(
    data.total || 0
  )} rows`;
  el.prev.disabled = (data.page || 1) <= 1;
  el.next.disabled = (data.page || 1) >= (data.totalPages || 1);
}

function setTitle(title, sub) {
  el.title.textContent = title;
  el.sub.textContent = sub;
  if (el.toolbarSection) el.toolbarSection.textContent = title;
}

function openDrawer(title, html) {
  drawerReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  el.drawer.hidden = false;
  if (el.drawerBackdrop) {
    el.drawerBackdrop.hidden = false;
    el.drawerBackdrop.tabIndex = 0;
  }
  document.querySelector('.crm').classList.add('drawer-open');
  syncOverlayLock();
  el.drawerTitle.textContent = title;
  el.drawerBody.innerHTML = html;
  requestAnimationFrame(() => document.getElementById('drawer-close')?.focus());

  el.drawerBody.querySelector('#drawer-opt-in')?.addEventListener('click', async () => {
    const phone = el.drawerBody.querySelector('.kv .v')?.textContent;
    if (!phone) return;
    const evidence = prompt('Record how and when this contact agreed to receive SMS:');
    if (!evidence?.trim()) return;
    const response = await apiFetch(`/api/contacts/${encodeURIComponent(phone)}/opt-in`, { method: 'POST', body: JSON.stringify({ evidence }) });
    if (!response.ok) { alert((await response.json()).error || 'Could not record consent'); return; }
    closeDrawer();
    await load();
  });
  el.drawerBody.querySelector('#drawer-opt-out')?.addEventListener('click', async () => {
    const phone = el.drawerBody.querySelector('.kv .v')?.textContent;
    if (!phone) return;
    await apiFetch(`/api/contacts/${encodeURIComponent(phone)}/opt-out`, { method: 'POST' });
    closeDrawer();
    await load();
  });
  el.drawerBody.querySelector('#drawer-open-thread')?.addEventListener('click', () => {
    const phone = el.drawerBody.querySelector('.kv .v')?.textContent;
    if (!phone) return;
    state.view = 'messaging';
    state.conversationPhone = phone;
    state.page = 1;
    closeDrawer();
    setActiveNav();
    load();
  });
}

function closeDrawer() {
  if (el.drawer.hidden) return;
  el.drawer.hidden = true;
  if (el.drawerBackdrop) {
    el.drawerBackdrop.hidden = true;
    el.drawerBackdrop.tabIndex = -1;
  }
  document.querySelector('.crm').classList.remove('drawer-open');
  syncOverlayLock();
  drawerReturnFocus?.focus?.();
  drawerReturnFocus = null;
}

function fmt(n) {
  return Number(n || 0).toLocaleString();
}

function fmtTime(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

function fmtTimeShort(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    const now = new Date();
    if (d.toDateString() === now.toDateString()) {
      return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  } catch {
    return iso;
  }
}

function fmtDuration(secs) {
  const n = Number(secs);
  if (!Number.isFinite(n) || n < 0) return '';
  const m = Math.floor(n / 60);
  const s = Math.round(n % 60);
  if (m <= 0) return `${s}s`;
  return `${m}m ${s}s`;
}

function voiceCallsPanel(calls) {
  const list = Array.isArray(calls) ? calls : [];
  if (!list.length) {
    return `
      <details class="calls-panel">
        <summary>Voice calls <span class="muted">0</span></summary>
        <div class="empty calls-empty">No stored calls for this number yet.</div>
      </details>`;
  }

  return `
    <details class="calls-panel" open>
      <summary>Voice calls <span class="muted">${fmt(list.length)}</span></summary>
      <div class="calls-list">
        ${list
          .map((c) => {
            const status = c.status || 'unknown';
            const dir = c.direction || 'outbound';
            const when = fmtTime(c.started_at || c.created_at);
            const dur = fmtDuration(c.duration_secs);
            const success = c.call_successful ? ` · ${c.call_successful}` : '';
            const turns = Array.isArray(c.transcript) ? c.transcript : [];
            const transcriptHtml = turns.length
              ? turns
                  .map((t) => {
                    const role = String(t.role || t.speaker || 'unknown');
                    const text = t.message || t.text || t.content || '';
                    if (!text) return '';
                    return `<div class="call-turn"><span class="muted">${esc(
                      role
                    )}</span> ${esc(text)}</div>`;
                  })
                  .filter(Boolean)
                  .join('')
              : `<div class="muted">No transcript yet${
                  status === 'pending' ? ' (call in progress or awaiting webhook)' : ''
                }.</div>`;

            return `
          <details class="call-item">
            <summary>
              <span class="call-item-main">
                <strong>${esc(dir)}</strong>
                <span class="status ${esc(status)}">${esc(status)}</span>
                ${dur ? `<span class="muted">${esc(dur)}</span>` : ''}
                <span class="muted">${esc(success)}</span>
              </span>
              <span class="muted call-item-when">${esc(when)}</span>
            </summary>
            ${
              c.summary
                ? `<p class="call-summary">${esc(c.summary)}</p>`
                : ''
            }
            <div class="call-transcript">${transcriptHtml}</div>
          </details>`;
          })
          .join('')}
      </div>
    </details>`;
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

async function forceLogin(message = '') {
  renderLoginScreen({
    errorMessage: message,
    onSuccess: async () => {
      await loadTenantContext();
      updateAuthChrome();
      await load();
      connectLive();
    },
  });
}

function updateAuthChrome() {
  const emailEl = document.getElementById('auth-email');
  const email = isDemoMode() ? 'Demo preview · sample data' : getSession()?.user?.email || '';
  if (emailEl) emailEl.textContent = email;
  const tenant = state.tenant;
  if (tenant && el.toolbarTenant) el.toolbarTenant.textContent = tenant.shortName || tenant.name;
  if (tenant && el.tenantAvatar) {
    el.tenantAvatar.textContent = String(tenant.shortName || tenant.name || 'BA')
      .split(/\s+/)
      .map((part) => part[0])
      .join('')
      .slice(0, 2)
      .toUpperCase();
  }
  if (tenant) document.title = `${tenant.shortName || tenant.name} · SMS CRM`;
  syncSidebarBrand();
  initNavFind();
}

async function loadTenantContext() {
  const response = await apiFetch('/api/tenants', { tenant: false });
  if (!response.ok) throw new Error('Could not load business accounts');
  const data = await response.json();
  state.tenants = Array.isArray(data.tenants) ? data.tenants : [];
  const stored = getTenantId();
  state.tenant = state.tenants.find((tenant) => tenant.id === stored) || data.currentTenant || state.tenants[0];
  if (!state.tenant) throw new Error('No business account is configured');
  setTenantId(state.tenant.id);
  if (el.tenantSelect) {
    el.tenantSelect.innerHTML = state.tenants
      .map((tenant) => `<option value="${esc(tenant.id)}">${esc(tenant.name)}</option>`)
      .join('');
    el.tenantSelect.value = state.tenant.id;
  }
}

document.getElementById('sign-out-btn')?.addEventListener('click', async () => {
  await signOut();
  await forceLogin('');
});

async function boot() {
  try {
    const auth = await initAuth();
    if (auth.demo) {
      await loadTenantContext();
      showCrmApp();
      updateAuthChrome();
      document.getElementById('demo-banner').hidden = false;
      document.getElementById('sign-out-btn').hidden = true;
      document.getElementById('clerk-organization-switcher').hidden = true;
      setLiveStatus(false, 'Sample data');
      installDemoActionGuard();
      await load();
      return;
    }
    const token = await getAccessToken();
    if (!token) {
      await forceLogin('');
      return;
    }
    const me = await apiFetch('/api/auth/me', { tenant: false });
    if (!me.ok) {
      await signOut();
      await forceLogin('This account does not have access to this business workspace.');
      return;
    }
    await loadTenantContext();
    showCrmApp();
    updateAuthChrome();
    await load();
    connectLive();
  } catch (err) {
    console.error(err);
    await forceLogin(err.message || 'Auth failed to start');
  }
}

function installDemoActionGuard() {
  const selector = 'button[type="submit"], #call-place, #ai-pause-btn, #compose-send, #save-automation-group, #save-group-ai, #delete-automation-group, #drawer-opt-in, #drawer-opt-out, .enroll-btn, .unenroll-btn, [data-opt-in], [data-enrollment-id]';
  const disableActions = () => {
    document.querySelectorAll(selector).forEach(button => {
      if (button.disabled) return;
      button.disabled = true;
      button.title = 'Read-only demo: changes, SMS, and calls are disabled';
    });
  };
  new MutationObserver(disableActions).observe(document.getElementById('crm-app'), { childList: true, subtree: true });
  document.getElementById('crm-app').addEventListener('submit', event => {
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
  disableActions();
}

boot();

function setLiveStatus(online, label) {
  const pill = document.getElementById('live-pill');
  if (!pill) return;
  pill.classList.toggle('live', online);
  pill.classList.toggle('offline', !online);
  pill.textContent = label;
}

function connectLive() {
  if (globalThis.SMS_CONFIG?.apiBase) {
    connectSupabaseLive(() => refreshFromBackground().catch(() => {}), setLiveStatus).catch(() => setLiveStatus(false, 'Live updates unavailable'));
    return;
  }
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  let ws;
  let retryMs = 1000;
  let refreshTimer = null;
  let pollTimer = null;

  const scheduleRefresh = (evt) => {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      // Keep an open thread snappy when its phone matches
      if (
        state.view === 'messaging' &&
        state.conversationPhone &&
        evt?.record?.contactPhone &&
        String(evt.record.contactPhone).replace(/\D/g, '').slice(-10) ===
          String(state.conversationPhone).replace(/\D/g, '').slice(-10)
      ) {
        refreshFromBackground().catch(() => {});
        return;
      }
      if (
        state.view === 'messaging' &&
        state.conversationPhone &&
        evt?.type === 'thread' &&
        evt?.record?.phone &&
        String(evt.record.phone).replace(/\D/g, '').slice(-10) ===
          String(state.conversationPhone).replace(/\D/g, '').slice(-10)
      ) {
        refreshFromBackground().catch(() => {});
        return;
      }
      refreshFromBackground().catch(() => {});
    }, 250);
  };

  const startPollFallback = () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => refreshFromBackground().catch(() => {}), 15000);
  };
  const stopPollFallback = () => {
    if (!pollTimer) return;
    clearInterval(pollTimer);
    pollTimer = null;
  };

  const open = async () => {
    const token = await getAccessToken().catch(() => null);
    if (!token) {
      setLiveStatus(false, 'Sign in required');
      return;
    }
    ws = new WebSocket(
      `${proto}//${location.host}/ws?tenant_id=${encodeURIComponent(getTenantId())}`,
      ['opek-sms-v1', `auth.${token}`]
    );
    ws.addEventListener('open', () => {
      retryMs = 1000;
      setLiveStatus(true, 'Live');
      stopPollFallback();
    });
    ws.addEventListener('message', (e) => {
      let msg;
      try {
        msg = JSON.parse(e.data);
      } catch {
        return;
      }
      if (!msg?.type || msg.type === 'connected' || msg.type === 'pong') return;
      if (msg.type === 'message' || msg.type === 'thread' || msg.type === 'enrollment') {
        scheduleRefresh(msg);
      }
    });
    ws.addEventListener('close', () => {
      setLiveStatus(false, 'Reconnecting…');
      startPollFallback();
      setTimeout(() => open().catch(() => {}), retryMs);
      retryMs = Math.min(retryMs * 1.6, 15000);
    });
    ws.addEventListener('error', () => {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    });
  };

  open().catch(() => startPollFallback());
  setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(JSON.stringify({ type: 'ping' }));
      } catch {
        /* ignore */
      }
    }
  }, 25000);
}
