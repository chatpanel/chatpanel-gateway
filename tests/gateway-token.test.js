// M2: the gateway admin token — extension Origin OR a 0600 bearer token authorizes
// an admin call; a random local process (no Origin, no token) does not.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, statSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureGatewayToken, isExtensionOrigin, isAdminAuthorized } from '../src/gateway-token.js';

test('isExtensionOrigin recognises extension origins only', () => {
  assert.equal(isExtensionOrigin('chrome-extension://abc'), true);
  assert.equal(isExtensionOrigin('moz-extension://abc'), true);
  assert.equal(isExtensionOrigin('http://localhost:3000'), false);
  assert.equal(isExtensionOrigin(undefined), false);
});

test('ensureGatewayToken creates a 0600 token file and authorizes a bearer', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'cp-gwtok-')), 'gateway-token');
  const token = ensureGatewayToken(path);
  assert.match(token, /^[0-9a-f]{64}$/);
  const mode = statSync(path).mode & 0o777;
  if (process.platform !== 'win32') assert.equal(mode, 0o600);
  assert.equal(readFileSync(path, 'utf8').trim(), token);

  // token module holds this token now → a matching bearer is authorized
  assert.equal(isAdminAuthorized({ headers: { authorization: `Bearer ${token}` } }), true);
  assert.equal(isAdminAuthorized({ headers: { 'x-chatpanel-token': token } }), true);
  assert.equal(isAdminAuthorized({ headers: { authorization: 'Bearer wrong' } }), false);
  assert.equal(isAdminAuthorized({ headers: {} }), false);
  // …and the extension Origin authorizes without any token
  assert.equal(isAdminAuthorized({ headers: { origin: 'chrome-extension://x' } }), true);
});
