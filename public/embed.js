const root = document.getElementById('form-root');
const formId = new URLSearchParams(location.search).get('form') || '';
const config = globalThis.SMS_CONFIG || {};
const apiBase = config.formApiBase || `${config.supabaseUrl || ''}/functions/v1/web-form`;

function announceHeight() {
  if (window.parent === window) return;
  window.parent.postMessage({ type: 'sms-web-form:resize', formId, height: Math.ceil(document.documentElement.scrollHeight + 8) }, '*');
}
new ResizeObserver(announceHeight).observe(document.documentElement);

function field(label, type, name, required = false) {
  const wrapper = document.createElement('label');
  wrapper.textContent = label;
  const input = document.createElement(type === 'textarea' ? 'textarea' : 'input');
  if (type !== 'textarea') input.type = type;
  input.name = name;
  input.required = required;
  if (type === 'text') input.maxLength = 300;
  if (type === 'email') input.maxLength = 320;
  if (type === 'tel') { input.placeholder = '+13035550123'; input.autocomplete = 'tel'; }
  wrapper.append(input);
  return { wrapper, input };
}

function normalizePhone(value) {
  const raw = value.trim();
  const digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return `+${digits}`;
  if (digits.length === 10) return `+1${digits}`;
  return raw;
}

async function start() {
  if (!/^[0-9a-f-]{36}$/i.test(formId)) throw new Error('Form not found');
  const response = await fetch(`${apiBase}/${encodeURIComponent(formId)}`);
  const data = await response.json();
  if (!response.ok || !data.form) throw new Error('Form is unavailable');
  const definition = data.form;
  document.title = `${definition.title} · ${definition.businessName}`;
  root.replaceChildren();
  const title = document.createElement('h1'); title.textContent = definition.title;
  const description = document.createElement('p'); description.textContent = definition.description;
  root.append(title, description);
  const form = document.createElement('form'); form.className = 'web-form';
  const name = field('Name', 'text', 'name', true);
  const phone = field('Phone', 'tel', 'phone', true);
  const email = field('Email', 'email', 'email', true);
  name.input.autocomplete = 'name'; email.input.autocomplete = 'email';
  form.append(name.wrapper, phone.wrapper, email.wrapper);
  let appointment;
  if (definition.preset === 'bookings') {
    appointment = field(`Appointment date and time (${definition.timeZone})`, 'datetime-local', 'appointmentAt', true);
    form.append(appointment.wrapper);
  }
  const controls = new Map();
  for (const item of definition.fields || []) {
    let element;
    let wrapper;
    if (item.type === 'checkbox') {
      wrapper = document.createElement('label'); wrapper.className = 'checkbox-field';
      element = document.createElement('input'); element.type = 'checkbox';
      const caption = document.createElement('span'); caption.textContent = item.label;
      wrapper.append(element, caption);
      element.required = Boolean(item.required);
    } else if (item.type === 'select') {
      wrapper = document.createElement('label'); wrapper.textContent = item.label;
      element = document.createElement('select'); element.required = Boolean(item.required);
      const blank = document.createElement('option'); blank.value = ''; blank.textContent = 'Choose an option';
      element.append(blank);
      for (const choice of item.options || []) {
        const option = document.createElement('option'); option.value = choice; option.textContent = choice;
        element.append(option);
      }
      wrapper.append(element);
    } else {
      ({ wrapper, input: element } = field(item.label, item.type === 'date' ? 'date' : item.type, item.key, Boolean(item.required)));
      if (item.type === 'textarea') element.maxLength = 2000;
    }
    controls.set(item.key, { item, element });
    form.append(wrapper);
  }
  const consent = document.createElement('label'); consent.className = 'checkbox-field';
  const consentInput = document.createElement('input'); consentInput.type = 'checkbox';
  const consentText = document.createElement('span'); consentText.textContent = definition.consentText;
  consent.append(consentInput, consentText); form.append(consent);
  const honeypot = field('Website', 'text', 'website'); honeypot.wrapper.className = 'form-honeypot';
  honeypot.input.tabIndex = -1; honeypot.input.autocomplete = 'off'; form.append(honeypot.wrapper);
  const note = document.createElement('span'); note.className = 'form-note';
  note.textContent = 'SMS consent is optional. Contact and quote follow-ups are sent only when you opt in.';
  form.append(note);
  const error = document.createElement('p'); error.className = 'form-error'; error.setAttribute('role', 'alert');
  const button = document.createElement('button'); button.type = 'submit'; button.textContent = definition.buttonLabel;
  form.append(error, button); root.append(form);
  let submissionId = crypto.randomUUID(); let previousPayload = '';
  form.addEventListener('submit', async event => {
    event.preventDefault();
    error.textContent = '';
    const details = {};
    for (const [key, control] of controls) {
      const value = control.item.type === 'checkbox' ? control.element.checked : control.element.value.trim();
      if (value !== '') details[key] = value;
    }
    const payload = {
      name: name.input.value.trim(), phone: normalizePhone(phone.input.value),
      email: email.input.value.trim(), details, smsOptIn: consentInput.checked,
      website: honeypot.input.value,
    };
    if (appointment) payload.appointmentAt = appointment.input.value;
    const nextPayload = JSON.stringify(payload);
    if (nextPayload !== previousPayload) { submissionId = crypto.randomUUID(); previousPayload = nextPayload; }
    button.disabled = true;
    try {
      const sent = await fetch(`${apiBase}/${encodeURIComponent(formId)}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, submissionId }),
      });
      const result = await sent.json();
      if (!sent.ok) throw new Error(result.error || 'Could not submit the form');
      root.replaceChildren();
      const success = document.createElement('div'); success.className = 'form-success'; success.setAttribute('role', 'status');
      success.textContent = definition.preset === 'bookings'
        ? 'Your appointment is confirmed. Thank you!'
        : 'Thanks! Your form has been submitted.';
      root.append(success);
      announceHeight();
    } catch (reason) {
      error.textContent = reason.message || 'Could not submit the form';
      button.disabled = false;
      announceHeight();
    }
  });
  announceHeight();
}

start().catch(error => { root.textContent = error.message || 'Form is unavailable'; announceHeight(); });
