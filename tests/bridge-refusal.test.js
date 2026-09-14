// A bridge refusal reaches the person as the bridge's own sentence — not as JSON debris cut at 200 chars.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bridgeRefusal } from '../src/bridge.js';

const res = (status, body) => ({ status, text: async () => body });

test('the bridge\'s error message is relayed whole; a non-JSON body keeps the status line', async () => {
  const msg = 'Claude Code isn\'t signed in on this machine, so your message was not sent. ChatPanel uses your own Claude Code login and can\'t sign in for you: open a terminal, run `claude`, and type `/login`, finish the sign-in in the browser, then send your message again.';
  assert.equal(await bridgeRefusal(res(503, JSON.stringify({ error: { message: msg, type: 'model' } }))), msg);
  assert.equal(await bridgeRefusal(res(403, JSON.stringify({ error: 'forbidden: token' }))), 'forbidden: token');
  assert.equal(await bridgeRefusal(res(502, 'Bad Gateway')), 'bridge /chat HTTP 502: Bad Gateway');
  assert.equal(await bridgeRefusal(res(500, '')), 'bridge /chat HTTP 500');
});
