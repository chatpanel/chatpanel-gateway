// BYO NER model id: /ner/models POST accepts a catalog id or a strictly-validated
// custom org/name id, and rejects junk. (No real download — allowDownload is off in
// the test config, so the background load fails open; we only assert the HTTP gate.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createGateway } from '../src/server.js';
import { isValidCustomModelId, isKnownModel } from '../src/models.js';

function listen(server) {
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res(server.address().port)));
}
const cfg = () => ({
  host: '127.0.0.1', port: 0, backend: 'api',
  upstreams: { openai: { baseUrl: 'http://127.0.0.1:1' }, anthropic: { baseUrl: 'http://127.0.0.1:1' } },
  redaction: { tier: 'basic', dictionary: [], detection: { backend: 'off' }, redactSystem: true },
  ner: { autostart: false, model: 'Xenova/bert-base-NER', allowDownload: false },
  logRequests: false,
});

test('custom NER id guard: org/name ok, traversal/junk rejected', () => {
  assert.ok(isValidCustomModelId('Xenova/bert-base-multilingual-cased-ner-hrl'));
  assert.ok(isValidCustomModelId('someone/my-ner'));
  assert.ok(!isValidCustomModelId('../etc/passwd'));
  assert.ok(!isValidCustomModelId('just-a-name'));
  assert.ok(!isKnownModel('someone/my-ner'));
});

test('/ner/models POST: catalog 202, BYO 202, junk 400', async () => {
  const gw = createGateway(cfg());
  const port = await listen(gw);
  const post = (id) => fetch(`http://127.0.0.1:${port}/ner/models`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id }),
  });
  assert.equal((await post('Xenova/bert-base-NER')).status, 202);
  assert.equal((await post('someone/custom-ner')).status, 202); // BYO, validated
  assert.equal((await post('not a model')).status, 400);
  gw.close();
});
