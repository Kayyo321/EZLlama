'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { Server, Logger, completion, delay } = require('../src/runtime');
const { configuration } = require('../src/config');
async function port() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const n = s.address().port;
  await new Promise((r) => s.close(r));
  return n;
}
async function setup(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ezllama-server-'));
  const file = path.join(dir, 'model.gguf');
  const b = Buffer.alloc(24);
  b.write('GGUF');
  b.writeUInt32LE(3, 4);
  b.writeBigUInt64LE(1n, 8);
  await fs.writeFile(file, b);
  const c = configuration({ port: await port(), startupTimeoutSeconds: 5 });
  const server = new Server(new Logger(() => c));
  t.after(async () => {
    await server.stop();
    await fs.rm(dir, { recursive: true, force: true });
  });
  return {
    c,
    server,
    model: { id: 'fixture', path: file, context: 4096 },
    binary: { executable: process.execPath },
    command: `"{executable}" "${path.join(__dirname, 'fixtures/server.js')}"`
  };
}
test('real child lifecycle reaches health readiness, streams, and releases its port', async (t) => {
  const { c, server, model, binary, command } = await setup(t);
  const states = [];
  server.on('state', () => states.push(server.state));
  await server.start(c, model, binary, command);
  assert.equal(server.state, 'running');
  assert.equal(server.context, 4096);
  assert.equal(
    await completion(server.url, c, [{ role: 'user', content: 'hi' }]),
    'Fixture response'
  );
  await server.stop();
  assert.equal(server.state, 'stopped');
  assert.ok(states.includes('starting'));
  assert.ok(states.includes('stopping'));
  const probe = net.createServer();
  await new Promise((resolve, reject) =>
    probe.once('error', reject).listen(c.port, c.host, resolve)
  );
  await new Promise((r) => probe.close(r));
});
test('startup cancellation kills the child and leaves a stopped state', async (t) => {
  const { c, server, model, binary, command } = await setup(t);
  const pending = server.start(c, model, binary, command + ' --slow');
  const checked = assert.rejects(pending);
  while (!server.child) await delay(10);
  await server.stop();
  await checked;
  assert.equal(server.state, 'stopped');
  assert.equal(server.child, null);
});
test('occupied ports do not masquerade as a ready managed server', async (t) => {
  const { c, server, model, binary, command } = await setup(t);
  const occupied = net.createServer();
  await new Promise((r) => occupied.listen(c.port, c.host, r));
  t.after(() => occupied.close());
  await assert.rejects(server.start(c, model, binary, command), /already in use/);
  assert.equal(server.state, 'stopped');
});
