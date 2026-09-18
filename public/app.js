import { connectSupabaseLive } from './live.js';
import {
  apiFetch,
  getAccessToken,
  getSession,
  getTenantId,
  initAuth,
  isDemoMode,
  renderLoginScreen,
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
  aiBuilderOpen: false,
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

function openBusinessSetup(provisioning = {}) {
  const details = provisioning.details || {};
  const senderType = details.senderType || 'local_a2p';
  openDrawer('Complete business setup', `
    <form id="business-setup-form" class="compose">
      <p class="muted">Provide the information needed to choose a phone number and prepare the applicable Twilio registration. Sending remains disabled until Twilio approves the sender.</p>
      <label class="compose-label" for="setup-sender-type">Phone number type</label>
      <select id="setup-sender-type" required>
        <option value="local_a2p" ${senderType === 'local_a2p' ? 'selected' : ''}>US local number · A2P 10DLC</option>
        <option value="toll_free" ${senderType === 'toll_free' ? 'selected' : ''}>US toll-free number · Toll-free verification</option>
      </select>
      <div id="setup-local-fields" class="compose">
        <label class="compose-label" for="setup-brand-type">Business registration type</label>
        <select id="setup-brand-type">
          <option value="standard" ${details.brandType !== 'sole_proprietor' ? 'selected' : ''}>Registered business with EIN</option>
          <option value="sole_proprietor" ${details.brandType === 'sole_proprietor' ? 'selected' : ''}>Sole proprietor</option>
        </select>
        <label class="compose-label" for="setup-area-code">Preferred area code</label>
        <input id="setup-area-code" inputmode="numeric" maxlength="3" pattern="[0-9]{3}" value="${esc(details.areaCode || '')}" placeholder="720" />
      </div>
      <label class="compose-label" for="setup-legal-name">Legal business name</label>
      <input id="setup-legal-name" maxlength="160" required value="${esc(details.legalBusinessName || state.tenant?.name || '')}" autocomplete="organization" />
      <label class="compose-label" for="setup-email">Registration notification email</label>
      <input id="setup-email" type="email" maxlength="320" required value="${esc(details.notificationEmail || getSession()?.user?.email || '')}" autocomplete="email" />
      <label class="compose-label" for="setup-website">Public website</label>
      <input id="setup-website" type="url" maxlength="2048" required value="${esc(details.websiteUrl || '')}" placeholder="https://example.com" />
      <label class="compose-label" for="setup-campaign">How will this business use SMS?</label>
      <textarea id="setup-campaign" minlength="40" maxlength="1500" rows="5" required placeholder="Describe the messages customers will receive and why.">${esc(details.campaignDescription || '')}</textarea>
      <label class="compose-label" for="setup-opt-in">How do customers agree to receive messages?</label>
      <textarea id="setup-opt-in" minlength="40" maxlength="1500" rows="5" required placeholder="Describe the form, checkbox, keyword, or verbal workflow used to collect consent.">${esc(details.optInDescription || '')}</textarea>
      <label class="compose-label" for="setup-samples">Sample messages · one per line</label>
      <textarea id="setup-samples" rows="5" required placeholder="Thanks for contacting Example Business. Reply STOP to opt out.\nYour appointment is confirmed for tomorrow. Reply HELP for help.">${esc((details.sampleMessages || []).join('\n'))}</textarea>
      <p class="muted">After this draft is complete, legal identity and tax information will be entered in Twilio's secure registration form. This CRM does not ask you to store that information here.</p>
      <div class="compose-actions"><span id="setup-error" class="login-error" role="alert"></span>
        <button type="submit" class="btn">Save setup details</button>
      </div>
    </form>`);
  const form = el.drawerBody.querySelector('#business-setup-form');
  const sender = form.querySelector('#setup-sender-type');
  const localFields = form.querySelector('#setup-local-fields');
  const brand = form.querySelector('#setup-brand-type');
  const area = form.querySelector('#setup-area-code');
  const syncSenderFields = () => {
    const local = sender.value === 'local_a2p';
    localFields.hidden = !local; brand.required = local; area.required = local;
  };
  sender.addEventListener('change', syncSenderFields); syncSenderFields();
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const button = form.querySelector('button[type="submit"]');
    const error = form.querySelector('#setup-error');
    const sampleMessages = form.querySelector('#setup-samples').value.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
    error.textContent = ''; button.disabled = true;
    try {
      const response = await apiFetch('/api/provisioning/details', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({
        senderType: sender.value, brandType: brand.value, areaCode: area.value.trim(),
        legalBusinessName: form.querySelector('#setup-legal-name').value.trim(),
        notificationEmail: form.querySelector('#setup-email').value.trim(), websiteUrl: form.querySelector('#setup-website').value.trim(),
        campaignDescription: form.querySelector('#setup-campaign').value.trim(), optInDescription: form.querySelector('#setup-opt-in').value.trim(), sampleMessages,
      }) });
      const data = await response.json(); if(!response.ok) throw new Error(data.error || 'Could not save setup details');
      closeDrawer(); await renderOverview();
    } catch (failure) { error.textContent = failure.message; button.disabled = false; }
  });
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
};

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
  if (parent) parent.classList.toggle('parent-open', onAutomations && Boolean(state.categoryId));
}

async function load() {
  document.getElementById('crm-app').dataset.view = state.view;
  el.search.closest('.search-wrap').hidden = ['overview', 'call', 'deliverability'].includes(state.view);
  el.status.hidden = !['messages', 'deliverability'].includes(state.view) && !(state.view === 'automations' && state.categoryId);
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
      renderNavAutomations();
    }

    if (state.view === 'overview') await renderOverview();
    else if (state.view === 'messaging') await renderMessaging();
    else if (state.view === 'call') await renderCall();
    else if (state.view === 'contacts') await renderContacts();
    else if (state.view === 'optouts') await renderOptOuts();
    else if (state.view === 'deliverability') await renderDeliverability();
    else if (state.view === 'automations') await renderAutomations();
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
      )}">
        ${esc(c.name)}
      </button>`
    )
    .join('');
}

function openAutomationGroup(categoryId = null) {
  state.view = 'automations';
  state.categoryId = categoryId;
  state.automationBuilderOpen = false;
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
        <p class="muted">Details: ${provisioning.detailsComplete ? 'saved · registration submission is next' : 'required'}</p>
        <button type="button" class="btn" data-complete-business-setup>${provisioning.detailsComplete ? 'Review setup details' : 'Complete business setup'}</button>
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
  el.root.querySelector('[data-complete-business-setup]')?.addEventListener('click', () => openBusinessSetup(provisioning));

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
  const rule = group?.rule || {
    cadence: 'daily',
    intervalCount: 1,
    intervalUnit: 'day',
    repeatCount: 3,
    template: 'Hi {{first_name}}, this is a quick follow-up. Reply STOP to opt out.',
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
          <span class="eyebrow">Manual rule</span>
          <h2>${group ? 'Edit custom group' : 'Create custom group'}</h2>
        </div>
        <button type="button" class="btn ghost" id="cancel-automation-builder">Cancel</button>
      </div>
      <div class="automation-form-grid">
        <label class="field-wide">
          <span class="compose-label">Group name</span>
          <input id="automation-name" maxlength="100" required value="${esc(group?.name || '')}" placeholder="Post-job follow-up" />
        </label>
        <label class="field-wide">
          <span class="compose-label">Description</span>
          <input id="automation-description" maxlength="300" value="${esc(group?.description || '')}" placeholder="What this automation is for" />
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
          <input id="automation-repeat-count" type="number" min="1" max="30" value="${esc(rule.repeatCount)}" required />
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
        <button type="submit" class="btn" id="save-automation-group">${group ? 'Save changes' : 'Create group'}</button>
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
  const customInterval = form.querySelector('#custom-interval');
  const repeatCount = form.querySelector('#automation-repeat-count');
  const stepEditor = form.querySelector('#automation-step-editor');
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
        template: rows.at(-1)?.template || 'Hi {{first_name}}, this is a quick follow-up. Reply STOP to opt out.',
      });
    }
    rows.length = desired;
    renderSteps(rows);
  };

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
  form.querySelector('#cancel-automation-builder')?.addEventListener('click', () => {
    state.automationBuilderOpen = false;
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
        startHour: Number(form.querySelector('#automation-start-hour').value),
        endHour: Number(form.querySelector('#automation-end-hour').value),
        template: steps[0]?.template.trim(),
        firstSendAt,
        steps,
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
        <label class="field-wide">
          <span class="compose-label">AI instructions</span>
          <textarea id="group-ai-instructions" maxlength="6000" rows="8" placeholder="Describe the goal, questions to ask, tone, escalation conditions, and facts the AI may use.">${esc(group.ai?.instructions || '')}</textarea>
          <small class="muted">Group instructions supplement platform safety, consent, privacy, and tool restrictions.</small>
        </label>
      </div>
      <div class="automation-builder-actions">
        <span class="login-error" id="group-ai-error"></span>
        <button type="submit" class="btn" id="save-group-ai">Save AI instructions</button>
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
            <span class="muted">System sequences and manual cadence rules</span>
          </div>
          <button type="button" class="btn" id="new-automation-group">Create group</button>
        </div>
        ${state.automationBuilderOpen ? automationBuilderHtml() : ''}
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
      state.automationBuilderOpen = true;
      renderAutomations();
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
      ? 'Cadence: 1 text/day for 3 days, then 1 after 48h, another after 48h, and a final text after 7 days. Marketing sends stay between 9am and 7pm. A customer reply postpones the next touch for at least 24 hours; a booking, opt-out, manual removal, or final send ends the sequence.'
      : category.id === 'appointment-reminders'
        ? 'Sends one SMS ~24 hours before an upcoming appointment. New bookings enroll automatically, booking changes reschedule the reminder, and cancellations or expired appointments remove it without sending.'
        : category.custom
          ? `${category.rule.firstSendAt ? `First send scheduled for ${fmtTime(category.rule.firstSendAt)}.` : `${cadenceDisplay(category.rule)} cadence.`} ${category.rule.repeatCount} custom message${category.rule.repeatCount === 1 ? '' : 's'} constrained to ${category.rule.startHour}:00–${category.rule.endHour}:00 in the business account timezone. Each step can use its own delay and message.`
          : '';

  const sequenceHtml = sequence
    ? `
      <div class="drip-sequence" style="margin:0 16px 16px">
        <h3 style="margin:0 0 8px">${esc(sequence.name)}</h3>
        <p class="muted" style="margin:0 0 12px">${esc(sequence.description || '')}</p>
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
          <button type="button" class="btn ghost" id="edit-group-ai">AI instructions</button>
          ${category.custom ? '<button type="button" class="btn ghost" id="edit-automation-group">Edit rule</button><button type="button" class="btn danger" id="delete-automation-group">Delete</button>' : ''}
          <button type="button" class="btn ghost" id="back-automations">All groups</button>
        </div>
      </div>
      ${state.aiBuilderOpen ? groupAiBuilderHtml(category) : ''}
      ${state.automationBuilderOpen && category.custom ? automationBuilderHtml(category) : ''}
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
  bindAutomationBuilder(category.custom ? category : null);
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

  const res = await apiFetch('/api/deliverability');
  const data = await res.json();
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
    connectSupabaseLive(() => load().catch(() => {}), setLiveStatus).catch(() => setLiveStatus(false, 'Live updates unavailable'));
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
        load().catch(() => {});
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
        load().catch(() => {});
        return;
      }
      load().catch(() => {});
    }, 250);
  };

  const startPollFallback = () => {
    if (pollTimer) return;
    pollTimer = setInterval(() => load().catch(() => {}), 15000);
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
