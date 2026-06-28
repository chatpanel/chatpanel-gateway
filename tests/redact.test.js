// Engine-reuse + adapter smoke tests. No network: we exercise the redaction and
// restoration seam the gateway depends on.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactSegments, segment } from '../src/redact.js';
import { makeTokenRestorer, restoreDeep } from '../src/stream.js';
import * as openai from '../src/openai.js';
import * as anthropic from '../src/anthropic.js';

test('deterministic redaction blinds emails and restores them', async () => {
  const body = { messages: [{ role: 'user', content: 'email me at alex@example.com please' }] };
  const segs = openai.collectSegments(body, { redactSystem: true });
  const { vault, count } = await redactSegments(segs, { tier: 'basic', dictionary: [] });

  assert.equal(count, 1);
  assert.match(body.messages[0].content, /\[\[EMAIL_1\]\]/);
  assert.doesNotMatch(body.messages[0].content, /alex@example\.com/);

  // restore the round-trip
  const r = makeTokenRestorer(vault);
  const restored = r.push(body.messages[0].content) + r.flush();
  assert.match(restored, /alex@example\.com/);
});

test('dictionary alias pseudonymizes (no placeholder, permanent)', async () => {
  const body = { messages: [{ role: 'user', content: 'ship Project Atlas tonight' }] };
  const segs = openai.collectSegments(body, {});
  const { vault } = await redactSegments(segs, {
    tier: 'basic',
    dictionary: [{ value: 'Project Atlas', alias: 'Project Nimbus' }],
  });
  assert.match(body.messages[0].content, /Project Nimbus/);
  // an alias is not a token, so restore leaves it as-is
  const r = makeTokenRestorer(vault);
  assert.match(r.push(body.messages[0].content) + r.flush(), /Project Nimbus/);
});

test('streaming restorer holds back a split token', () => {
  const body = { messages: [{ role: 'user', content: 'reach me: a@b.io' }] };
  return redactSegments(openai.collectSegments(body, {}), { tier: 'basic', dictionary: [] })
    .then(({ vault }) => {
      const token = body.messages[0].content.match(/\[\[EMAIL_1\]\]/)[0];
      const mid = Math.floor(token.length / 2);
      const r = makeTokenRestorer(vault);
      let out = r.push('contact ' + token.slice(0, mid)); // split mid-token
      out += r.push(token.slice(mid) + ' now');
      out += r.flush();
      assert.match(out, /a@b\.io/);
      assert.doesNotMatch(out, /\[\[EMAIL_1\]\]/);
    });
});

test('anthropic adapter collects system + text blocks', async () => {
  const body = {
    system: 'caller is alex@example.com',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'call 415-555-0100' }] }],
  };
  const segs = anthropic.collectSegments(body, { redactSystem: true });
  const { count } = await redactSegments(segs, { tier: 'basic', dictionary: [] });
  assert.equal(count, 2);
  assert.doesNotMatch(body.system, /alex@example\.com/);
  assert.doesNotMatch(JSON.stringify(body.messages), /415-555-0100/);
});

test('restoreDeep walks tool-call argument objects', async () => {
  const body = { messages: [{ role: 'user', content: 'find alex@example.com' }] };
  const { vault } = await redactSegments(openai.collectSegments(body, {}), { tier: 'basic', dictionary: [] });
  const token = body.messages[0].content.match(/\[\[EMAIL_1\]\]/)[0];
  const args = { query: `lookup ${token}`, nested: { v: [token] } };
  const restored = restoreDeep(args, vault);
  assert.equal(restored.query, 'lookup alex@example.com');
  assert.equal(restored.nested.v[0], 'alex@example.com');
});
