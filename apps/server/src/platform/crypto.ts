import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

/** Which key encrypted a stored secret. Bump the version when CREDENTIALS_KEY is rotated. */
export const CREDENTIALS_KEY_REF = 'env:CREDENTIALS_KEY:v1';

/** AES-256-GCM with a 12-byte random IV. Output: `v1:iv:tag:data`, each part base64. */
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), data.toString('base64')].join(':');
}

/** Throws when the blob was changed or was encrypted with another key. */
export function decryptSecret(blob: string, key: Buffer): string {
  const [version, iv, tag, data] = blob.split(':');
  if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unknown secret format');
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** The last four characters of a secret, the only part ever shown or logged. */
export function last4(secret: string): string {
  return secret.slice(-4);
}
