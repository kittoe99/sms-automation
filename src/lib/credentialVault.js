import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

export function credentialEncryptionKey(env = process.env) {
  const raw = String(env.TENANT_CREDENTIAL_ENCRYPTION_KEY || '').trim();
  const key = Buffer.from(raw, 'base64');
  if (key.length !== 32 || key.toString('base64') !== raw) {
    const error = new Error('TENANT_CREDENTIAL_ENCRYPTION_KEY must be a base64-encoded 32-byte key');
    error.status = 503;
    error.expose = true;
    throw error;
  }
  return key;
}

/** Bind ciphertext to its business and Twilio account to prevent record swapping. */
export function encryptTwilioCredentials(tenantId, accountSid, credentials, key = credentialEncryptionKey()) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(`twilio:${tenantId}:${accountSid}`));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join('.');
}

export function decryptTwilioCredentials(tenantId, accountSid, encrypted, key = credentialEncryptionKey()) {
  try {
    const parts = String(encrypted).split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') throw new Error('Invalid ciphertext');
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    if (iv.length !== 12 || tag.length !== 16) throw new Error('Invalid ciphertext');
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAAD(Buffer.from(`twilio:${tenantId}:${accountSid}`));
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(Buffer.from(parts[3], 'base64')), decipher.final()]);
    const decoded = JSON.parse(plaintext.toString('utf8'));
    if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) throw new Error('Invalid credentials');
    return decoded;
  } catch {
    const error = new Error('Business Twilio credentials could not be decrypted');
    error.status = 503;
    error.expose = true;
    throw error;
  }
}
