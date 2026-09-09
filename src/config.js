'use strict';
const path = require('node:path');
const os = require('node:os');
const DEFAULT_COMMAND =
  '"{executable}" -m "{model}" --host {host} --port {port} -c {context} -np 1';
const defaults = {
  installation: 'auto',
  customDirectory: '',
  commandMode: 'one',
  command: DEFAULT_COMMAND,
  modelCommands: [],
  models: [],
  defaultModel: '',
  host: '127.0.0.1',
  port: 8080,
  cwd: '',
  env: {},
  launchOnOpen: false,
  autoRestart: false,
  verbosity: 'info',
  systemPrompt:
    'You are a careful coding assistant. Explain assumptions, reference files, and use fenced code blocks or unified diffs for proposed changes.',
  modelDirectory: path.join(os.homedir(), '.ezllama', 'models'),
  minFreeGB: 2,
  checksum: 'when-available',
  timeoutSeconds: 180,
  startupTimeoutSeconds: 300,
  retries: 1,
  streaming: true,
  concurrency: 1,
  temperature: 0.7,
  maxOutput: 2048,
  context: 8192,
  reservedBuffer: 512,
  autoCompact: true,
  compactionStrategy: 'same',
  compactionModel: '',
  tokenCounting: 'auto',
  saveChats: true,
  retention: 50,
  allowWorkspace: true,
  maxFileKB: 256,
  logging: true,
  sensitiveArguments: ['--api-key', '--hf-token', '-hft'],
  redactionPatterns: [],
  fontSize: 13,
  reducedMotion: false,
  apiPath: '/v1/chat/completions',
  extraBody: {}
};
function configuration(value = {}) {
  // VS Code may return configuration values backed by an IPC proxy. Those values
  // look like plain objects but cannot be passed to structuredClone (which the
  // server uses when it starts). Settings are JSON-only, so normalize them at
  // the boundary into ordinary data objects.
  let provided = {};
  try {
    provided = JSON.parse(JSON.stringify(value));
  } catch {}
  return { ...structuredClone(defaults), ...provided };
}
function parseCommand(command) {
  if (typeof command !== 'string' || !command.trim()) throw new Error('Enter a server command.');
  const args = [];
  let current = '',
    quote = '',
    started = false;
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (ch === '\0' || ch === '\n' || ch === '\r')
      throw new Error('Commands must be a single line.');
    if (quote) {
      if (ch === quote) quote = '';
      else current += ch;
      started = true;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        args.push(current);
        current = '';
        started = false;
      }
    } else {
      if ('|;&<>`'.includes(ch))
        throw new Error(
          'Shell operators are unsupported. Specify an executable and arguments only.'
        );
      current += ch;
      started = true;
    }
  }
  if (quote) throw new Error('Unclosed quote in command.');
  if (started) args.push(current);
  return args;
}
function commandFor(config, id) {
  return config.commandMode === 'one'
    ? config.command
    : (
        config.modelCommands.find((r) => r.modelId === id) ||
        config.modelCommands.find((r) => r.modelId === '*')
      )?.command;
}
function resolveCommand(config, model, executable, custom) {
  const command = custom ?? commandFor(config, model.id);
  if (!command)
    throw new Error(
      'No command for this model. Add a model command or an Otherwise row in Settings.'
    );
  const tokens = parseCommand(command);
  const vars = {
    executable,
    model: model.path,
    host: config.host,
    port: config.port,
    context: model.context || config.context
  };
  const resolved = tokens.map((token) =>
    token.replace(/\{(\w+)\}/g, (_, key) => {
      if (!(key in vars)) throw new Error(`Unknown command placeholder: {${key}}`);
      return String(vars[key]);
    })
  );
  // The installation source always owns the executable; the editor accepts a familiar full command.
  if (!['{executable}', 'llama-server', 'llama-server.exe', executable].includes(tokens[0]))
    throw new Error(
      'The executable must be {executable} or llama-server. Choose its location under llama.cpp installation.'
    );
  resolved[0] = executable;
  const args = resolved.slice(1);
  for (const token of args) {
    if (/^(?:-hf|-hfr|-hff|-hft|-mu|--hf-\w+|--model-url|--docker-repo)(?:=|$)/.test(token))
      throw new Error(
        'Remote model flags are disabled. Download the model explicitly in Settings.'
      );
  }
  // Managed values must agree with readiness checks and context accounting.
  const managed = new Set([
    '-m',
    '--model',
    '--host',
    '--port',
    '-c',
    '--ctx-size',
    '-np',
    '--parallel',
    '--chat-template'
  ]);
  const filtered = [];
  for (let i = 0; i < args.length; i++) {
    const key = args[i].split('=')[0];
    if (managed.has(key)) {
      if (!args[i].includes('=')) {
        if (i + 1 >= args.length) throw new Error(`Missing value for ${key}`);
        i++;
      }
    } else filtered.push(args[i]);
  }
  filtered.push(
    '-m',
    model.path,
    '--host',
    config.host,
    '--port',
    String(config.port),
    '-c',
    String(vars.context),
    '-np',
    '1'
  );
  if (model.chatTemplate) filtered.push('--chat-template', model.chatTemplate);
  if (model.extraArgs) {
    const extra = parseCommand(model.extraArgs);
    if (
      extra.some(
        (t) => managed.has(t.split('=')[0]) || /^(-hf|-mu|--hf-|--model-url|--docker-repo)/.test(t)
      )
    )
      throw new Error(
        'Model overrides cannot replace managed connection/model flags or download models.'
      );
    filtered.push(...extra);
  }
  return { executable, args: filtered };
}
function validateConfig(raw) {
  const c = configuration(raw);
  const errors = {};
  const fail = (key, message) => {
    errors[key] = message;
  };
  for (const [key, min, max] of [
    ['port', 1, 65535],
    ['context', 512, 1048576],
    ['maxOutput', 16, 131072],
    ['reservedBuffer', 64, 65536],
    ['timeoutSeconds', 5, 3600],
    ['startupTimeoutSeconds', 5, 3600],
    ['retries', 0, 5],
    ['retention', 1, 1000],
    ['maxFileKB', 1, 10240],
    ['fontSize', 10, 24],
    ['concurrency', 1, 1]
  ]) {
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max)
      fail(key, `Use an integer from ${min} to ${max}.`);
  }
  if (typeof c.temperature !== 'number' || c.temperature < 0 || c.temperature > 2)
    fail('temperature', 'Use 0–2.');
  if (typeof c.minFreeGB !== 'number' || c.minFreeGB < 0 || c.minFreeGB > 1000)
    fail('minFreeGB', 'Use 0–1000 GB.');
  if (!['127.0.0.1', 'localhost', '::1'].includes(c.host))
    fail('host', 'Use a loopback host: 127.0.0.1, localhost, or ::1.');
  for (const [key, choices] of Object.entries({
    installation: ['auto', 'path', 'custom'],
    commandMode: ['one', 'perModel'],
    compactionStrategy: ['same', 'separate'],
    checksum: ['when-available', 'required'],
    verbosity: ['debug', 'info', 'warning', 'error'],
    tokenCounting: ['auto', 'conservative']
  }))
    if (!choices.includes(c[key])) fail(key, 'Choose a listed option.');
  for (const key of [
    'command',
    'customDirectory',
    'cwd',
    'systemPrompt',
    'modelDirectory',
    'defaultModel',
    'compactionModel',
    'apiPath'
  ])
    if (typeof c[key] !== 'string') fail(key, 'Expected text.');
  for (const key of [
    'launchOnOpen',
    'autoRestart',
    'streaming',
    'autoCompact',
    'saveChats',
    'allowWorkspace',
    'logging',
    'reducedMotion'
  ])
    if (typeof c[key] !== 'boolean') fail(key, 'Expected a toggle.');
  if (typeof c.apiPath !== 'string' || !/^\/[a-zA-Z0-9/_-]+$/.test(c.apiPath))
    fail('apiPath', 'Use a relative API path, e.g. /v1/chat/completions.');
  if (
    !c.env ||
    typeof c.env !== 'object' ||
    Array.isArray(c.env) ||
    Object.entries(c.env).some(([k, v]) => !/^\w+$/.test(k) || typeof v !== 'string')
  )
    fail('env', 'Use a JSON object of string environment variables.');
  if (!c.extraBody || typeof c.extraBody !== 'object' || Array.isArray(c.extraBody))
    fail('extraBody', 'Use a JSON object.');
  for (const key of ['sensitiveArguments', 'redactionPatterns'])
    if (!Array.isArray(c[key]) || c[key].some((x) => typeof x !== 'string'))
      fail(key, 'Use a JSON array of strings.');
  // Literal redactions avoid regular-expression denial of service on server-controlled logs.
  if (!Array.isArray(c.models)) {
    fail('models', 'Expected model rows.');
    c.models = [];
  }
  const ids = new Set();
  for (const m of c.models) {
    if (!m || typeof m.id !== 'string' || ids.has(m.id)) {
      fail('models', 'Each model needs a unique ID.');
      continue;
    }
    ids.add(m.id);
    if (
      typeof m.label !== 'string' ||
      !m.label.trim() ||
      typeof m.path !== 'string' ||
      !m.path.trim()
    )
      fail(`model.${m.id}`, 'A label and path or identifier are required.');
    if (!['local', 'huggingface', 'url'].includes(m.source))
      fail(`model.${m.id}`, 'Select Local, Hugging Face, or HTTPS URL.');
    if (!Number.isInteger(m.context) || m.context < 512 || m.context > 1048576)
      fail(`model.${m.id}`, 'Context must be 512–1048576.');
    if (m.checksum && !/^[a-fA-F0-9]{64}$/.test(m.checksum))
      fail(`model.${m.id}`, 'SHA-256 must contain 64 hexadecimal characters.');
  }
  if (!Array.isArray(c.modelCommands)) {
    fail('modelCommands', 'Expected command rows.');
    c.modelCommands = [];
  }
  const rows = new Set();
  for (const row of c.modelCommands) {
    if (!row || rows.has(row.modelId) || (row.modelId !== '*' && !ids.has(row.modelId))) {
      fail('modelCommands', 'Use one row per configured model and at most one Otherwise.');
      continue;
    }
    rows.add(row.modelId);
    try {
      parseCommand(row.command);
    } catch (e) {
      fail(`command.${row.modelId}`, e.message);
    }
  }
  try {
    parseCommand(c.command);
  } catch (e) {
    fail('command', e.message);
  }
  if (c.defaultModel && !ids.has(c.defaultModel)) fail('defaultModel', 'Choose an added model.');
  if (c.compactionStrategy === 'separate' && !ids.has(c.compactionModel))
    fail('compactionModel', 'Choose a compaction model.');
  if (c.maxOutput + c.reservedBuffer >= c.context)
    fail('maxOutput', 'Output and reserved buffer must fit within the default context.');
  if (
    typeof c.modelDirectory !== 'string' ||
    !c.modelDirectory ||
    !path.isAbsolute(c.modelDirectory)
  )
    fail('modelDirectory', 'Use an absolute download directory.');
  return { config: c, errors };
}
module.exports = {
  defaults,
  configuration,
  validateConfig,
  parseCommand,
  commandFor,
  resolveCommand
};
