import {normalizePhoneInput} from './phoneInput.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// A simulation never calls the public submission endpoint or changes the form.
export function createFormTest({root, apiFetch, getForm, getSequence, timeZone, canTest = true, consentText}) {
  let values = {}, answers = {}, revision = 0;
  const capture = () => {
    root.querySelectorAll('[data-test-value]').forEach(el => values[el.dataset.testValue] = el.type === 'checkbox' ? el.checked : el.value);
    root.querySelectorAll('[data-test-answer]').forEach(el => answers[el.dataset.testAnswer] = el.type === 'checkbox' ? el.checked : el.value);
  };
  const invalidate = () => {
    revision++;
    const output = root.querySelector('[data-test-results]');
    if (output?.textContent) output.textContent = 'Inputs or rules changed. Run the simulation again to update the result.';
    const button = root.querySelector('[data-test-run]');
    if (button) button.disabled = !canTest;
  };
  const input = (key, label, type = 'text', required = false) => `<label>${esc(label)}<input data-test-value="${key}" type="${type}" ${required ? 'required' : ''} value="${esc(values[key])}" ${type === 'tel' ? 'placeholder="(303) 555-0160" autocomplete="off"' : ''} /></label>`;
  function render() {
    capture(); revision++;
    const form = getForm();
    root.innerHTML = `<form class="form-test" data-test-form>
      <div class="form-test-notice"><strong>Test submission</strong><p>Try sample answers and preview your messages and timing. No texts, leads or automation runs are created.</p></div>
      <h3>${esc(form.title || 'Form preview')}</h3><p>${esc(form.description)}</p>
      <button type="button" class="btn ghost" data-test-sample>Use sample answers</button>
      <div class="form-test-fields">${input('name','Name','text',true)}${input('phone','Phone','tel',true)}<small class="muted">US/Canada numbers automatically use +1. Include the country code for other countries.</small>${input('email','Email','email',true)}
      ${form.preset === 'bookings' ? input('appointmentLocal',`Appointment date and time (${timeZone || 'business time zone'})`,'datetime-local',true) : ''}
      ${(form.fields || []).map(f => {
        const attrs = `data-test-answer="${esc(f.key)}" ${f.required ? 'required' : ''}`;
        const value = answers[f.key];
        return `<label>${esc(f.label)}${f.required ? ' *' : ''}${f.type === 'textarea' ? `<textarea ${attrs} maxlength="2000">${esc(value)}</textarea>` : f.type === 'select' ? `<select ${attrs}><option value="">Choose an option</option>${(f.options || []).map(o => `<option ${value === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>` : `<input ${attrs} type="${f.type === 'checkbox' ? 'checkbox' : f.type === 'date' ? 'date' : 'text'}" ${f.type === 'checkbox' ? (value ? 'checked' : '') : `maxlength="300" value="${esc(value)}"`} />`}</label>`;
      }).join('')}
      <label class="checkbox-field"><input type="checkbox" data-test-value="smsOptIn" ${values.smsOptIn ? 'checked' : ''} /> ${esc(consentText || 'Test customer agrees to receive SMS messages')}</label></div>
      <details class="form-test-options"><summary>Test timing & customer behavior</summary>
        ${input('submittedLocal',`Submission time (${timeZone || 'business time zone'})`,'datetime-local')}
        <small class="muted">Leave blank to start now.</small>
        <label>After the first message<select data-test-value="scenario">${[['none','No reply'],['reply','Customer replies'],['opt_out','Customer sends STOP']].map(([key,label]) => `<option value="${key}" ${values.scenario === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      </details>
      <p class="muted">${getSequence ? 'Uses the rules currently in this editor, including unsaved changes.' : 'Uses your current form fields and saved draft automation rules. Edit rules in the Automation tab.'}</p>
      <button class="btn" type="submit" data-test-run ${canTest ? '' : 'disabled'}>Run simulation</button>
      ${canTest ? '' : '<p class="muted">SMS-read access is required to test automation. You can still try the form fields above.</p>'}
      <div data-test-results role="status" aria-live="polite"></div>
    </form>`;
    root.querySelector('[data-test-form]').oninput = () => { capture(); invalidate(); };
    root.querySelector('[data-test-value="phone"]').onblur = e => {
      try { e.target.value = normalizePhoneInput(e.target.value); capture(); } catch { /* Server returns a useful validation error. */ }
    };
    root.querySelector('[data-test-sample]').onclick = () => {
      values = {...values, name:'Alex Example', phone:'+13035550160', email:'alex@example.test'};
      answers = Object.fromEntries((form.fields || []).map(f => [f.key, f.type === 'checkbox' ? true : f.type === 'select' ? f.options?.[0] || '' : f.type === 'date' ? new Date().toISOString().slice(0,10) : `Sample ${f.label.toLowerCase()}`]));
      // Clear controls before re-render so capture does not overwrite the sample.
      root.innerHTML = ''; render();
    };
    root.querySelector('[data-test-form]').onsubmit = async e => {
      e.preventDefault(); if (!canTest) return;
      capture(); const ticket = ++revision;
      const button = root.querySelector('[data-test-run]'), output = root.querySelector('[data-test-results]');
      button.disabled = true; output.textContent = 'Simulating your rules…';
      try {
        const currentForm = getForm();
        const sample = {...values, details:Object.fromEntries((currentForm.fields || []).filter(f => answers[f.key] !== undefined).map(f => [f.key,answers[f.key]])), smsOptIn:!!values.smsOptIn};
        const response = await apiFetch(`/api/web-forms/${currentForm.public_id}/preview`, {method:'POST', body:JSON.stringify({sample, fields:currentForm.fields, ...(getSequence ? {sequence:getSequence()} : {}), submittedLocal:values.submittedLocal || '', scenario:values.scenario || 'none'})});
        const data = await response.json();
        if (ticket !== revision || !output.isConnected) return;
        if (!response.ok) throw new Error(data.error || 'Could not simulate this form');
        const format = date => new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',timeZone:data.timeZone}).format(new Date(date));
        output.innerHTML = `<div class="form-test-result"><h3>Simulation result</h3><p><strong>${esc(data.outcome)}</strong></p>
          <p>${data.totalSends} configured sends · ${(data.rows || []).length} shown${data.truncated ? ' (preview limit)' : ''}</p>
          ${(data.warnings || []).length ? `<details><summary>Live readiness</summary>${data.warnings.map(w => `<p>${esc(w)}</p>`).join('')}</details>` : ''}
          ${data.rows?.length ? `<p class="muted">Estimated schedule in ${esc(data.timeZone)}. Actual delivery and provider processing can shift send times.</p><ol class="form-test-timeline">${data.rows.map(row => `<li><div><strong>Message ${row.message} · Send ${row.repeat}</strong><time datetime="${esc(row.at)}">${esc(format(row.at))}</time></div><p>${esc(row.body)}</p></li>`).join('')}</ol>` : ''}
          <small class="muted">Preview only. Saving, publishing and enabling are separate actions.</small></div>`;
      } catch (error) { if (ticket === revision && output.isConnected) output.textContent = error.message; }
      finally { if (ticket === revision && button.isConnected) button.disabled = false; }
    };
  }
  return {render, invalidate};
}
