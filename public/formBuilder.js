import {createFormTest} from './formTest.js?v=20261004-live-test';
const PRESETS = [
  ['contacts', 'Contact'],
  ['quote_requests', 'Quote Request'],
  ['bookings', 'Booking'],
];
const TYPES = [['text', 'Short text'], ['textarea', 'Long text'], ['select', 'Dropdown'], ['checkbox', 'Checkbox'], ['date', 'Date']];
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);

export function embedSnippet(form, config = globalThis.SMS_CONFIG || {}) {
  const base = (config.embedBaseUrl || location.origin).replace(/\/$/, '');
  const source = `${base}/embed.html?form=${encodeURIComponent(form.public_id)}`;
  return `<iframe data-sms-web-form title="${escapeHtml(form.title)}" src="${source}" style="width:100%;height:720px;border:0" loading="lazy"></iframe>\n<script async src="${base}/embed-resize.js"></script>`;
}

export function createFormBuilder({ root, apiFetch, config, canReadSubmissions = () => true, formId = null, hideSubmissions = false }) {
  let preset = 'contacts';
  let page = 1;
  let draft = null;
  let canEdit = false;
  let consentText = '';
  let timeZone = '';
  let tester;

  function rowsMarkup(fields) {
    return fields.map((field, index) => `<div class="web-builder-field" data-field-index="${index}">
      <div class="web-builder-field-head"><strong>Custom field ${index + 1}</strong>
        <div><button type="button" class="btn ghost" data-move-up="${index}" ${index ? '' : 'disabled'} aria-label="Move field up">↑</button>
        <button type="button" class="btn ghost" data-move-down="${index}" ${index < fields.length - 1 ? '' : 'disabled'} aria-label="Move field down">↓</button>
        <button type="button" class="btn ghost" data-remove-field="${index}">Remove</button></div></div>
      <div class="web-builder-field-grid">
        <label>Label <input data-field-label maxlength="100" value="${escapeHtml(field.label)}" required /></label>
        <label>Type <select data-field-type>${TYPES.map(([value, label]) => `<option value="${value}" ${field.type === value ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
        <label class="checkbox-field"><input type="checkbox" data-field-required ${field.required ? 'checked' : ''} /> Required</label>
        ${field.type === 'select' ? `<label class="web-builder-options">Dropdown options, one per line<textarea data-field-options rows="3">${escapeHtml((field.options || []).join('\n'))}</textarea></label>` : ''}
      </div></div>`).join('');
  }

  function readFields() {
    draft.fields = [...root.querySelectorAll('[data-field-index]')].map((row, index) => ({
      key: draft.fields[index].key,
      label: row.querySelector('[data-field-label]').value.trim(),
      type: row.querySelector('[data-field-type]').value,
      required: row.querySelector('[data-field-required]').checked,
      ...(row.querySelector('[data-field-options]') ? {
        options: row.querySelector('[data-field-options]').value.split('\n').map(value => value.trim()).filter(Boolean),
      } : {}),
    }));
  }

  function preview() {
    if (!tester) return;
    readFields();
    tester.render();
  }

  function bindFields() {
    const host = root.querySelector('#web-builder-fields');
    host.innerHTML = rowsMarkup(draft.fields);
    host.querySelectorAll('[data-move-up],[data-move-down],[data-remove-field]').forEach(button => button.addEventListener('click', () => {
      readFields();
      const index = Number(button.dataset.moveUp ?? button.dataset.moveDown ?? button.dataset.removeField);
      if (button.hasAttribute('data-remove-field')) draft.fields.splice(index, 1);
      else {
        const other = button.hasAttribute('data-move-up') ? index - 1 : index + 1;
        [draft.fields[index], draft.fields[other]] = [draft.fields[other], draft.fields[index]];
      }
      bindFields(); preview();
    }));
    host.querySelectorAll('[data-field-type]').forEach(select => select.addEventListener('change', () => {
      readFields();
      const field = draft.fields[Number(select.closest('[data-field-index]').dataset.fieldIndex)];
      if (field.type === 'select' && !field.options) field.options = ['Option 1'];
      if (field.type !== 'select') delete field.options;
      bindFields(); preview();
    }));
    host.querySelectorAll('input,textarea').forEach(input => input.addEventListener('input', preview));
    preview();
  }

  async function submissions() {
    const host = root.querySelector('#web-form-submissions');
    if(!canReadSubmissions()){host.textContent='Submission access requires SMS-read permission.';return;}
    const response = await apiFetch(`/api/web-forms/${preset}/submissions?page=${page}&pageSize=50`);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not load form submissions');
    const entries = (data.rows || []).map(row => {
      const labels = new Map((row.field_snapshot || draft.fields || []).map(field => [field.key, field.label]));
      const answers = Object.entries(row.details || {}).map(([key, value]) =>
        `<div><strong>${escapeHtml(labels.get(key) || key)}:</strong> ${escapeHtml(typeof value === 'boolean' ? (value ? 'Yes' : 'No') : value)}</div>`).join('');
      return `<tr><td>${escapeHtml(row.name)}</td><td>${escapeHtml(row.email)}</td><td>${escapeHtml(row.phone)}</td>
        <td>${escapeHtml(row.enrollment_status || row.intake_state || '—')}${row.skip_reason ? ` · ${escapeHtml(row.skip_reason)}` : ''}</td>
        <td>${escapeHtml(new Date(row.submitted_at).toLocaleString())}</td>
        <td><details><summary>View</summary>${row.appointment_at ? `<div><strong>Appointment:</strong> ${escapeHtml(new Date(row.appointment_at).toLocaleString())}</div>` : ''}${answers || 'No custom answers'}</details></td></tr>`;
    }).join('');
    host.innerHTML = `<div class="table-scroll"><table class="data"><thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Automation</th><th>Submitted</th><th>Answers</th></tr></thead>
      <tbody>${entries || '<tr><td colspan="6">No submissions yet.</td></tr>'}</tbody></table></div>
      <div class="web-builder-pagination"><button type="button" class="btn ghost" data-page="prev" ${page <= 1 ? 'disabled' : ''}>Previous</button>
      <span>Page ${page} of ${data.totalPages || 1} · ${data.total || 0} submissions</span>
      <button type="button" class="btn ghost" data-page="next" ${page >= (data.totalPages || 1) ? 'disabled' : ''}>Next</button></div>`;
    host.querySelectorAll('[data-page]').forEach(button => button.addEventListener('click', async () => {
      page += button.dataset.page === 'next' ? 1 : -1;
      await submissions();
    }));
  }

  async function render(data) {
    if (!data) {
      const response = await apiFetch('/api/web-forms');
      data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Could not load Web Forms');
    }
    canEdit = Boolean(data.canEdit);
    consentText = data.consentText || '';
    timeZone = data.timeZone || '';
    const form = data.forms?.find(item => formId ? item.public_id === formId : item.preset === preset);
    if (!form) throw new Error('This business has no Web Forms definition');
    draft = structuredClone(form);
    canEdit = canEdit && !form.archived;
    preset = form.public_id;
    const snippet = embedSnippet(form, config);
    root.innerHTML = `<div id="web-builder-panel" role="tabpanel" aria-label="${escapeHtml(form.title)} form settings">
      <div class="web-builder-layout"><section class="card"><div class="card-head"><div><h2>${escapeHtml(form.title)} form</h2>
      <span class="muted">Edit the form your customers will see.</span></div></div>
      <div class="web-builder-body"><label>Form title<input id="web-form-title" maxlength="120" value="${escapeHtml(form.title)}" ${canEdit ? '' : 'disabled'} /></label>
      <label>Description<textarea id="web-form-description" maxlength="500" rows="2" ${canEdit ? '' : 'disabled'}>${escapeHtml(form.description)}</textarea></label>
      <label>Button label<input id="web-form-button" maxlength="80" value="${escapeHtml(form.button_label)}" ${canEdit ? '' : 'disabled'} /></label>
      <label class="checkbox-field"><input id="web-form-enabled" type="checkbox" ${form.enabled ? 'checked' : ''} ${canEdit ? '' : 'disabled'} /> Form enabled</label>
      <label class="checkbox-field"><input id="web-form-email-enabled" type="checkbox" ${form.email_enabled ? 'checked' : ''} ${canEdit && form.legacy_form ? '' : 'disabled'} /> Offer separate email marketing consent on this form</label>
      <h3>Fixed fields</h3><p class="muted">Name, Phone, Email${draft?.preset === 'bookings' ? ', Appointment date and time' : ''}, and optional SMS consent stay on this form. Email marketing has its own unchecked consent choice when enabled.</p>
      <h3>Custom fields</h3><div id="web-builder-fields"></div>
      ${canEdit ? '<button type="button" class="btn ghost" id="web-add-field">Add custom field</button><div class="web-builder-actions"><span id="web-save-status" role="status"></span><button type="button" class="btn" id="web-save-form">Save form</button></div>' : '<p class="muted">An administrator can edit this form.</p>'}
      </div></section><aside class="card"><div class="card-head"><div><h2>Preview &amp; test</h2><span class="muted">Try your form, preview its schedule or send a real SMS test</span></div></div><div id="web-builder-preview" class="web-builder-preview"></div></aside></div>
      ${canEdit ? `<section class="card web-builder-embed"><div class="card-head"><div><h2>Embed code</h2><span class="muted">Paste this snippet into any website. No URL allowlist is used during testing.</span></div></div>
      <div class="web-builder-body"><textarea id="web-embed-code" rows="4" readonly>${escapeHtml(snippet)}</textarea><button type="button" class="btn ghost" id="web-copy-embed">Copy code</button></div></section>` : ''}
      <section class="card web-builder-embed"><div class="card-head"><h2>Submissions</h2></div><div id="web-form-submissions" class="web-builder-body" role="status">Loading submissions…</div></section></div>`;
    const selectPreset = async type => {
      preset = type; page = 1; await render();
      root.querySelector(`[data-web-preset="${type}"]`)?.focus();
    };
    root.querySelectorAll('[data-web-preset]').forEach(button => {
      button.addEventListener('click', () => selectPreset(button.dataset.webPreset));
      button.addEventListener('keydown', event => {
        const index = PRESETS.findIndex(([type]) => type === button.dataset.webPreset);
        const next = event.key === 'ArrowRight' ? (index + 1) % PRESETS.length
          : event.key === 'ArrowLeft' ? (index + PRESETS.length - 1) % PRESETS.length
          : event.key === 'Home' ? 0 : event.key === 'End' ? PRESETS.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault();
        selectPreset(PRESETS[next][0]);
      });
    });
    if (canEdit) {
      root.querySelector('#web-add-field').addEventListener('click', () => {
        readFields();
        if (draft.fields.length >= 20) return;
        draft.fields.push({ key: `field_${crypto.randomUUID().replaceAll('-', '').slice(0, 12)}`, label: 'New field', type: 'text', required: false });
        bindFields();
      });
      root.querySelector('#web-save-form').addEventListener('click', async event => {
        readFields();
        const status = root.querySelector('#web-save-status'); status.textContent = '';
        event.currentTarget.disabled = true;
        try {
          const payload = { title: root.querySelector('#web-form-title').value.trim(),
            description: root.querySelector('#web-form-description').value.trim(),
            buttonLabel: root.querySelector('#web-form-button').value.trim(),
            enabled: root.querySelector('#web-form-enabled').checked,
            emailEnabled: root.querySelector('#web-form-email-enabled').checked, fields: draft.fields };
          const saved = await apiFetch(`/api/web-forms/${preset}`, { method: 'PUT', body: JSON.stringify(payload) });
          const body = await saved.json();
          if (!saved.ok) throw new Error(body.error || 'Could not save form');
          await render();
          root.querySelector('#web-save-status').textContent = payload.enabled ? 'Saved and live' : 'Draft saved';
        } catch (error) { status.textContent = error.message; event.currentTarget.disabled = false; }
      });
      root.querySelector('#web-copy-embed').addEventListener('click', async event => {
        await navigator.clipboard.writeText(root.querySelector('#web-embed-code').value);
        event.currentTarget.textContent = 'Copied';
      });
    }
    root.querySelectorAll('#web-form-title,#web-form-description,#web-form-button,#web-form-email-enabled').forEach(input => input.addEventListener('input', preview));
    tester = createFormTest({root:root.querySelector('#web-builder-preview'),apiFetch,timeZone,consentText,canTest:canReadSubmissions(),canSend:data.canManageAutomation&&!form.archived,getForm:()=>({...draft,title:root.querySelector('#web-form-title').value,description:root.querySelector('#web-form-description').value})});
    bindFields();
    if (!canEdit) root.querySelectorAll('#web-builder-fields input,#web-builder-fields select,#web-builder-fields textarea,#web-builder-fields button').forEach(input => input.disabled = true);
    if (!hideSubmissions) await submissions(); else root.querySelector('#web-form-submissions')?.closest('section')?.remove();
  }

  return { render };
}
