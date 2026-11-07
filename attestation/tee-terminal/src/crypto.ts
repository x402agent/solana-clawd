import {
  generateKeyPairSync,
  createPublicKey,
  createPrivateKey,
  diffieHellman,
  createCipheriv,
  createDecipheriv,
  randomBytes,
  createHash,
} from 'crypto';
// hkdfSync added in Node 15; fall back to manual HKDF for compatibility
type HkdfFn = (alg: string, key: Buffer, salt: Buffer, info: string, len: number) => Buffer;
let _hkdfSync: HkdfFn | undefined;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  _hkdfSync = (require('node:crypto') as { hkdfSync?: HkdfFn }).hkdfSync;
} catch { /* ignore */ }

import type { SessionKeyPair, EncryptedMessage } from './types';

// ─── Key Generation ──────────────────────────────────────────────────────────

export function generateX25519KeyPair(): SessionKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('x25519', {
    publicKeyEncoding: { type: 'spki', format: 'der' },
    privateKeyEncoding: { type: 'pkcs8', format: 'der' },
  });
  return { publicKey: Buffer.from(publicKey), privateKey: Buffer.from(privateKey) };
}

// ─── Key Derivation ──────────────────────────────────────────────────────────

export function deriveSessionKey(
  myPrivateDer: Buffer,
  theirPublicDer: Buffer,
  sessionId: string,
): Buffer {
  const myPrivateKey = createPrivateKey({ key: myPrivateDer, format: 'der', type: 'pkcs8' });
  const theirPublicKey = createPublicKey({ key: theirPublicDer, format: 'der', type: 'spki' });
  const sharedSecret = Buffer.from(diffieHellman({ privateKey: myPrivateKey, publicKey: theirPublicKey }));
  const salt = sha256(Buffer.from(sessionId, 'utf8'));
  const fn = _hkdfSync ?? manualHkdf;
  return Buffer.from(fn('sha256', sharedSecret, salt, 'clawd-tee-terminal-v1', 32));
}

// RFC 5869 HKDF (pure Node crypto, no external deps)
function manualHkdf(_alg: string, ikm: Buffer, salt: Buffer, info: string, len: number): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const nc = require('node:crypto') as typeof import('crypto');
  const prk = Buffer.from(nc.createHmac('sha256', salt).update(ikm).digest());
  const infoBytes = Buffer.from(info, 'utf8');
  const blocks: Buffer[] = [];
  let prev = Buffer.alloc(0);
  let produced = 0;
  for (let i = 1; produced < len; i++) {
    const hmac = nc.createHmac('sha256', prk);
    hmac.update(prev);
    hmac.update(infoBytes);
    hmac.update(Buffer.from([i]));
    prev = Buffer.from(hmac.digest());
    blocks.push(prev);
    produced += prev.length;
  }
  return Buffer.from(Buffer.concat(blocks).subarray(0, len));
}

// ─── AES-256-GCM ─────────────────────────────────────────────────────────────

export function encrypt(key: Buffer, plaintext: Buffer, seq = 0): EncryptedMessage {
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(plaintext), Buffer.from(cipher.final())]);
  const authTag = Buffer.from(cipher.getAuthTag());
  return {
    nonce: nonce.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    authTag: authTag.toString('base64'),
    seq,
  };
}

export function decrypt(key: Buffer, msg: EncryptedMessage): Buffer {
  const nonce = Buffer.from(msg.nonce, 'base64');
  const ciphertext = Buffer.from(msg.ciphertext, 'base64');
  const authTag = Buffer.from(msg.authTag, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), Buffer.from(decipher.final())]);
}

// ─── Hashing ─────────────────────────────────────────────────────────────────

export function sha256(data: Buffer | string): Buffer {
  const input = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  return Buffer.from(createHash('sha256').update(input).digest());
}

export function computeParamsHash(sessionId: string, userPubkey: string, startTime: number): Buffer {
  return sha256(`${sessionId}:${userPubkey}:${startTime}`);
}

export function randomHex(bytes = 16): string {
  return randomBytes(bytes).toString('hex');
}
