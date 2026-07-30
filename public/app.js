const state = {
  view: 'overview',
  categoryId: null,
  q: '',
  status: '',
  page: 1,
  pageSize: 50,
  totalPages: 1,
  categories: [],
  selected: null,
  conversationPhone: null,
  unreadOnly: false,
  contactStatus: '',
  contactTab: 'directory',
  sourceFilter: '',
  consentedOnly: false,
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
  drawerTitle: document.getElementById('drawer-title'),
  drawerBody: document.getElementById('drawer-body'),
  storeMeta: document.getElementById('store-meta'),
};

const titles = {
  overview: ['Overview', 'Pipeline health across all SMS traffic'],
  messaging: ['Messaging', 'Inbox of customer responses and conversations'],
  messages: ['Messages', 'Searchable CRM log for every SMS'],
  contacts: ['Contacts', 'Leads from Opek site — quotes, bookings, forms, phone agent'],
  optouts: ['Opt-Outs', 'Numbers that asked to stop receiving SMS'],
  deliverability: ['Deliverability', 'Delivery outcomes across the message store'],
  automations: ['Automations', 'SMS automation groups and blank workflows'],
};

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
  load();
});

document.getElementById('refresh').addEventListener('click', () => load());
document.getElementById('drawer-close').addEventListener('click', closeDrawer);

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
  try {
    if (!state.categories.length) {
      const catRes = await fetch('/api/categories');
      const catJson = await catRes.json();
      state.categories = catJson.categories || [];
      renderNavAutomations();
    }

    if (state.view === 'overview') await renderOverview();
    else if (state.view === 'messaging') await renderMessaging();
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
  state.page = 1;
  setActiveNav();
  load();
}

async function renderOverview() {
  setTitle('Overview', 'Pipeline health across all SMS traffic');
  el.pager.hidden = true;
  el.status.disabled = true;

  const res = await fetch('/api/overview');
  const data = await res.json();
  renderKpis(data);
  el.storeMeta.textContent = `${fmt(data.total)} messages · ${fmt(
    data.conversationCount || data.contactCount || 0
  )} conversations · ${fmt(data.optedOutTotal || 0)} opted out`;

  el.root.innerHTML = `
    <div class="card">
      <div class="card-head">
        <h2>Automation groups</h2>
        <span class="muted">Open Automations for group workspaces</span>
      </div>
      <div class="category-grid">
        ${state.categories
          .map((c) => {
            const s = data.byCategory?.find((x) => x.id === c.id);
            return `
              <button type="button" class="category-tile as-button" data-open-automation="${esc(
                c.id
              )}">
                <h3>${esc(c.name)}</h3>
                <p>${esc(c.description || '')}</p>
                <p class="muted">${fmt(s?.total || 0)} messages · ${
                  s?.deliveryRate == null ? '—' : `${s.deliveryRate}% delivered`
                }</p>
                <div class="blank">No automations yet</div>
              </button>`;
          })
          .join('')}
      </div>
    </div>
  `;

  el.root.querySelectorAll('[data-open-automation]').forEach((btn) => {
    btn.addEventListener('click', () => openAutomationGroup(btn.getAttribute('data-open-automation')));
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

    const res = await fetch('/api/overview');
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
          <h2>Automation groups</h2>
          <span class="muted">Sub-categories — workflows blank until wired</span>
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
                  <div class="blank">No automations yet</div>
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

  const res = await fetch(`/api/messages?${params}`);
  const data = await res.json();
  state.totalPages = data.totalPages || 1;
  renderKpis(data.summary || {});
  renderPager(data);
  el.storeMeta.textContent = `${fmt(data.total)} messages in ${category.name}`;

  let enrollments = [];
  try {
    const enr = await fetch(
      `/api/enrollments?category=${encodeURIComponent(category.id)}&pageSize=100`
    ).then((r) => r.json());
    enrollments = enr.enrollments || [];
  } catch {
    enrollments = [];
  }

  el.root.innerHTML = `
    <div class="automation-subnav card" style="margin-bottom:12px">
      <div class="card-head">
        <div>
          <h2>${esc(category.name)}</h2>
          <p class="muted" style="margin:4px 0 0">${esc(category.description || '')}</p>
        </div>
        <button type="button" class="btn ghost" id="back-automations">All groups</button>
      </div>
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
      <div class="blank" style="margin:0 16px 16px">No automations yet in this group</div>
      <div class="card-head" style="border-top:1px solid var(--border)">
        <h2>Enrolled contacts</h2>
        <span class="muted">${fmt(enrollments.length)} SMS-consented</span>
      </div>
      <div class="table-scroll" style="max-height:240px">
        <table class="data">
          <thead>
            <tr><th>Name</th><th>Phone</th><th>Source</th><th>Enrolled</th><th></th></tr>
          </thead>
          <tbody>
            ${
              enrollments.length
                ? enrollments
                    .map(
                      (e) => `
              <tr>
                <td>${esc(e.name || '—')}</td>
                <td>${esc(e.phone || '—')}</td>
                <td class="muted">${esc(e.source || '—')}</td>
                <td class="muted">${esc(fmtTime(e.enrolled_at))}</td>
                <td>
                  <button type="button" class="btn ghost unenroll-btn"
                    data-enrollment-id="${esc(e.id)}"
                    data-phone="${esc(e.phone || '')}"
                    data-category="${esc(e.category_id || category.id)}">Remove</button>
                </td>
              </tr>`
                    )
                    .join('')
                : `<tr><td colspan="5"><div class="empty">No enrollments yet. Enroll consented contacts from Contacts.</div></td></tr>`
            }
          </tbody>
        </table>
      </div>
    </div>
    ${messagesTable(data.messages || [])}
  `;

  el.root.querySelector('#back-automations')?.addEventListener('click', () => openAutomationGroup(null));
  el.root.querySelectorAll('[data-open-automation]').forEach((btn) => {
    btn.addEventListener('click', () => openAutomationGroup(btn.getAttribute('data-open-automation')));
  });
  bindUnenrollButtons();
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

  const listRes = await fetch(`/api/conversations?${params}`);
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
  if (state.conversationPhone) {
    const detail = await fetch(
      `/api/conversations/${encodeURIComponent(state.conversationPhone)}`
    ).then((r) => r.json());
    thread = detail.conversation || null;
    if (thread?.unreadCount) {
      await fetch(`/api/conversations/${encodeURIComponent(state.conversationPhone)}/read`, {
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
              <button type="button" class="btn btn-ghost" id="call-btn" ${
                thread.optedOut ? 'disabled' : ''
              }>Call</button>
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
      const res = await fetch(
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

  el.root.querySelector('#call-btn')?.addEventListener('click', async () => {
    if (!state.conversationPhone || thread?.optedOut) return;
    const hint = el.root.querySelector('#reply-hint');
    const btn = el.root.querySelector('#call-btn');
    const who = thread?.name || state.conversationPhone;
    if (!window.confirm(`Place an ElevenLabs outbound call to ${who}? SMS history will be sent to Macy.`)) {
      return;
    }
    if (btn) btn.disabled = true;
    if (hint) hint.textContent = 'Starting outbound call…';
    try {
      const res = await fetch(
        `/api/conversations/${encodeURIComponent(state.conversationPhone)}/call`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: thread?.name || null, pauseAi: true }),
        }
      );
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail || json.error || 'Call failed');
      if (hint) {
        hint.textContent = `Call started${json.call?.callSid ? ` · ${json.call.callSid}` : ''}. SMS AI paused.`;
      }
      await load();
    } catch (err) {
      if (hint) hint.textContent = err.message || 'Failed to start call';
      if (btn) btn.disabled = false;
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
      const res = await fetch(
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

  const res = await fetch(`/api/messages?${params}`);
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

  const res = await fetch(`/api/directory?${params}`);
  const data = await res.json();
  state.totalPages = data.totalPages || 1;
  renderPager(data);

  const rows = data.contacts || [];
  const consentedCount = rows.filter((c) => c.canEnroll || c.smsMarketingConsent === true).length;
  el.kpi.innerHTML = [
    kpiCard('Directory', data.configured === false ? '—' : data.total ?? rows.length),
    kpiCard('Consented (page)', consentedCount),
    kpiCard('Configured', data.supabaseConfigured || data.configured ? 'Yes' : 'No'),
  ].join('');
  el.storeMeta.textContent = data.configured
    ? `${fmt(rows.length)} contacts · enroll only if SMS marketing consent = yes`
    : data.error || 'Connect Supabase to load contacts';

  el.root.innerHTML = `
    <div class="card">
      <div class="card-head contact-tabs">
        <div class="subcat-chips" style="padding:0">
          <button type="button" class="chip active" data-contact-tab="directory">Supabase directory</button>
          <button type="button" class="chip" data-contact-tab="activity">SMS activity</button>
        </div>
        <div class="contact-filters">
          <label class="unread-toggle">
            <input type="checkbox" id="consented-only" ${state.consentedOnly ? 'checked' : ''} />
            Consented only
          </label>
          <select id="source-filter" aria-label="Source filter">
            <option value="">All sources</option>
            ${[
              ['prebooking', 'Quote / prebooking'],
              ['booking', 'Booking'],
              ['contact', 'Contact form'],
              ['in_home_estimate', 'In-home estimate'],
              ['phone_agent', 'Phone agent'],
              ['customer', 'Customers table'],
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
        Consented contacts can be enrolled in automation groups or sent a custom SMS. Not auto-enrolled.
      </p>
      ${
        data.configured === false
          ? `<div class="empty">${esc(
              data.error || 'Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY to pull contacts.'
            )}</div>`
          : `
      <div class="table-scroll">
        <table class="data">
          <thead>
            <tr>
              <th>Name</th>
              <th>Phone</th>
              <th>Source</th>
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
              <tr>
                <td>${esc(c.name || '—')}</td>
                <td>${esc(c.phone || '—')}</td>
                <td class="muted">${esc((c.sources || [c.primarySource]).filter(Boolean).join(', '))}</td>
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
                  ${
                    canEnroll
                      ? `<div class="enroll-row">
                    <select class="enroll-select" data-phone="${esc(c.phone)}" data-name="${esc(
                          c.name || ''
                        )}" data-source="${esc(c.primarySource || '')}" data-email="${esc(
                          c.email || ''
                        )}">
                      <option value="">Choose group…</option>
                      ${state.categories
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
                  </div>`
                      : `<span class="muted">Consent required</span>`
                  }
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
      btn.disabled = true;
      try {
        const res = await fetch('/api/directory/enroll', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            phone,
            categoryId,
            name: select.getAttribute('data-name') || null,
            email: select.getAttribute('data-email') || null,
            source: select.getAttribute('data-source') || null,
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
    btn.addEventListener('click', () => {
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
      const res = await fetch('/api/directory/message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone, body: text, categoryId, name: name || null }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.detail || json.error || 'Send failed');
      hint.textContent = `Sent${json.message?.sid ? ` · ${json.message.sid}` : ''}`;
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
        const res = await fetch('/api/directory/unenroll', {
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

  const res = await fetch(`/api/contacts?${params}`);
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
          <button type="button" class="chip" data-contact-tab="directory">Supabase directory</button>
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
              <tr data-contact="${esc(c.phone)}">
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

  const res = await fetch(`/api/opt-outs?${params}`);
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
      await fetch(`/api/contacts/${encodeURIComponent(phone)}/opt-in`, { method: 'POST' });
      await load();
    });
  });

  bindContactRows(rows);
}

function bindContactRows(rows) {
  const byPhone = new Map(rows.map((c) => [c.phone, c]));
  el.root.querySelectorAll('[data-contact]').forEach((row) => {
    row.addEventListener('click', async (e) => {
      if (e.target.closest('[data-opt-in]')) return;
      const phone = row.getAttribute('data-contact');
      const detail = await fetch(`/api/contacts/${encodeURIComponent(phone)}`).then((r) =>
        r.json()
      );
      openDrawer('Contact', contactDetail(detail.contact || byPhone.get(phone)));
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

  const res = await fetch('/api/deliverability');
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
      <div class="row"><div class="k">Phone</div><div class="v">${esc(c.phone)}</div></div>
      <div class="row"><div class="k">Name</div><div class="v">${esc(c.name || '—')}</div></div>
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
  return `<div class="kpi"><div class="label">${esc(label)}</div><div class="value">${esc(
    value
  )}</div></div>`;
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
}

function openDrawer(title, html) {
  el.drawer.hidden = false;
  document.querySelector('.crm').classList.add('drawer-open');
  el.drawerTitle.textContent = title;
  el.drawerBody.innerHTML = html;

  el.drawerBody.querySelector('#drawer-opt-in')?.addEventListener('click', async () => {
    const phone = el.drawerBody.querySelector('.kv .v')?.textContent;
    if (!phone) return;
    await fetch(`/api/contacts/${encodeURIComponent(phone)}/opt-in`, { method: 'POST' });
    closeDrawer();
    await load();
  });
  el.drawerBody.querySelector('#drawer-opt-out')?.addEventListener('click', async () => {
    const phone = el.drawerBody.querySelector('.kv .v')?.textContent;
    if (!phone) return;
    await fetch(`/api/contacts/${encodeURIComponent(phone)}/opt-out`, { method: 'POST' });
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
  el.drawer.hidden = true;
  document.querySelector('.crm').classList.remove('drawer-open');
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

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

load();
connectLive();

function setLiveStatus(online, label) {
  const pill = document.getElementById('live-pill');
  if (!pill) return;
  pill.classList.toggle('live', online);
  pill.classList.toggle('offline', !online);
  pill.textContent = label;
}

function connectLive() {
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

  const open = () => {
    ws = new WebSocket(`${proto}//${location.host}/ws`);
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
      setTimeout(open, retryMs);
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

  open();
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
