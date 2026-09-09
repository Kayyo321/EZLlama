'use strict';
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { EventEmitter } = require('node:events');
const net = require('node:net');
const { resolveCommand } = require('./config');
const exec = promisify(execFile);
const delay = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('Cancelled.'));
    const cancel = () => {
      clearTimeout(timer);
      reject(new Error('Cancelled.'));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', cancel);
      resolve();
    }, ms);
    signal?.addEventListener('abort', cancel, { once: true });
  });
class Logger extends EventEmitter {
  constructor(getConfig, secrets = () => []) {
    super();
    this.config = getConfig;
    this.secrets = secrets;
    this.lines = [];
    this.next = 0;
  }
  redact(value) {
    let text = String(value);
    const c = this.config();
    const literals = [
      ...this.secrets(),
      ...(c.redactionPatterns || []),
      ...Object.entries(c.env || {})
        .filter(([k]) => /key|token|secret|password/i.test(k))
        .map(([, v]) => v)
    ];
    for (const literal of literals.filter((x) => typeof x === 'string' && x.length))
      text = text.split(literal).join('[REDACTED]');
    for (const arg of c.sensitiveArguments || []) {
      const escaped = arg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(
        new RegExp(`(${escaped}(?:[=\\s]+))(?:("[^"]*")|('[^']*')|([^\\s]+))`, 'gi'),
        '$1[REDACTED]'
      );
      text = text.replace(
        new RegExp(`("${escaped}"\\s*,\\s*)"(?:[^"\\\\]|\\\\.)*"`, 'gi'),
        '$1"[REDACTED]"'
      );
    }
    return text
      .replace(/(Bearer\s+)[\w.\-]+/gi, '$1[REDACTED]')
      .replace(
        /((?:api[_-]?key|access[_-]?token|password|secret)\s*[=:]\s*)[^\s,;]+/gi,
        '$1[REDACTED]'
      )
      .replace(/hf_[A-Za-z0-9]{10,}/g, '[REDACTED]');
  }
  add(source, level, message) {
    if (!this.config().logging) return;
    if (
      ['debug', 'info', 'warning', 'error'].indexOf(level) <
      ['debug', 'info', 'warning', 'error'].indexOf(this.config().verbosity)
    )
      return;
    const row = {
      id: ++this.next,
      time: new Date().toISOString(),
      source,
      level,
      message: this.redact(message).slice(0, 16000)
    };
    this.lines.push(row);
    if (this.lines.length > 5000) this.lines.shift();
    this.emit('line', row);
  }
}
async function hashFile(file, signal) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of createReadStream(file)) {
    if (signal?.aborted) throw new Error('Cancelled.');
    hash.update(chunk);
  }
  return hash.digest('hex');
}
async function validateModel(file, expectedHash, signal) {
  const stat = await fs.stat(file);
  if (!stat.isFile() || stat.size < 24) throw new Error('Model must be a nonempty GGUF file.');
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(24);
    await handle.read(header, 0, 24, 0);
    if (header.toString('ascii', 0, 4) !== 'GGUF' || ![2, 3].includes(header.readUInt32LE(4)))
      throw new Error('Invalid or unsupported GGUF header (expected GGUF v2/v3).');
    if (header.readBigUInt64LE(8) === 0n) throw new Error('GGUF has no tensors.');
  } finally {
    await handle.close();
  }
  if (expectedHash && (await hashFile(file, signal)).toLowerCase() !== expectedHash.toLowerCase())
    throw new Error('SHA-256 mismatch. The artifact was not accepted.');
  return {
    size: stat.size,
    details: `GGUF header valid · ${(stat.size / 2 ** 30).toFixed(2)} GiB${expectedHash ? ' · SHA-256 verified' : ' · no reference checksum; full tensor validation occurs on server load'}`
  };
}
async function modelMetadata(file) {
  // Read only a bounded prefix. Large tokenizer arrays need not be loaded for a recommendation.
  const handle = await fs.open(file, 'r');
  const result = {};
  try {
    const stat = await handle.stat();
    const data = Buffer.alloc(Math.min(stat.size, 2 * 1024 * 1024));
    await handle.read(data, 0, data.length, 0);
    let offset = 24;
    const ensure = (n) => {
      if (offset + n > data.length) throw new Error('Metadata prefix exhausted');
    };
    const uint64 = () => {
      ensure(8);
      const n = Number(data.readBigUInt64LE(offset));
      offset += 8;
      if (!Number.isSafeInteger(n)) throw new Error('Invalid GGUF size');
      return n;
    };
    const string = () => {
      const size = uint64();
      ensure(size);
      const value = data.toString('utf8', offset, offset + size);
      offset += size;
      return value;
    };
    const value = (type, depth = 0) => {
      if (depth > 2) throw new Error('Nested metadata array');
      if (type === 8) return string();
      if (type === 9) {
        ensure(4);
        const subtype = data.readUInt32LE(offset);
        offset += 4;
        const count = uint64();
        if (count > 1000000) throw new Error('Metadata array too large');
        for (let i = 0; i < count; i++) value(subtype, depth + 1);
        return undefined;
      }
      const sizes = { 0: 1, 1: 1, 2: 2, 3: 2, 4: 4, 5: 4, 6: 4, 7: 1, 10: 8, 11: 8, 12: 8 };
      const size = sizes[type];
      if (!size) throw new Error('Unknown metadata type');
      ensure(size);
      const at = offset;
      offset += size;
      return type === 4
        ? data.readUInt32LE(at)
        : type === 5
          ? data.readInt32LE(at)
          : type === 8
            ? undefined
            : undefined;
    };
    const count = Number(data.readBigUInt64LE(16));
    for (let i = 0; i < Math.min(count, 10000); i++) {
      const key = string();
      ensure(4);
      const type = data.readUInt32LE(offset);
      offset += 4;
      const item = value(type);
      if (
        /^(general\.(architecture|name|file_type))$|\.(context_length|block_count|embedding_length)$/.test(
          key
        )
      )
        result[key] = item;
    }
  } catch {
    result.note = 'Only metadata available in the first 2 MiB was inspected.';
  } finally {
    await handle.close();
  }
  return result;
}
async function run(executable, args, options = {}) {
  return exec(executable, args, {
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 4 * 1024 * 1024,
    ...options
  });
}
async function findBinary(directory) {
  const name = process.platform === 'win32' ? 'llama-server.exe' : 'llama-server';
  for (const sub of ['', 'bin', 'build/bin', 'build/bin/Release']) {
    const candidate = path.join(directory, sub, name);
    try {
      if ((await fs.stat(candidate)).isFile()) return candidate;
    } catch {}
  }
  // Release archives often contain one versioned top-level directory.
  for (const entry of await fs.readdir(directory, { withFileTypes: true }).catch(() => []))
    if (entry.isDirectory()) {
      for (const sub of ['', 'bin']) {
        const candidate = path.join(directory, entry.name, sub, name);
        try {
          if ((await fs.stat(candidate)).isFile()) return candidate;
        } catch {}
      }
    }
  throw new Error(`No ${name} found in ${directory}.`);
}
async function installation(config, autoDirectory) {
  let executable;
  if (config.installation === 'auto')
    executable = await findBinary(autoDirectory).catch(() => {
      throw new Error(
        'llama.cpp has not been installed. Open Settings and press Download llama.cpp.'
      );
    });
  else if (config.installation === 'custom') {
    if (!path.isAbsolute(config.customDirectory))
      throw new Error('Choose an absolute custom directory.');
    executable = await findBinary(config.customDirectory);
  } else {
    for (const dir of (process.env.PATH || '').split(path.delimiter)) {
      try {
        const p = path.join(
          dir.replace(/^"|"$/g, ''),
          process.platform === 'win32' ? 'llama-server.exe' : 'llama-server'
        );
        if ((await fs.stat(p)).isFile()) {
          executable = p;
          break;
        }
      } catch {}
    }
    if (!executable)
      throw new Error(
        'llama-server was not found on PATH. Install it or choose a custom directory.'
      );
  }
  const version = await run(executable, ['--version']);
  const help = await run(executable, ['--help']);
  const capabilities = help.stdout + '\n' + help.stderr;
  if (!capabilities.includes('--port') || !capabilities.includes('--model'))
    throw new Error('The executable is not a compatible llama-server.');
  return {
    executable,
    version: (version.stdout + '\n' + version.stderr).trim().slice(0, 1000),
    capabilities
  };
}
async function recommend(config, model, binary) {
  const report = {
    os: `${os.platform()} ${os.arch()}`,
    cpu: os.cpus()[0]?.model || 'Unknown',
    threads: Math.max(1, Math.floor(os.availableParallelism() / 2)),
    ramGB: Math.round(os.totalmem() / 2 ** 30),
    freeGB: Math.round(os.freemem() / 2 ** 30),
    gpu: 'CPU fallback',
    notes: []
  };
  let layers = 0,
    vram = 0;
  try {
    const devices = await run(binary.executable, ['--list-devices']);
    report.devices = (devices.stdout + '\n' + devices.stderr).trim();
    if (/CUDA|Vulkan|Metal|ROCm|SYCL/i.test(report.devices)) {
      report.gpu = report.devices.slice(0, 1500);
      try {
        const result = await run('nvidia-smi', [
          '--query-gpu=memory.free',
          '--format=csv,noheader,nounits'
        ]);
        vram = Math.max(...result.stdout.trim().split('\n').map(Number)) * 2 ** 20;
      } catch {}
      if (os.platform() === 'darwin') vram = os.freemem() * 0.65;
      const size = model?.source === 'local' ? (await fs.stat(model.path)).size : 0;
      if (size && vram > size * 1.25 + 512 * 2 ** 20) layers = 99;
      else
        report.notes.push(
          'Free GPU memory or model size was not sufficient to recommend full offload. Start with CPU; increase GPU layers after measuring.'
        );
    } else report.notes.push('No supported GPU backend was reported by the installed binary.');
  } catch (e) {
    report.notes.push(`GPU detection unavailable: ${e.message}. Using CPU.`);
  }
  if (!binary.capabilities)
    report.notes.push(
      'Binary capability detection unavailable. Verify the command against your installed version.'
    );
  const context = model?.context || config.context;
  if (model?.source === 'local') {
    try {
      report.metadata = await modelMetadata(model.path);
      const trained = report.metadata[`${report.metadata['general.architecture']}.context_length`];
      if (trained && context > trained)
        report.notes.push(
          `Requested context exceeds the model's ${trained}-token training context. Reduce context unless you have configured compatible rope scaling.`
        );
    } catch (e) {
      report.notes.push(`GGUF metadata unavailable: ${e.message}`);
    }
  }
  if (model?.source === 'local') {
    try {
      const size = (await fs.stat(model.path)).size;
      if (size * 1.2 > os.freemem() + vram)
        report.notes.push(
          'Model weights may exceed available memory. Choose a smaller quantization/model.'
        );
    } catch {}
  }
  report.notes.push(
    `Requested context: ${context}. GGUF weights and runtime KV-cache memory determine the final fit; this is a conservative recommendation, not a benchmark.`
  );
  let command = '"{executable}" -m "{model}" --host {host} --port {port} -c {context} -np 1';
  for (const [flag, value] of [
    ['--threads', report.threads],
    ['--batch-size', report.freeGB >= 16 ? 512 : 128],
    ['--gpu-layers', layers]
  ])
    if (!binary.capabilities || binary.capabilities.includes(flag)) command += ` ${flag} ${value}`;
  return { command, report };
}
class Server extends EventEmitter {
  constructor(log) {
    super();
    this.log = log;
    this.state = 'stopped';
    this.child = null;
    this.modelId = '';
    this.context = 0;
    this.restartCount = 0;
  }
  setState(state, error = '') {
    this.state = state;
    this.error = error;
    this.emit('state');
    this.log.add('server', error ? 'error' : 'info', `${state}${error ? ': ' + error : ''}`);
  }
  get url() {
    return `http://${this.config.host === '::1' ? '[::1]' : this.config.host}:${this.config.port}`;
  }
  async start(config, model, binary, custom) {
    if (this.state !== 'stopped')
      throw new Error('Stop the active server before starting another model.');
    this.config = structuredClone(config);
    this.modelId = model.id;
    this.startController = new AbortController();
    const signal = this.startController.signal;
    this.setState('starting');
    try {
      await validateModel(model.path, undefined, signal);
      const command = resolveCommand(config, model, binary.executable, custom);
      if (binary.apiKey) {
        command.args.push('--api-key', binary.apiKey);
        this.apiKey = binary.apiKey;
      } else this.apiKey = '';
      if (config.cwd && !(await fs.stat(config.cwd)).isDirectory())
        throw new Error('Working directory must be a directory.');
      await new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', () =>
          reject(new Error(`Port ${config.port} is already in use. Choose another port.`))
        );
        probe.listen(config.port, config.host, () => probe.close(resolve));
      });
      if (signal.aborted) throw new Error('Start cancelled.');
      this.log.add(
        'server',
        'info',
        `Model: ${model.label}\nResolved command: ${JSON.stringify(command)}`
      );
      const env = { ...process.env, ...config.env };
      // Prevent inherited llama.cpp environment from downloading or overriding managed settings.
      for (const key of Object.keys(env)) if (key.startsWith('LLAMA_ARG_')) delete env[key];
      const child = spawn(command.executable, command.args, {
        cwd: config.cwd || path.dirname(command.executable),
        env,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      this.child = child;
      for (const [stream, level] of [
        [child.stdout, 'info'],
        [child.stderr, 'info']
      ]) {
        let pending = '';
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          pending += chunk;
          const lines = pending.split(/\r?\n/);
          pending = lines.pop();
          for (const line of lines)
            this.log.add('server', /error|failed/i.test(line) ? 'error' : level, line);
          if (pending.length > 16000) {
            this.log.add('server', level, pending);
            pending = '';
          }
        });
        stream.on('end', () => {
          if (pending) this.log.add('server', level, pending);
        });
      }
      child.on('error', (e) => {
        if (this.child === child) {
          this.child = null;
          this.setState('stopped', e.message);
        }
      });
      child.on('exit', (code) => {
        if (this.child !== child) return;
        const unexpected = this.state === 'running';
        this.child = null;
        this.setState(
          'stopped',
          unexpected
            ? `Server exited (${code}).`
            : this.state === 'starting'
              ? `Server exited during startup (${code}); inspect Console.`
              : ''
        );
        if (unexpected) this.emit('unexpectedExit', { config, model, binary, custom });
      });
      const deadline = Date.now() + config.startupTimeoutSeconds * 1000;
      while (Date.now() < deadline) {
        if (signal.aborted) throw new Error('Start cancelled.');
        if (this.state === 'stopped')
          throw new Error(this.error || 'Server stopped during startup.');
        try {
          const health = await fetch(this.url + '/health', {
            headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
            signal: AbortSignal.any([signal, AbortSignal.timeout(1500)])
          });
          if (health.ok) {
            this.context = model.context || config.context;
            try {
              const props = await fetch(this.url + '/props', {
                headers: this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {},
                signal: AbortSignal.timeout(2000)
              }).then((r) => r.json());
              this.context = props.default_generation_settings?.n_ctx || this.context;
            } catch {}
            if (signal.aborted || this.child !== child) throw new Error('Start cancelled.');
            this.setState('running');
            return;
          }
        } catch (e) {
          if (signal.aborted) throw e;
        }
        await delay(350, signal);
      }
      throw new Error('Server readiness timed out. Check the model, memory, and Console.');
    } catch (e) {
      await this.stop();
      this.setState('stopped', e.message);
      throw e;
    }
  }
  async stop() {
    this.startController?.abort();
    if (!this.child) {
      this.setState('stopped');
      return;
    }
    const child = this.child;
    this.setState('stopping');
    if (process.platform === 'win32')
      await run('taskkill', ['/pid', String(child.pid), '/T', '/F']).catch(() => {});
    else {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        child.kill('SIGTERM');
      }
    }
    await Promise.race([
      new Promise((resolve) => {
        if (child.exitCode !== null || child.signalCode) resolve();
        else child.once('exit', resolve);
      }),
      delay(3000)
    ]);
    if (this.child === child) {
      try {
        if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
        else child.kill();
      } catch {}
      await Promise.race([
        new Promise((resolve) => {
          if (child.exitCode !== null || child.signalCode) resolve();
          else child.once('exit', resolve);
        }),
        delay(2000)
      ]);
      if (child.exitCode === null && !child.signalCode) {
        this.setState(
          'running',
          'The process did not exit. Retry Stop or inspect the process in your OS.'
        );
        throw new Error(this.error);
      }
      if (this.child === child) this.child = null;
    }
    this.setState('stopped');
  }
}
async function completion(base, config, messages, { signal, onToken, apiKey, maxOutput } = {}) {
  const abort = AbortSignal.any([
    ...(signal ? [signal] : []),
    AbortSignal.timeout(config.timeoutSeconds * 1000)
  ]);
  const response = await fetch(base + config.apiPath, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
    },
    signal: abort,
    body: JSON.stringify({
      ...config.extraBody,
      messages,
      temperature: config.temperature,
      max_tokens: maxOutput || config.maxOutput,
      stream: config.streaming
    })
  });
  if (!response.ok) {
    const body = (await response.text()).slice(0, 3000);
    const error = new Error(`HTTP ${response.status}: ${body}`);
    error.contextOverflow =
      response.status === 400 && /context|token|too long|too large/i.test(body);
    error.retryable = response.status === 429 || response.status >= 500;
    throw error;
  }
  if (!config.streaming) {
    const data = await response.json();
    const result = data.choices?.[0]?.message?.content;
    if (typeof result !== 'string') throw new Error('Server returned no assistant content.');
    onToken?.(result);
    return result;
  }
  let result = '',
    buffer = '',
    done = false;
  const decoder = new TextDecoder();
  const consume = (event) => {
    const payload = event
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!payload) return;
    if (payload === '[DONE]') {
      done = true;
      return;
    }
    const data = JSON.parse(payload);
    if (data.error) throw new Error(data.error.message || JSON.stringify(data.error));
    const delta = data.choices?.[0]?.delta?.content || '';
    result += delta;
    if (delta) onToken?.(delta);
  };
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/g, '\n');
    let split;
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      consume(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);
    }
    if (done) break;
  }
  buffer += decoder.decode();
  if (buffer.trim()) consume(buffer);
  if (!done)
    throw new Error(
      'The streaming connection ended before completion. Partial output has been preserved.'
    );
  return result;
}
async function countTokens(base, messages, mode, signal, apiKey) {
  const content = messages.map((m) => `${m.role}: ${m.content}`).join('\n');
  if (mode === 'auto')
    try {
      const r = await fetch(base + '/tokenize', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify({ content, add_special: true }),
        signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(4000)])
      });
      const data = await r.json();
      if (Array.isArray(data.tokens)) return data.tokens.length + messages.length * 16 + 32;
    } catch {}
  // UTF-8 bytes are a deliberately conservative upper bound, including non-English text/code.
  return Buffer.byteLength(content, 'utf8') + messages.length * 16 + 32;
}
module.exports = {
  Logger,
  hashFile,
  validateModel,
  modelMetadata,
  installation,
  findBinary,
  recommend,
  run,
  Server,
  completion,
  countTokens,
  delay
};
