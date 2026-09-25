const token = new URLSearchParams(location.search).get('token');
const button = document.getElementById('unsubscribe');
const status = document.getElementById('status');
if (!/^[0-9a-f-]{36}$/i.test(token || '')) {
  button.disabled = true;
  status.textContent = 'This unsubscribe link is invalid.';
}
button.addEventListener('click', async () => {
  button.disabled = true;
  status.textContent = 'Saving your preference…';
  try {
    const base = (globalThis.SMS_CONFIG?.formApiBase || `${globalThis.SMS_CONFIG?.supabaseUrl || ''}/functions/v1/web-form`).replace(/\/$/, '');
    const response = await fetch(`${base}/email/unsubscribe?token=${encodeURIComponent(token)}`, { method: 'POST' });
    if (!response.ok) throw new Error('Please try again.');
    status.textContent = 'You are unsubscribed from E2 Local marketing emails.';
  } catch (error) { status.textContent = error.message; button.disabled = false; }
});
