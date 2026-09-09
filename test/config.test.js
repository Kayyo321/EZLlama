'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  configuration,
  validateConfig,
  parseCommand,
  resolveCommand,
  commandFor
} = require('../src/config');
test('Windows paths and quoted arguments survive parsing without shell execution', () => {
  assert.deepEqual(
    parseCommand('"C:\\AI Models\\llama-server.exe" -m "D:\\my model.gguf" --x \'a b\''),
    ['C:\\AI Models\\llama-server.exe', '-m', 'D:\\my model.gguf', '--x', 'a b']
  );
  assert.throws(() => parseCommand('llama-server && calc'));
  assert.throws(() => parseCommand('"unterminated'));
  assert.throws(() => parseCommand('llama-server\ncalc'));
});
test('per-model command takes precedence and never silently uses shared command', () => {
  const c = configuration({
    commandMode: 'perModel',
    modelCommands: [
      { modelId: 'a', command: 'a' },
      { modelId: '*', command: 'fallback' }
    ]
  });
  assert.equal(commandFor(c, 'a'), 'a');
  assert.equal(commandFor(c, 'b'), 'fallback');
  c.modelCommands.pop();
  assert.equal(commandFor(c, 'b'), undefined);
});
test('managed flags use selected source and preserve model argument boundaries', () => {
  const c = configuration();
  const model = { id: 'a', path: 'D:\\my model.gguf', context: 4096 };
  const result = resolveCommand(c, model, 'C:\\llama-server.exe');
  assert.equal(result.executable, 'C:\\llama-server.exe');
  assert.equal(result.args[result.args.indexOf('-m') + 1], model.path);
  assert.equal(result.args[result.args.indexOf('-c') + 1], '4096');
  assert.throws(() => resolveCommand(c, model, 'server', '"{executable}" --hf-repo evil/model'));
  assert.throws(() => resolveCommand(c, model, 'server', 'powershell -c calc'));
});
test('configuration rejects duplicate Otherwise rows, bad ports, invalid JSON objects', () => {
  assert.deepEqual(validateConfig({}).errors, {});
  const { errors } = validateConfig({
    port: 70000,
    env: [],
    modelCommands: [
      { modelId: '*', command: 'x' },
      { modelId: '*', command: 'x' }
    ]
  });
  assert.ok(errors.port);
  assert.ok(errors.env);
  assert.ok(errors.modelCommands);
});
