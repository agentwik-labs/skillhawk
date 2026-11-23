// Test helper: sign a Teams key with a throwaway pair so gated CLI commands run under `node --test`.
import crypto from 'node:crypto';
const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
export const TEST_PUB = publicKey.export({ type: 'spki', format: 'pem' });
export function signKey(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${crypto.sign(null, Buffer.from(body), privateKey).toString('base64url')}`;
}
const exp = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
export const TEST_KEY = signKey({ v: 1, id: 't', email: 't@example.com', plan: 'team', org: 'acme', seats: 5, exp });
process.env.SKILLHAWK_TEST_LICENSE_PUBKEY = TEST_PUB;
process.env.SKILLHAWK_LICENSE = TEST_KEY;
