'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Chat } = require('../src/chat');
const { Logger } = require('../src/runtime');
const { configuration } = require('../src/config');
function make(config = {}) {
  const c = configuration({ ...config, tokenCounting: 'conservative' });
  const server = { state: 'running', modelId: 'a', context: c.context, url: 'http://127.0.0.1:1' };
  const chat = new Chat({
    getConfig: () => c,
    server,
    storage: { load: async () => [], save: async () => {} },
    log: new Logger(() => c),
    getKey: async () => '',
    switchModel: async (id) => {
      server.modelId = id;
    }
  });
  chat.newChat();
  chat.controller = new AbortController();
  return chat;
}
test('compaction preserves visible messages and replaces only internal context', async () => {
  const chat = make();
  chat.active.messages = [
    { role: 'user', content: 'Task A' },
    { role: 'assistant', content: 'Plan A' }
  ];
  chat.request = async () => 'Summary of task A';
  await chat.compactInternal();
  assert.equal(chat.active.messages[0].content, 'Task A');
  assert.equal(chat.active.messages[1].content, 'Plan A');
  assert.equal(chat.active.contextStart, 2);
  assert.match(chat.context()[0].content, /Summary of task A/);
  assert.equal(chat.active.compactions.length, 1);
});
test('failed compaction leaves context and summary unchanged', async () => {
  const chat = make();
  chat.active.messages = [{ role: 'user', content: 'Important work' }];
  chat.request = async () => {
    throw new Error('offline');
  };
  await assert.rejects(chat.compactInternal(), /offline/);
  assert.equal(chat.active.contextStart, 0);
  assert.equal(chat.active.summary, '');
  assert.equal(chat.active.messages[0].content, 'Important work');
});
test('auto compaction resumes same turn and retains the pending user request', async () => {
  const chat = make({ context: 4096, maxOutput: 256, reservedBuffer: 128 });
  chat.active.messages = [
    { role: 'user', content: 'x'.repeat(3300) },
    { role: 'assistant', content: 'y'.repeat(500) }
  ];
  let calls = 0;
  chat.request = async (messages, options) => {
    calls++;
    if (messages[0].content.startsWith('Create')) return 'Short summary';
    options.onToken?.('Final answer');
    return 'Final answer';
  };
  await chat.send('Continue the original task');
  assert.ok(calls >= 2);
  assert.ok(chat.active.summary);
  assert.ok(chat.active.messages.some((m) => m.content === 'Continue the original task'));
  assert.equal(chat.active.messages.at(-1).content, 'Final answer');
  assert.equal(chat.busy, false);
});
test('separate compaction model is restored after a failed summary', async () => {
  const chat = make({ compactionStrategy: 'separate', compactionModel: 'b' });
  chat.active.messages = [{ role: 'user', content: 'Task' }];
  chat.request = async () => {
    assert.equal(chat.server.modelId, 'b');
    throw new Error('failed');
  };
  await assert.rejects(chat.compactInternal());
  assert.equal(chat.server.modelId, 'a');
});
