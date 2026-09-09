'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const agent = require('../src/agent');
const { configuration } = require('../src/config');
async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ezllama-agent-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  await fs.writeFile(path.join(dir, 'a.txt'), 'line one\r\nline two\r\nline three\r\n');
  await fs.mkdir(path.join(dir, 'src'));
  await fs.writeFile(path.join(dir, 'src', 'index.js'), "const x = 1;\nconsole.log('hello');\n");
  return { root: dir, config: configuration(), signal: new AbortController().signal };
}
test('tools stay inside the workspace and skip credential files', async (t) => {
  const ctx = await workspace(t);
  await assert.rejects(agent.execute('read_file', { path: '../outside.txt' }, ctx), /outside/);
  await assert.rejects(
    agent.execute('read_file', { path: path.join(os.tmpdir(), 'elsewhere.txt') }, ctx),
    /outside/
  );
  await assert.rejects(agent.execute('write_file', { path: '.env', content: 'x' }, ctx), /Credential/);
  await assert.rejects(agent.execute('read_file', { path: 'missing.txt' }, ctx), /Not found/);
  await assert.rejects(agent.execute('nope', {}, ctx), /Unknown tool/);
  await assert.rejects(agent.execute('read_file', { path: 'a.txt' }, { ...ctx, root: '' }), /workspace/);
});
test('read, list, search, write, edit and delete round-trip and keep CRLF endings', async (t) => {
  const ctx = await workspace(t);
  assert.match(
    await agent.execute('read_file', { path: 'a.txt', offset: 2, limit: 1 }, ctx),
    /showing 2-2 \(more available with offset 3\)\n2: line two$/
  );
  assert.match(await agent.execute('list_files', { path: '.' }, ctx), /a\.txt\nsrc\/\nsrc\/index\.js/);
  assert.match(
    await agent.execute('search_files', { pattern: 'HELLO' }, ctx),
    /src[\\/]index\.js:2: console\.log/
  );
  assert.match(
    await agent.execute('search_files', { pattern: '^const', regex: true, path: 'src' }, ctx),
    /index\.js:1/
  );
  assert.equal(await agent.execute('search_files', { pattern: 'absent' }, ctx), 'No matches.');
  assert.match(
    await agent.execute('write_file', { path: 'new/dir/file.md', content: '# Hi\n' }, ctx),
    /Created/
  );
  assert.equal(await fs.readFile(path.join(ctx.root, 'new/dir/file.md'), 'utf8'), '# Hi\n');
  await agent.execute(
    'edit_file',
    { path: 'a.txt', old_text: 'line two\n', new_text: 'line 2\nline 2b\n' },
    ctx
  );
  assert.equal(
    await fs.readFile(path.join(ctx.root, 'a.txt'), 'utf8'),
    'line one\r\nline 2\r\nline 2b\r\nline three\r\n'
  );
  await assert.rejects(
    agent.execute('edit_file', { path: 'a.txt', old_text: 'line', new_text: 'x' }, ctx),
    /matches 4 times/
  );
  await assert.rejects(
    agent.execute('edit_file', { path: 'a.txt', old_text: 'nope', new_text: 'x' }, ctx),
    /not found/
  );
  await agent.execute('delete_file', { path: 'new/dir/file.md' }, ctx);
  await assert.rejects(fs.stat(path.join(ctx.root, 'new/dir/file.md')));
  await assert.rejects(agent.execute('delete_file', { path: 'new' }, ctx), /not empty/);
  assert.equal(agent.summarize('run_command', { command: 'npm test' }), 'run: npm test');
});
test('run_command captures output and exit codes, enforces timeouts, and cancels', async (t) => {
  const ctx = await workspace(t);
  const node = JSON.stringify(process.execPath);
  const finished = await agent.execute(
    'run_command',
    { command: `${node} -e "console.log('out'); console.error('err'); process.exit(3)"` },
    ctx
  );
  assert.match(finished, /^Exit code: 3/);
  assert.match(finished, /out/);
  assert.match(finished, /err/);
  const slow = await agent.execute(
    'run_command',
    { command: `${node} -e "setTimeout(() => {}, 20000)"`, timeout_seconds: 1 },
    ctx
  );
  assert.match(slow, /timeout/);
  const controller = new AbortController();
  const pending = agent.execute(
    'run_command',
    { command: `${node} -e "setTimeout(() => {}, 20000)"` },
    { ...ctx, signal: controller.signal }
  );
  setTimeout(() => controller.abort(), 200);
  await assert.rejects(pending, /Cancelled/);
  await assert.rejects(agent.execute('run_command', { command: 'x', cwd: '..' }, ctx), /outside/);
});
