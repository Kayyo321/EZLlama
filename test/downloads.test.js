'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { download, modelSource, releasePlan } = require('../src/downloads');
test('download commits only verified data and never overwrites an existing file', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ezllama-download-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'artifact');
  const original = global.fetch;
  t.after(() => (global.fetch = original));
  global.fetch = async () => ({
    ok: true,
    url: 'https://example.org/model',
    headers: new Headers({ 'content-length': '4' }),
    body: (async function* () {
      yield Buffer.from('test');
    })()
  });
  await assert.rejects(
    download('https://example.org/model', file, { minFreeGB: 0, checksum: '0'.repeat(64) }),
    /verification/
  );
  assert.deepEqual(await fs.readdir(dir), []);
  await download('https://example.org/model', file, {
    minFreeGB: 0,
    checksum: crypto.createHash('sha256').update('test').digest('hex')
  });
  assert.equal(await fs.readFile(file, 'utf8'), 'test');
  await assert.rejects(
    download('https://example.org/model', file, { minFreeGB: 0 }),
    /already exists/
  );
});
test('cancelled downloads clean partial artifacts', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ezllama-cancel-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const original = global.fetch;
  t.after(() => (global.fetch = original));
  const controller = new AbortController();
  global.fetch = async () => ({
    ok: true,
    url: 'https://example.org/model',
    headers: new Headers(),
    body: (async function* () {
      controller.abort();
      yield Buffer.from('test');
    })()
  });
  await assert.rejects(
    download('https://example.org/model', path.join(dir, 'model'), {
      signal: controller.signal,
      minFreeGB: 0
    }),
    /cancelled/
  );
  assert.deepEqual(await fs.readdir(dir), []);
});
test('source resolution rejects insecure URLs and path traversal', async () => {
  await assert.rejects(
    modelSource({ source: 'url', path: 'http://example.org/model.gguf' }),
    /HTTPS/
  );
  await assert.rejects(
    modelSource({ source: 'huggingface', path: 'owner/repo/../bad.gguf' }),
    /GGUF/
  );
});
test('semantic release without binaries falls back to a compatible numbered build', async (t) => {
  const original = global.fetch;
  t.after(() => (global.fetch = original));
  const name =
    process.platform === 'win32'
      ? `llama-bin-win-cpu-${process.arch}.zip`
      : process.platform === 'darwin'
        ? `llama-bin-macos-${process.arch}.tar.gz`
        : `llama-bin-ubuntu-${process.arch}.tar.gz`;
  global.fetch = async (url) => ({
    ok: true,
    json: async () =>
      url.endsWith('/latest')
        ? { tag_name: 'v1', assets: [] }
        : [
            {
              tag_name: 'b123',
              assets: [
                {
                  name,
                  size: 50,
                  browser_download_url: 'https://example.org/release',
                  digest: 'sha256:' + 'a'.repeat(64)
                }
              ]
            }
          ]
  });
  assert.equal((await releasePlan()).version, 'b123');
});
