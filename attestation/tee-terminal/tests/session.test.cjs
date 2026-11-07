const test = require('node:test');
const assert = require('node:assert/strict');
const { TeeSessionManager } = require('../dist/session.js');
const { CommandRouter } = require('../dist/router.js');
const { generateX25519KeyPair, deriveSessionKey, encrypt, decrypt } = require('../dist/crypto.js');
const config = { port: 8443, solanaRpcUrl: 'http://127.0.0.1:8899', network: 'demo', sasProgram: '22zoJMtdu4tQc2PzL74ZUT7FrwgB1Udec8DdW4yw4BdG', demoMode: true };

test('demo terminal completes encrypted roundtrip and clears the closed session', async () => {
  const sessions = new TeeSessionManager(config);
  const { sessionId, serverPublicKey } = sessions.createSession();
  const clientKeys = generateX25519KeyPair();
  const clientKey = deriveSessionKey(clientKeys.privateKey, Buffer.from(serverPublicKey, 'base64'), sessionId);
  assert.ok(Buffer.isBuffer(clientKey));
  const ready = await sessions.completeHandshake(sessionId, clientKeys.publicKey, '11111111111111111111111111111111');
  assert.equal(ready.readyPayload.demoMode, true);
  const request = encrypt(clientKey, Buffer.from('!help'), 1);
  const command = decrypt(ready.sessionKey, request).toString();
  const result = await new CommandRouter(config).route(ready, command);
  const response = encrypt(ready.sessionKey, Buffer.from(JSON.stringify(result)), 1);
  assert.match(JSON.parse(decrypt(clientKey, response).toString()).output, /CLAWD TEE Terminal Commands/);
  const tampered = { ...request, ciphertext: Buffer.from('invalid').toString('base64') };
  assert.throws(() => decrypt(ready.sessionKey, tampered));
  sessions.closeSession(sessionId);
  assert.equal(sessions.getSession(sessionId), undefined);
  assert.equal(sessions.activeSessions(), 0);
});

test('live terminal rejects missing attestation configuration without creating an active session', async () => {
  const sessions = new TeeSessionManager({ ...config, demoMode: false });
  const { sessionId } = sessions.createSession();
  const keys = generateX25519KeyPair();
  await assert.rejects(sessions.completeHandshake(sessionId, keys.publicKey, '11111111111111111111111111111111'), /Live TEE attestation requires/);
  assert.equal(sessions.activeSessions(), 0);
  assert.equal(sessions.getSession(sessionId).sessionKey, undefined);
});

test('terminal does not execute shell commands unless explicitly enabled', async () => {
  const previous = process.env.TEE_ALLOW_SHELL;
  delete process.env.TEE_ALLOW_SHELL;
  try {
    const result = await new CommandRouter(config).route({}, '!shell echo forbidden');
    assert.equal(result.exitCode, 1);
    assert.match(result.output, /disabled/);
  } finally {
    if (previous === undefined) delete process.env.TEE_ALLOW_SHELL;
    else process.env.TEE_ALLOW_SHELL = previous;
  }
});
