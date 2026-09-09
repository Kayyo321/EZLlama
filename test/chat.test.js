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
  chat.request = async (_messages, options) => {
    assert.deepEqual(options.requestBody, { reasoning_effort: 'none' });
    return 'Summary of task A';
  };
  await chat.compactInternal();
  assert.equal(chat.active.messages[0].content, 'Task A');
  assert.equal(chat.active.messages[1].content, 'Plan A');
  assert.equal(chat.active.contextStart, 2);
  assert.match(chat.context()[0].content, /Summary of task A/);
  assert.equal(chat.active.compactions.length, 1);
  assert.equal(chat.active.messages.at(-1).status, 'complete');
  assert.equal(chat.active.messages.at(-1).content, 'Chat Compacted, Context Reset');
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
  assert.equal(chat.active.messages.at(-1).status, 'failed');
});
test('compaction accepts a non-empty summary that reaches its output limit', async () => {
  const chat = make();
  chat.active.messages = [{ role: 'user', content: 'Important work' }];
  chat.request = async () => {
    const error = new Error('token limit');
    error.outputLimit = true;
    error.partialOutput = 'Usable bounded summary';
    throw error;
  };
  await chat.compactInternal();
  assert.equal(chat.active.summary, 'Usable bounded summary');
  assert.equal(chat.active.messages.at(-1).status, 'complete');
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
test('mid-stream context overflow compacts and continues after the transcript event', async () => {
  const chat = make({ context: 4096, maxOutput: 256, reservedBuffer: 128 });
  chat.active.messages = [
    { role: 'user', content: 'Earlier task' },
    { role: 'assistant', content: 'Earlier answer' }
  ];
  let completionCalls = 0;
  chat.request = async (messages, options) => {
    if (messages[0].content.startsWith('Create')) return 'Earlier work summary';
    completionCalls++;
    if (completionCalls === 1) {
      options.onToken?.('First half. ');
      const error = new Error('context size exceeded');
      error.contextOverflow = true;
      throw error;
    }
    assert.equal(messages.at(-1).role, 'assistant');
    assert.equal(messages.at(-1).content, 'First half. ');
    options.onToken?.('Second half.');
  };
  await chat.send('Finish this answer');
  const answers = chat.active.messages.filter((m) => m.role === 'assistant');
  assert.equal(answers.at(-2).content, 'First half. ');
  assert.equal(answers.at(-2).partial, true);
  assert.equal(answers.at(-1).content, 'Second half.');
  assert.equal(answers.at(-1).partial, false);
  assert.ok(
    chat.active.messages.findIndex((m) => m.kind === 'compaction') <
      chat.active.messages.findIndex((m) => m.content === 'Second half.')
  );
  assert.equal(completionCalls, 2);
});
test('output-limit finish automatically continues while context still fits', async () => {
  const chat = make({ context: 8192, maxOutput: 256, reservedBuffer: 128 });
  let calls = 0;
  chat.request = async (_messages, options) => {
    calls++;
    if (calls === 1) {
      options.onToken?.('First part. ');
      const error = new Error('token limit');
      error.outputLimit = true;
      throw error;
    }
    options.onToken?.('Last part.');
  };
  await chat.send('Write a long response');
  const answers = chat.active.messages.filter((m) => m.role === 'assistant');
  assert.deepEqual(
    answers.map((m) => m.content),
    ['First part. ', 'Last part.']
  );
  assert.equal(chat.active.compactions.length, 0);
  assert.equal(calls, 2);
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
