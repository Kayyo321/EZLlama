'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Logger, completion, completionDetailed, countTokens, validateModel } = require('../src/runtime');
const { configuration } = require('../src/config');
test('secrets, sensitive flags and literal redactions are removed', () => {
  const log = new Logger(
    () => configuration({ env: { API_KEY: 'env-secret' }, redactionPatterns: ['private-text'] }),
    () => ['stored-secret']
  );
  assert.equal(
    log.redact(
      'stored-secret env-secret private-text --api-key "abc def" Authorization: Bearer token.xyz'
    ),
    '[REDACTED] [REDACTED] [REDACTED] --api-key [REDACTED] Authorization: Bearer [REDACTED]'
  );
});
test('SSE handles split UTF-8, CRLF, role-only events and clean completion', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    const data = Buffer.from(
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\r\n\r\ndata: {"choices":[{"delta":{"content":"héllo"}}]}\r\n\r\ndata: [DONE]\r\n\r\n'
    );
    for (let i = 0; i < data.length; i += 3) res.write(data.subarray(i, i + 3));
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  let text = '';
  const result = await completion(
    `http://127.0.0.1:${server.address().port}`,
    configuration(),
    [{ role: 'user', content: 'Hi' }],
    { onToken: (x) => (text += x) }
  );
  assert.equal(result, 'héllo');
  assert.equal(text, result);
});
test('broken streams are errors and preserve received tokens', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200);
    res.end('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  let partial = '';
  await assert.rejects(
    completion(`http://127.0.0.1:${server.address().port}`, configuration(), [], {
      onToken: (x) => (partial += x)
    }),
    /ended before completion/
  );
  assert.equal(partial, 'partial');
});
test('length finish is surfaced after preserving streamed output', async (t) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"content":"partial"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n' +
        'data: [DONE]\n\n'
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  let partial = '';
  await assert.rejects(
    completion(`http://127.0.0.1:${server.address().port}`, configuration(), [], {
      onToken: (x) => (partial += x)
    }),
    (error) => error.outputLimit === true && error.partialOutput === 'partial'
  );
  assert.equal(partial, 'partial');
});
test('request-specific body options override configured extras', async (t) => {
  let body;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks));
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'summary' } }] })
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const config = configuration({ streaming: false, extraBody: { reasoning_effort: 'high' } });
  assert.equal(
    await completion(`http://127.0.0.1:${server.address().port}`, config, [], {
      requestBody: { reasoning_effort: 'none' }
    }),
    'summary'
  );
  assert.equal(body.reasoning_effort, 'none');
});
test('GGUF validation rejects HTML and verifies reference hashes', async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ezllama-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'model.gguf');
  await fs.writeFile(file, '<html>This is an error response</html>');
  await assert.rejects(validateModel(file), /GGUF/);
  const header = Buffer.alloc(24);
  header.write('GGUF');
  header.writeUInt32LE(3, 4);
  header.writeBigUInt64LE(1n, 8);
  await fs.writeFile(file, header);
  assert.equal((await validateModel(file)).size, 24);
  await assert.rejects(validateModel(file, '0'.repeat(64)), /SHA-256/);
});
test('conservative fallback budgets non-ASCII bytes', async () => {
  const messages = [{ role: 'user', content: '你好' }];
  assert.ok((await countTokens('', messages, 'conservative')) >= Buffer.byteLength('你好'));
});
test('streamed tool calls are assembled from indexed fragments', async (t) => {
  let body;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    body = JSON.parse(Buffer.concat(chunks));
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.end(
      'data: {"choices":[{"delta":{"role":"assistant","content":"Let me look. "}}]}\n\n' +
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"read_file","arguments":"{\\"pa"}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"a.txt\\"}"}}]}}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
        'data: [DONE]\n\n'
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const tools = [{ type: 'function', function: { name: 'read_file', parameters: {} } }];
  const result = await completionDetailed(
    `http://127.0.0.1:${server.address().port}`,
    configuration(),
    [{ role: 'user', content: 'Read it' }],
    { tools }
  );
  assert.equal(result.content, 'Let me look. ');
  assert.deepEqual(result.toolCalls, [
    { id: 'call_1', name: 'read_file', arguments: '{"path":"a.txt"}' }
  ]);
  assert.equal(result.finishReason, 'tool_calls');
  assert.deepEqual(body.tools, tools);
  assert.equal(body.tool_choice, 'auto');
});
test('non-streaming responses expose tool calls even when content is null', async (t) => {
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    res.setHeader('Content-Type', 'application/json');
    res.end(
      JSON.stringify({
        choices: [
          {
            finish_reason: body.tools ? 'tool_calls' : 'stop',
            message: {
              content: null,
              ...(body.tools
                ? {
                    tool_calls: [
                      {
                        id: 'x',
                        type: 'function',
                        function: { name: 'run_command', arguments: '{"command":"ls"}' }
                      }
                    ]
                  }
                : {})
            }
          }
        ]
      })
    );
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const result = await completionDetailed(
    `http://127.0.0.1:${server.address().port}`,
    configuration({ streaming: false }),
    [],
    { tools: [{ type: 'function', function: { name: 'run_command' } }] }
  );
  assert.equal(result.content, '');
  assert.deepEqual(result.toolCalls, [{ id: 'x', name: 'run_command', arguments: '{"command":"ls"}' }]);
  await assert.rejects(
    completion(`http://127.0.0.1:${server.address().port}`, configuration({ streaming: false }), []),
    /no assistant content/
  );
});
