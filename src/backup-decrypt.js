// Decrypt a ChatPanel backup envelope — the gateway counterpart to the extension's
// crypto-backup.js. Same wire format so the gateway can read the user's own daily
// encrypted backups (with the passphrase they hand off) even when the extension
// isn't running. WebCrypto (PBKDF2 + AES-GCM) + zlib gunzip; no dependencies.
//
// Envelope (v2): { type, version, kdf:{iterations,salt}, cipher:'AES-GCM',
//   compression:'gzip'|'none'|absent, iv, ct }. v1 (no `compression`) → plaintext.

import { gunzipSync } from 'node:zlib';

const ENCRYPTED_TYPE = 'chatpanel-backup-encrypted';
const b64 = (s) => Buffer.from(String(s || ''), 'base64');

async function deriveKey(passphrase, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['decrypt'],
  );
}

export function isEncryptedBackup(obj) {
  return !!obj && typeof obj === 'object' && obj.type === ENCRYPTED_TYPE;
}

// Envelope + passphrase → the original backup data object. Throws a friendly error
// on a wrong passphrase or a tampered file (AES-GCM auth-tag mismatch catches both).
export async function decryptBackupEnvelope(envelope, passphrase) {
  if (!isEncryptedBackup(envelope)) throw new Error('not an encrypted ChatPanel backup');
  if (!passphrase) throw new Error('a passphrase is required to decrypt this backup');
  const key = await deriveKey(passphrase, b64(envelope.kdf?.salt), envelope.kdf?.iterations || 250000);
  let payload;
  try {
    payload = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64(envelope.iv) }, key, b64(envelope.ct)));
  } catch {
    throw new Error('wrong passphrase, or the backup file is corrupted');
  }
  // v2 gzips before encrypting; v1 (no `compression` key) is plaintext JSON.
  if (envelope.compression === 'gzip') payload = new Uint8Array(gunzipSync(Buffer.from(payload)));
  return JSON.parse(Buffer.from(payload).toString('utf8'));
}
