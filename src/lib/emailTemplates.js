/* global URL */
// Portable email document contract. No raw HTML or customer-provided markup is evaluated.
export const EMAIL_VARIABLES = ['name','firstName','email','businessName','appointment','request','service'];
const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
export function mergeEmailText(text, values = {}) {
  return String(text).replace(/\{\{([^{}]+)\}\}/g, (_, rawKey) => {
    const key=rawKey.trim();
    if (!EMAIL_VARIABLES.includes(key)) throw new Error(`Unknown email field: ${key}`);
    return String(values[key] ?? '');
  });
}
export function validateEmailDefinition(value) {
  if (!value || !['marketing','service'].includes(value.purpose) || !Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 30) throw new Error('Choose an email purpose and 1–30 steps');
  if (!Number.isInteger(value.startHour) || !Number.isInteger(value.endHour) || value.startHour < 0 || value.endHour > 24 || value.startHour >= value.endHour) throw new Error('Invalid sending hours');
  for (const step of value.steps) {
    if (!['event','appointment'].includes(step.anchor) || !Number.isInteger(step.offsetMinutes) || Math.abs(step.offsetMinutes) > 525600 || (step.anchor === 'event' && step.offsetMinutes < 0)) throw new Error('Invalid step timing');
    if (typeof step.subject !== 'string' || !step.subject.trim() || step.subject.length > 200 || /[\r\n]/.test(step.subject)) throw new Error('Use a subject of 1–200 characters');
    if (!Array.isArray(step.document) || !step.document.length || JSON.stringify(step.document).length > 10000) throw new Error('Add email content (maximum 10,000 characters)');
    if(!renderEmailDocument(step.document, {}).text.trim()) throw new Error('Add email body text');
    mergeEmailText(step.subject, {});
  }
  return value;
}
export function renderEmailDocument(document, values) {
  if (!Array.isArray(document)) throw new Error('Invalid email document');
  const text = [], html = [];
  for (const node of document) {
    if (!node || !['paragraph','heading','bullet'].includes(node.type) || !Array.isArray(node.content)) throw new Error('Invalid email block');
    const lines = [], parts = [];
    for (const span of node.content) {
      if (typeof span.text !== 'string' || Object.keys(span).some(key => !['text','bold','italic','href'].includes(key))) throw new Error('Invalid email text');
      const merged = mergeEmailText(span.text, values);
      lines.push(merged + (span.href ? ` (${span.href})` : ''));
      let part = escape(merged).replace(/\n/g,'<br>');
      if (span.bold) part = `<strong>${part}</strong>`;
      if (span.italic) part = `<em>${part}</em>`;
      if (span.href) {
        const url = new URL(span.href);
        if (!['https:','http:','mailto:'].includes(url.protocol) || /[\r\n]/.test(span.href)) throw new Error('Use an http, https, or mailto link');
        part = `<a href="${escape(url.href)}">${part}</a>`;
      }
      parts.push(part);
    }
    text.push(`${node.type === 'bullet' ? '• ' : ''}${lines.join('')}`);
    const tag = node.type === 'heading' ? 'h2' : 'p';
    html.push(`<${tag}>${node.type === 'bullet' ? '• ' : ''}${parts.join('')}</${tag}>`);
  }
  return { text: text.join('\n\n'), html: html.join('') };
}
export function renderTemplateEmail(step, values, { businessName, mailingAddress, unsubscribeUrl, purpose }) {
  const subject = mergeEmailText(step.subject, values).replace(/[\r\n]/g,' ').slice(0,200);
  const content = renderEmailDocument(step.document, values);
  const footer = `${businessName}\n${mailingAddress}${purpose === 'marketing' ? `\n\nUnsubscribe: ${unsubscribeUrl}` : ''}`;
  return { subject, body: content.text, text: `${content.text}\n\n${footer}`,
    html: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0;background:#f5f8fa;font:16px/1.6 Arial,sans-serif;color:#173e4c"><main style="max-width:600px;margin:24px auto;padding:32px;background:white"><h1 style="font-size:20px">${escape(businessName)}</h1>${content.html}<footer style="font-size:12px;color:#627780"><p>${escape(businessName)}<br>${escape(mailingAddress)}</p>${purpose === 'marketing' ? `<a href="${escape(unsubscribeUrl)}">Unsubscribe from marketing emails</a>` : ''}</footer></main></body></html>` };
}
export const paragraph = text => ({ type:'paragraph', content:[{text}] });
const step = (subject, body, offsetMinutes=0, anchor='event') => ({subject,document:[paragraph(body)],offsetMinutes,anchor});
export const EMAIL_STARTERS = [
  {name:'Enquiry follow-up',purpose:'marketing',steps:[step('Thanks for your enquiry, {{firstName}}','Hi {{firstName}}, thanks for contacting {{businessName}} about {{request}}. How can we help with the next step?'),step('Following up on your enquiry','Hi {{firstName}}, do you have any questions for {{businessName}}?',2880)]},
  {name:'Quote follow-up',purpose:'marketing',steps:[step('Your request with {{businessName}}','Hi {{firstName}}, we received your request about {{service}}. Reply here if you have any questions.',1440)]},
  {name:'Booking confirmation and reminder',purpose:'service',steps:[step('Your booking with {{businessName}}','Hi {{firstName}}, your booking is confirmed for {{appointment}}.'),step('Reminder: your upcoming booking','Hi {{firstName}}, this is a reminder of your booking with {{businessName}} on {{appointment}}.',-1440,'appointment')]},
  {name:'Booking changed',purpose:'service',steps:[step('Your booking has changed','Hi {{firstName}}, your booking with {{businessName}} is now scheduled for {{appointment}}.')]},
  {name:'Booking cancelled',purpose:'service',steps:[step('Your booking has been cancelled','Hi {{firstName}}, your booking with {{businessName}} on {{appointment}} has been cancelled.')]},
  {name:'Post-appointment follow-up',purpose:'marketing',steps:[step('Following up after your appointment','Hi {{firstName}}, we are following up after your scheduled appointment with {{businessName}}. Do you have any questions?',1440,'appointment')]},
  {name:'Review request',purpose:'marketing',steps:[step('How was your experience?','Hi {{firstName}}, if you used {{businessName}}, we would appreciate hearing about your experience.',2880,'appointment')]},
].map(item=>({...item,startHour:item.purpose==='service'?0:9,endHour:item.purpose==='service'?24:18}));
