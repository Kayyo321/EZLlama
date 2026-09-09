'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Chat } = require('../src/chat');
const { Logger } = require('../src/runtime');
const { configuration } = require('../src/config');
function make(config = {}, workspace) {
  const c = configuration({ ...config, tokenCounting: 'conservative' });
  const server = { state: 'running', modelId: 'a', context: c.context, url: 'http://127.0.0.1:1' };
  const chat = new Chat({
    getConfig: () => c,
    server,
    storage: { load: async () => [], save: async () => {} },
    log: new Logger(() => c),
    getKey: async () => '',
    workspace,
    switchModel: async (id) => {
      server.modelId = id;
    }
  });
  chat.newChat();
  chat.controller = new AbortController();
  return chat;
}
async function workspace(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ezllama-chat-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const call = (id, name, args) => ({ id, name, arguments: JSON.stringify(args) });
// Answers approval and question prompts as they appear in the transcript.
function answerPrompts(chat, answer) {
  chat.on('change', () => {
    const row = chat.active.messages.find((m) => m.role === 'tool' && m.prompt);
    if (!row) return;
    const value = answer(row);
    if (value !== undefined) queueMicrotask(() => chat.reply(row.prompt.id, value));
  });
}
test('context folds consecutive assistant continuations into one message', () => {
  const chat = make();
  chat.active.messages = [
    { role: 'user', content: 'Write it' },
    { role: 'assistant', content: 'part one ' },
    { role: 'assistant', content: 'part two' },
    { role: 'assistant', content: '', partial: true }
  ];
  const out = chat.context();
  assert.equal(out.filter((m) => m.role === 'assistant').length, 1);
  assert.equal(out.at(-1).role, 'assistant');
  assert.equal(out.at(-1).content, 'part one part two');
});
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
test('a long first answer is compacted even though only its own output filled the context', async () => {
  const chat = make({ context: 4096, maxOutput: 256, reservedBuffer: 128 });
  let completionCalls = 0;
  chat.request = async (messages, options) => {
    if (messages[0].content.startsWith('Create')) return `Summary ${completionCalls}`;
    completionCalls++;
    if (completionCalls > 2) return void options.onToken?.('The end.');
    options.onToken?.(`Scene ${completionCalls}. `.repeat(200));
    const error = new Error('context size exceeded');
    error.contextOverflow = true;
    throw error;
  };
  await chat.send('Write a screenplay');
  assert.equal(chat.active.compactions.length, 2);
  assert.ok(!chat.active.messages.some((m) => m.kind === 'error'));
  assert.equal(chat.active.messages.at(-1).content, 'The end.');
  // The user request survives in the summary, and the newest partial stays in
  // context so the continuation picks up where the last one stopped.
  assert.match(chat.context()[0].content, /Summary/);
  assert.equal(chat.active.messages[0].content, 'Write a screenplay');
  assert.equal(completionCalls, 3);
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
test('tools are unavailable without a trusted workspace or when disabled', () => {
  assert.equal(make().tools(), null);
  assert.equal(make({ agentTools: false }, () => ({ root: 'x', trusted: true })).tools(), null);
  assert.equal(make({}, () => ({ root: 'x', trusted: false })).tools(), null);
  assert.ok(make({}, () => ({ root: 'x', trusted: true })).tools().length >= 8);
});
test('tool calls execute inside the workspace and their results feed the next request', async (t) => {
  const dir = await workspace(t);
  await fs.writeFile(path.join(dir, 'notes.txt'), 'alpha\nbeta\n');
  const chat = make({}, () => ({ root: dir, trusted: true }));
  const seen = [];
  let calls = 0;
  chat.request = async (messages, options) => {
    calls++;
    assert.ok(options.tools?.length);
    if (calls === 1)
      return { content: '', toolCalls: [call('c1', 'read_file', { path: 'notes.txt' })] };
    seen.push(...messages);
    options.onToken?.('Done reading.');
    return { content: 'Done reading.', toolCalls: [] };
  };
  await chat.send('Read notes.txt');
  const row = chat.active.messages.find((m) => m.role === 'tool');
  assert.equal(row.status, 'done');
  assert.equal(row.summary, 'read notes.txt');
  assert.match(row.content, /1: alpha/);
  assert.equal(seen.find((m) => m.role === 'tool').tool_call_id, 'c1');
  assert.match(seen.find((m) => m.role === 'tool').content, /alpha/);
  assert.equal(seen.find((m) => m.tool_calls)?.tool_calls[0].function.name, 'read_file');
  assert.match(seen[0].content, /read_file/);
  assert.equal(chat.active.messages.at(-1).content, 'Done reading.');
  assert.equal(chat.active.messages.at(-1).partial, false);
  assert.equal(calls, 2);
  assert.equal(chat.busy, false);
});
test('manual approval prompts the user, honours always, and reports denials to the model', async (t) => {
  const dir = await workspace(t);
  const chat = make({}, () => ({ root: dir, trusted: true }));
  const seen = [];
  let calls = 0;
  chat.request = async (messages) => {
    calls++;
    if (calls <= 2)
      return {
        content: '',
        toolCalls: [call(`c${calls}`, 'write_file', { path: `f${calls}.txt`, content: 'x' })]
      };
    if (calls === 3)
      return { content: '', toolCalls: [call('c3', 'delete_file', { path: 'f1.txt' })] };
    seen.push(...messages);
    return { content: 'ok', toolCalls: [] };
  };
  const answers = ['always', 'no'];
  answerPrompts(chat, (row) => {
    assert.equal(row.prompt.kind, 'approval');
    return answers.shift();
  });
  await chat.send('Make files');
  const rows = chat.active.messages.filter((m) => m.role === 'tool');
  assert.deepEqual(
    rows.map((r) => r.status),
    ['done', 'done', 'denied']
  );
  assert.ok(chat.sessionAllow.has('write_file'));
  assert.ok(await fs.stat(path.join(dir, 'f1.txt')));
  assert.ok(await fs.stat(path.join(dir, 'f2.txt')));
  assert.match(seen.find((m) => m.tool_call_id === 'c3').content, /the user declined/);
  assert.equal(chat.pending.size, 0);
  assert.throws(() => chat.reply('stale', 'yes'), /no longer waiting/);
});
test('auto mode asks the reviewer model and caches ALWAYS verdicts for the session', async (t) => {
  const dir = await workspace(t);
  const chat = make({ approvalMode: 'auto' }, () => ({ root: dir, trusted: true }));
  const reviews = [];
  let calls = 0;
  chat.request = async (messages, options) => {
    if (messages[0].content.startsWith('You review')) {
      assert.equal(options.requestBody.temperature, 0);
      assert.equal(options.tools, undefined);
      reviews.push(messages[1].content);
      return calls === 1 ? 'ALWAYS\nA harmless write.' : 'NO\nToo destructive.';
    }
    calls++;
    if (calls === 1)
      return {
        content: 'Writing.',
        toolCalls: [
          call('c1', 'write_file', { path: 'a.txt', content: '1' }),
          call('c2', 'write_file', { path: 'b.txt', content: '2' })
        ]
      };
    if (calls === 2)
      return { content: '', toolCalls: [call('c3', 'delete_file', { path: 'a.txt' })] };
    return { content: 'finished', toolCalls: [] };
  };
  await chat.send('Make files');
  assert.equal(reviews.length, 2);
  assert.match(reviews[0], /write_file/);
  assert.match(reviews[0], /Make files/);
  assert.match(reviews[1], /delete_file/);
  const rows = chat.active.messages.filter((m) => m.role === 'tool');
  assert.deepEqual(
    rows.map((r) => r.status),
    ['done', 'done', 'denied']
  );
  assert.equal(rows[0].review, 'ALWAYS\nA harmless write.');
  assert.match(rows[2].content, /reviewer declined/);
  assert.ok(await fs.stat(path.join(dir, 'a.txt')));
});
test('permissions set to deny or allow skip prompts entirely', async (t) => {
  const dir = await workspace(t);
  const chat = make(
    { toolPermissions: { run_command: 'deny', write_file: 'allow' } },
    () => ({ root: dir, trusted: true })
  );
  let calls = 0;
  chat.request = async () => {
    calls++;
    if (calls === 1)
      return {
        content: '',
        toolCalls: [
          call('c1', 'run_command', { command: 'echo hi' }),
          call('c2', 'write_file', { path: 'ok.txt', content: 'ok' })
        ]
      };
    return { content: 'done', toolCalls: [] };
  };
  answerPrompts(chat, () => assert.fail('No prompt expected'));
  await chat.send('Go');
  const rows = chat.active.messages.filter((m) => m.role === 'tool');
  assert.deepEqual(
    rows.map((r) => r.status),
    ['denied', 'done']
  );
  assert.match(rows[0].content, /disabled in Settings/);
});
test('ask_user waits for an answer and stopping cancels pending prompts', async (t) => {
  const dir = await workspace(t);
  const chat = make({}, () => ({ root: dir, trusted: true }));
  const seen = [];
  let calls = 0;
  chat.request = async (messages) => {
    calls++;
    if (calls === 1)
      return {
        content: '',
        toolCalls: [call('q1', 'ask_user', { question: 'Which?', options: ['A', 'B'] })]
      };
    seen.push(...messages);
    if (calls === 2)
      return { content: '', toolCalls: [call('q2', 'ask_user', { question: 'Again?' })] };
    return { content: 'never', toolCalls: [] };
  };
  answerPrompts(chat, (row) => {
    assert.equal(row.prompt.kind, 'question');
    if (row.prompt.question === 'Which?') {
      assert.deepEqual(row.prompt.options, ['A', 'B']);
      return 'B';
    }
    queueMicrotask(() => chat.stop());
  });
  await chat.send('Choose');
  assert.equal(seen.find((m) => m.tool_call_id === 'q1').content, 'B');
  const rows = chat.active.messages.filter((m) => m.role === 'tool');
  assert.deepEqual(
    rows.map((r) => r.status),
    ['done', 'cancelled']
  );
  assert.equal(rows[1].prompt, undefined);
  assert.match(chat.active.messages.at(-1).content, /Generation stopped/);
  assert.equal(chat.pending.size, 0);
  assert.equal(chat.busy, false);
  assert.equal(calls, 2);
});
test('interrupted tool rows are cancelled when history loads', async () => {
  const chat = make();
  chat.storage.load = async () => [
    {
      id: 'x',
      title: 'Old',
      messages: [
        {
          id: 't',
          role: 'tool',
          toolCallId: 'c',
          name: 'run_command',
          status: 'awaiting',
          prompt: { id: 'p' }
        }
      ]
    }
  ];
  await chat.load();
  assert.equal(chat.active.messages[0].status, 'cancelled');
  assert.equal(chat.active.messages[0].prompt, undefined);
});
