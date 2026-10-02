const decode = value => Uint8Array.from(atob(value.replace(/-/g, '+').replace(/_/g, '/')
  .padEnd(Math.ceil(value.length / 4) * 4, '=')), char => char.charCodeAt(0));

export async function verifyResendWebhook(raw, headers, secret, now = Date.now()) {
  const id = headers.get('svix-id'), timestamp = headers.get('svix-timestamp');
  const signatures = (headers.get('svix-signature') || '').split(' ').map(value => value.trim())
    .filter(value => value.startsWith('v1,')).map(value => value.slice(3));
  const seconds = Number(timestamp);
  if (!id || !Number.isInteger(seconds) || Math.abs(now / 1000 - seconds) > 300
    || !secret?.startsWith('whsec_') || !signatures.length) return false;
  let keyBytes;
  try { keyBytes = decode(secret.slice(6)); } catch { return false; }
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const expected = new Uint8Array(await crypto.subtle.sign('HMAC', key,
    new TextEncoder().encode(`${id}.${timestamp}.${raw}`)));
  return signatures.some(signature => {
    let actual;
    try { actual = decode(signature); } catch { return false; }
    if (actual.length !== expected.length) return false;
    let difference = 0;
    for (let index = 0; index < actual.length; index++) difference |= actual[index] ^ expected[index];
    return difference === 0;
  });
}
