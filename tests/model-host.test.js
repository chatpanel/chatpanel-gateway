// H3 (source hardening): CHATPANEL_MODEL_BASE_URL is a model-download redirect
// vector — validate it before trusting it. Falls back to the signed default on
// anything unsafe.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveModelHost } from '../src/ner-engine.js';

const DEFAULT = 'https://dl.chatpanel.net/models/';

function withEnv(val, fn) {
  const prev = process.env.CHATPANEL_MODEL_BASE_URL;
  if (val === undefined) delete process.env.CHATPANEL_MODEL_BASE_URL;
  else process.env.CHATPANEL_MODEL_BASE_URL = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env.CHATPANEL_MODEL_BASE_URL;
    else process.env.CHATPANEL_MODEL_BASE_URL = prev;
  }
}

test('unset → signed default', () => {
  withEnv(undefined, () => assert.equal(resolveModelHost(), DEFAULT));
});

test('https public mirror (e.g. HF) is honored', () => {
  withEnv('https://huggingface.co/', () => assert.equal(resolveModelHost(), 'https://huggingface.co/'));
  withEnv('https://mirror.example.com/models', () => assert.equal(resolveModelHost(), 'https://mirror.example.com/models/'));
});

test('http on a LAN/loopback mirror (air-gap) is honored', () => {
  withEnv('http://127.0.0.1:8080/models/', () => assert.equal(resolveModelHost(), 'http://127.0.0.1:8080/models/'));
  withEnv('http://192.168.1.10/m/', () => assert.equal(resolveModelHost(), 'http://192.168.1.10/m/'));
});

test('unsafe overrides fall back to the default', () => {
  withEnv('http://evil.example.com/models/', () => assert.equal(resolveModelHost(), DEFAULT)); // plaintext to public host
  withEnv('http://169.254.169.254/', () => assert.equal(resolveModelHost(), DEFAULT));         // metadata
  withEnv('file:///etc/', () => assert.equal(resolveModelHost(), DEFAULT));                     // non-http(s)
  withEnv('not a url', () => assert.equal(resolveModelHost(), DEFAULT));                         // invalid
});
