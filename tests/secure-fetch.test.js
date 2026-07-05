// M1: secureFetch resolves DNS and validates the RESOLVED IPs against the endpoint
// policy (loopback/LAN OK, metadata never), and revalidates each redirect hop — so a
// public hostname that resolves to (or redirects to) a blocked address is caught,
// which the hostname-only classifier misses.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { secureFetch } from '../src/secure-fetch.js';

const res = (status = 200, headers = {}) => ({
  status,
  headers: { get: (k) => headers[k.toLowerCase()] ?? null },
  body: { cancel() {} },
});

test('blocks a public hostname that RESOLVES to cloud metadata (DNS rebinding)', async () => {
  const lookupFn = async () => [{ address: '169.254.169.254' }];
  const fetchFn = async () => res();
  await assert.rejects(() => secureFetch('http://sneaky.example/x', { lookupFn, fetchFn }), /blocked address/);
});

test('allows a hostname that resolves to a public IP', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  let called = false;
  const fetchFn = async () => { called = true; return res(200); };
  const r = await secureFetch('http://example.com/x', { lookupFn, fetchFn });
  assert.equal(r.status, 200);
  assert.equal(called, true);
});

test('revalidates redirects — a 302 to cloud metadata is blocked', async () => {
  const lookupFn = async () => [{ address: '93.184.216.34' }];
  const fetchFn = async () => res(302, { location: 'http://169.254.169.254/latest/meta-data/' });
  await assert.rejects(() => secureFetch('http://example.com/x', { lookupFn, fetchFn }), /blocked address/);
});

test('literal-IP loopback host skips DNS and is allowed (Ollama)', async () => {
  const lookupFn = async () => { throw new Error('must not resolve a literal IP'); };
  const fetchFn = async () => res(200);
  const r = await secureFetch('http://127.0.0.1:11434/v1/models', { lookupFn, fetchFn });
  assert.equal(r.status, 200);
});

test('a DNS resolution failure is not masked as a security error (fetch surfaces it)', async () => {
  const lookupFn = async () => { throw new Error('ENOTFOUND'); };
  let called = false;
  const fetchFn = async () => { called = true; return res(200); };
  await secureFetch('http://weird.example/x', { lookupFn, fetchFn });
  assert.equal(called, true);
});

test('non-http(s) scheme is rejected before any fetch', async () => {
  await assert.rejects(
    () => secureFetch('file:///etc/passwd', { lookupFn: async () => [], fetchFn: async () => res() }),
    /only http/,
  );
});
