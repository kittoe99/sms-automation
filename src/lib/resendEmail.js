const API = 'https://api.resend.com';

export async function resendEmailRequest(path, { method = 'GET', body, apiKey, idempotencyKey, fetchImpl = fetch } = {}) {
  if (!apiKey) throw Object.assign(new Error('Resend is not configured'), { code: 'RESEND_NOT_CONFIGURED' });
  let response;
  try {
    response = await fetchImpl(`${API}${path}`, {
      method,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json',
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(15000),
    });
  } catch (cause) {
    throw Object.assign(new Error('Resend response is uncertain', { cause }), { code: 'RESEND_UNCERTAIN', uncertain: true });
  }
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(value.message || `Resend returned ${response.status}`);
    error.code = value.name || `RESEND_${response.status}`;
    error.status = response.status;
    error.uncertain = response.status >= 500;
    throw error;
  }
  return value;
}

const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
})[char]);

export function renderEmailMessage(body, businessName, mailingAddress, unsubscribeUrl) {
  const text = `${String(body).trim()}\n\n${businessName}\n${mailingAddress}\n\nUnsubscribe: ${unsubscribeUrl}`;
  const paragraphs = String(body).trim().split(/\n\s*\n/).map(part =>
    `<p style="font:16px/1.5 Arial,sans-serif;color:#173e4c">${escapeHtml(part).replace(/\n/g, '<br>')}</p>`).join('');
  const html = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body style="margin:0;background:#f5f8fa"><main style="max-width:600px;margin:24px auto;padding:32px;background:white">${paragraphs}<footer style="font:12px/1.5 Arial,sans-serif;color:#627780"><p>${escapeHtml(businessName)}<br>${escapeHtml(mailingAddress)}</p><p><a href="${escapeHtml(unsubscribeUrl)}">Unsubscribe from marketing emails</a></p></footer></main></body></html>`;
  return { text, html };
}
