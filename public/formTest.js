import {normalizePhoneInput} from './phoneInput.js';

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

// A simulation never calls the public submission endpoint or changes the form.
export function createFormTest({root, apiFetch, getForm, getSequence, timeZone, canTest = true, canSend = false, consentText}) {
  let values = {}, answers = {}, revision = 0, liveData, pollTimer, prepared, starting = false;
  const request = async (path, options) => {
    const response = await apiFetch(path,options), data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Could not update this test');
    return data;
  };
  const format = (date, zone = timeZone) => date ? new Intl.DateTimeFormat(undefined,{dateStyle:'medium',timeStyle:'short',...(zone ? {timeZone:zone} : {})}).format(new Date(date)) : '—';
  const payload = () => {
    const form = getForm();
    return {sample:{name:values.name,phone:normalizePhoneInput(values.phone),email:values.email,appointmentLocal:values.appointmentLocal,smsOptIn:!!values.smsOptIn,
      details:Object.fromEntries((form.fields || []).filter(f => answers[f.key] !== undefined).map(f => [f.key,answers[f.key]]))},fields:form.fields,...(getSequence ? {sequence:getSequence()} : {})};
  };
  function showRuns() {
    const host = root.querySelector('[data-live-runs]');if (!host || !liveData) return;
    host.innerHTML = `<div class="form-test-result"><h3>Real SMS tests</h3><p>Connected number: ${esc(liveData.phoneNumber || 'Not connected')} · ${liveData.sendingEnabled ? 'Sending enabled' : 'Sending disabled — scheduled tests wait until sending is enabled'}</p>
      <button type="button" class="btn ghost" data-live-refresh>Refresh delivery status</button>
      ${liveData.runs.length ? liveData.runs.map(run => `<article class="form-live-run"><h4>${esc(run.phone)} · ${esc(run.status === 'completed' ? 'All sends processed' : run.status)}</h4>
        <p>${run.accepted} of ${run.totalSends} accepted by provider · ${run.delivered} delivered</p>
        ${run.notice ? `<p>${esc(run.notice)}</p>` : ''}${run.status === 'active' ? `<p>Next scheduled send: ${esc(format(run.nextSendAt,liveData.timeZone))} (${esc(liveData.timeZone)})</p>` : ''}
        ${canSend && ['active','paused'].includes(run.status) ? `<button type="button" class="btn ghost" data-stop-test="${esc(run.id)}">Stop test</button>` : ''}
        <details><summary>Recent message delivery</summary>${run.messages.map(m => `<p><strong>Message ${m.number} · Send ${m.repeat} · ${esc(m.status)}</strong><br>${esc(m.body)}</p>`).join('') || '<p>No message sent yet. The test follows your delays and sending window.</p>'}</details></article>`).join('') : '<p>No real SMS tests yet.</p>'}
      <small>Tests create contact and message history, but no customer form submissions. Stopping prevents future sends; a message already handed to the provider may still arrive.</small></div>`;
    host.querySelector('[data-live-refresh]').onclick = () => refreshLive();
    host.querySelectorAll('[data-stop-test]').forEach(button => button.onclick = async () => {
      button.disabled = true;
      try { liveData = await request(`/api/web-forms/${getForm().public_id}/test-runs/${button.dataset.stopTest}/stop`,{method:'POST',body:'{}'});showRuns(); }
      catch (error) { button.disabled = false;root.querySelector('[data-live-feedback]').textContent = error.message; }
    });
  }
  async function refreshLive() {
    clearTimeout(pollTimer);if (!root.isConnected || !canTest) return;
    try { liveData = await request(`/api/web-forms/${getForm().public_id}/test-runs`);if (root.isConnected) showRuns(); }
    catch (error) { const feedback = root.querySelector('[data-live-feedback]');if (feedback) feedback.textContent = error.message; }
    if (root.isConnected && liveData?.runs.some(r => r.status === 'active' || r.messages.some(m => ['queued','sending','sent','accepted','pending'].includes(m.status)))) pollTimer = setTimeout(refreshLive,10000);
  }
  const capture = () => {
    root.querySelectorAll('[data-test-value]').forEach(el => values[el.dataset.testValue] = el.type === 'checkbox' ? el.checked : el.value);
    root.querySelectorAll('[data-test-answer]').forEach(el => answers[el.dataset.testAnswer] = el.type === 'checkbox' ? el.checked : el.value);
  };
  const invalidate = () => {
    revision++;
    if (!starting) { prepared = null;const review = root.querySelector('[data-live-review]');if (review) review.innerHTML = ''; }
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
      <div class="form-test-notice"><strong>Test submission</strong><p>${canSend ? 'Send a real test sequence to your mobile number, or preview the schedule without sending.' : 'Preview your messages and timing without sending texts or saving leads.'}</p></div>
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
      <details class="form-test-options"><summary>Simulation timing & customer behavior</summary>
        ${input('submittedLocal',`Submission time (${timeZone || 'business time zone'})`,'datetime-local')}
        <small class="muted">Leave blank to start now.</small>
        <label>After the first message<select data-test-value="scenario">${[['none','No reply'],['reply','Customer replies'],['opt_out','Customer sends STOP']].map(([key,label]) => `<option value="${key}" ${values.scenario === key ? 'selected' : ''}>${label}</option>`).join('')}</select></label>
      </details>
      <p class="muted">${getSequence ? 'Uses the rules currently in this editor, including unsaved changes.' : 'Uses your current form fields and saved draft automation rules. Edit rules in the Automation tab.'}</p>
      <button class="btn" type="submit" data-test-run ${canTest ? '' : 'disabled'}>Run simulation</button>
      ${canSend ? '<div class="form-live-start"><h3>Send actual SMS</h3><p>Run the full sequence using your configured delays, repeats and business sending hours. Real replies and STOP affect the run. Standard Twilio charges apply.</p><button class="btn" type="button" data-live-prepare>Prepare real SMS test</button><div data-live-review></div></div>' : ''}
      ${canTest ? '' : '<p class="muted">SMS-read access is required to test automation. You can still try the form fields above.</p>'}
      <div data-test-results role="status" aria-live="polite"></div>
    </form><p data-live-feedback role="status"></p><div data-live-runs></div>`;
    root.querySelector('[data-test-form]').oninput = e => { if(e.target.matches('[data-live-confirm]'))return; capture(); invalidate(); };
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
    root.querySelector('[data-live-prepare]')?.addEventListener('click',async e => {
      if (starting || !root.querySelector('[data-test-form]').reportValidity()) return;
      capture();const ticket=++revision,button=e.currentTarget,review=root.querySelector('[data-live-review]');
      button.disabled=true;review.textContent='Preparing the real schedule…';
      try {
        const candidate=payload();
        if(liveData && !liveData.sendingEnabled) throw new Error('Enable SMS sending for this business from Dashboard before starting a real test.');
        if (!candidate.sample.smsOptIn) throw new Error('Select SMS consent for your test number first.');
        if (/^\+1\d{3}55501\d{2}$/.test(candidate.sample.phone)) throw new Error('Replace the sample phone with a real mobile number you control.');
        const data=await request(`/api/web-forms/${getForm().public_id}/preview`,{method:'POST',body:JSON.stringify({...candidate,submittedLocal:'',scenario:'none'})});
        if (ticket!==revision || !review.isConnected) return;
        if (!data.rows.length || data.outcome.startsWith('Paused:')) throw new Error(data.outcome);
        prepared={...candidate,requestId:crypto.randomUUID(),confirmed:true};
        review.innerHTML=`<div class="form-test-result"><h3>Ready for actual sending</h3><p><strong>${data.totalSends} configured sends to ${esc(candidate.sample.phone)}</strong></p><p>First send: ${esc(format(data.rows[0].at,data.timeZone))} (${esc(data.timeZone)}). This uses your rules starting now; simulation dates and simulated replies are ignored.</p><p>Appointment cutoffs, replies, opt-outs or failures can stop the sequence early. Current draft rules are copied into this test.</p><label class="checkbox-field"><input type="checkbox" data-live-confirm /> I control this phone and agree to receive this full test sequence.</label><button type="button" class="btn" data-live-start disabled>Start real SMS test</button><p data-live-start-status role="status"></p></div>`;
        const start=review.querySelector('[data-live-start]');
        review.querySelector('[data-live-confirm]').onchange=e=>{start.disabled=!e.target.checked;};
        start.onclick=async()=>{
          if (starting || !prepared) return;starting=true;start.disabled=true;
          const sentPayload=prepared,status=review.querySelector('[data-live-start-status]');status.textContent='Starting real SMS test…';
          try {
            liveData=await request(`/api/web-forms/${getForm().public_id}/test-runs`,{method:'POST',body:JSON.stringify(sentPayload)});
            prepared=null;if(review.isConnected)review.innerHTML='<p role="status">Real SMS test started. Follow its schedule and delivery below.</p>';showRuns();void refreshLive();
          } catch(error) { if(status.isConnected)status.textContent=error.message;if(start.isConnected){start.disabled=false;start.textContent='Retry starting this test';} }
          finally { starting=false; }
        };
      } catch(error) { if(ticket===revision && review.isConnected)review.textContent=error.message; }
      finally { if(button.isConnected)button.disabled=false; }
    });
    showRuns();clearTimeout(pollTimer);pollTimer=setTimeout(refreshLive,0);
  }
  return {render, invalidate};
}
