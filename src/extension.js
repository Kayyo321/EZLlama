'use strict';
const vscode = require('vscode');
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { configuration, validateConfig, commandFor, resolveCommand } = require('./config');
const { Logger, Server, installation, recommend, validateModel } = require('./runtime');
const { downloadModel, releasePlan, installRelease } = require('./downloads');
const { Chat } = require('./chat');
const presets = require('../data/presets.json');
let instance;
class Extension {
  constructor(context) {
    this.context = context;
    this.root = context.globalStorageUri.fsPath;
    this.autoDirectory = context.globalState.get(
      'autoDirectory',
      path.join(this.root, 'llama.cpp', 'not-installed')
    );
    const initial = validateConfig(vscode.workspace.getConfiguration('ezllama').get('config'));
    this.config = Object.keys(initial.errors).length ? configuration() : initial.config;
    this.secrets = [];
    this.log = new Logger(
      () => this.config,
      () => this.secrets
    );
    this.server = new Server(this.log);
    this.views = new Set();
    this.attachments = [];
    this.validations = {};
    this.validationCache = new Map();
    this.jobs = new Map();
    this.errors = initial.errors;
    this.selected = this.config.defaultModel;
    this.installInfo = null;
    this.chat = new Chat({
      getConfig: () => this.config,
      server: this.server,
      log: this.log,
      getKey: () => context.secrets.get('apiKey'),
      workspace: () => ({
        root: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
        trusted: vscode.workspace.isTrusted
      }),
      switchModel: async (id) => {
        if (this.disposed || this.stopRequested) throw new Error('Model switch cancelled.');
        await this.server.stop();
        if (this.disposed || this.stopRequested) throw new Error('Model switch cancelled.');
        await this.start(id);
      },
      storage: {
        load: async () => {
          try {
            return JSON.parse(await fs.readFile(path.join(this.root, 'chats.json'), 'utf8'));
          } catch (e) {
            if (e.code !== 'ENOENT')
              this.log.add(
                'extension',
                'error',
                'Chat history could not be read; the original file will be preserved.'
              );
            if (e.code !== 'ENOENT')
              await fs.copyFile(
                path.join(this.root, 'chats.json'),
                path.join(this.root, `chats-recovery-${Date.now()}.json`)
              );
            return [];
          }
        },
        save: async (chats) => {
          await fs.mkdir(this.root, { recursive: true });
          const temp = path.join(this.root, 'chats.tmp');
          await fs.writeFile(temp, JSON.stringify(chats), { mode: 0o600 });
          await fs.rename(temp, path.join(this.root, 'chats.json'));
        }
      }
    });
    this.server.on('state', () => this.broadcast());
    this.log.on('line', (row) => this.post({ type: 'log', row }));
    this.chat.on('change', () => this.broadcast());
    this.chat.on('token', (token) => this.post({ type: 'token', ...token }));
    this.chat.on('progress', (text) => this.post({ type: 'progress', text }));
    this.server.on('unexpectedExit', async () => {
      this.chat.stop();
      if (this.chat.active) this.chat.note(this.server.error, 'error');
      if (this.config.autoRestart && this.server.restartCount++ < 3) {
        this.log.add('server', 'warning', 'Automatic restart scheduled (maximum 3).');
        this.restartTimer = setTimeout(
          () => this.start(this.selected).catch((e) => this.report(e)),
          1500
        );
      }
    });
  }
  async init() {
    await this.refreshSecrets();
    await this.chat.load();
    await this.validateModels();
    if (Object.keys(this.errors).length)
      this.log.add(
        'extension',
        'error',
        'Saved configuration is invalid. Safe defaults are active; the original ezllama.config remains unchanged in VS Code user settings until you save corrected settings.'
      );
    this.log.add(
      'extension',
      'info',
      'EZLlama ready. No downloads occur without an explicit Settings action.'
    );
    if (this.config.launchOnOpen && this.selected && vscode.workspace.isTrusted)
      await this.start(this.selected).catch((e) => this.report(e));
  }
  async refreshSecrets() {
    this.secrets = (
      await Promise.all(['apiKey', 'hfToken'].map((k) => this.context.secrets.get(k)))
    ).filter(Boolean);
  }
  post(message) {
    for (const view of this.views) view.webview.postMessage(message);
  }
  state() {
    return {
      config: this.config,
      errors: this.errors,
      server: {
        state: this.starting && this.server.state === 'stopped' ? 'starting' : this.server.state,
        error: this.log.redact(this.server.error || ''),
        modelId: this.server.modelId,
        context: this.server.context
      },
      selected: this.selected,
      validations: this.validations,
      installation: this.installInfo,
      active: this.chat.active,
      chats: this.chat.chats.map((c) => ({ id: c.id, title: c.title, created: c.created })),
      busy: this.chat.busy,
      attachments: this.attachments.map(({ id, name, path }) => ({ id, name, path })),
      jobs: [...this.jobs.keys()],
      approvals: [...this.chat.sessionAllow],
      workspace: !!vscode.workspace.workspaceFolders?.length && vscode.workspace.isTrusted,
      presets,
      hasApiKey: !!this.secrets.length
    };
  }
  broadcast() {
    this.post({ type: 'state', state: this.state() });
  }
  report(error) {
    this.log.add('extension', 'error', error.message);
    this.post({ type: 'error', text: this.log.redact(error.message) });
  }
  resolveWebviewView(view) {
    this.views.add(view);
    view.onDidDispose(() => this.views.delete(view));
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, 'media')]
    };
    const media = (name) =>
      view.webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'media', name));
    const nonce = crypto.randomBytes(24).toString('hex');
    view.webview.html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${view.webview.cspSource} data:; style-src ${view.webview.cspSource}; script-src 'nonce-${nonce}';"><link rel="stylesheet" href="${media('style.css')}"><title>EZLlama</title></head><body><div id="app"></div>${['vendor/marked.js', 'vendor/purify.js', 'vendor/highlight.js', 'app.js'].map((file) => `<script nonce="${nonce}" src="${media(file)}"></script>`).join('')}</body></html>`;
    view.webview.onDidReceiveMessage((message) =>
      this.handle(message).catch((e) => this.report(e))
    );
  }
  async validateModels() {
    const entries = await Promise.all(
      this.config.models.map(async (m) => {
        try {
          if (m.source !== 'local')
            return [m.id, { valid: false, details: 'Download this model to make it available.' }];
          const stat = await fs.stat(m.path);
          const cacheKey = JSON.stringify([m.path, stat.size, stat.mtimeMs, m.checksum]);
          let result = this.validationCache.get(cacheKey);
          if (!result) {
            if (m.checksum)
              this.post({ type: 'progress', text: `Verifying SHA-256 for ${m.label}…` });
            result = await validateModel(m.path, m.checksum || undefined);
            this.validationCache.set(cacheKey, result);
          }
          if (!commandFor(this.config, m.id))
            throw new Error('No usable command. Add a per-model command or Otherwise.');
          return [m.id, { valid: true, ...result }];
        } catch (e) {
          return [m.id, { valid: false, details: e.message }];
        }
      })
    );
    this.validations = Object.fromEntries(entries);
    this.broadcast();
  }
  async save(raw) {
    if (this.jobs.size)
      throw new Error('Wait for the current download or installation before saving settings.');
    if (this.chat.busy || this.starting)
      throw new Error('Stop generation or wait for startup before saving settings.');
    const result = validateConfig(raw);
    this.errors = result.errors;
    if (Object.keys(this.errors).length) {
      this.broadcast();
      return false;
    }
    await vscode.workspace
      .getConfiguration('ezllama')
      .update('config', result.config, vscode.ConfigurationTarget.Global);
    this.config = result.config;
    await this.validateModels();
    this.chat.changed();
    this.broadcast();
    return true;
  }
  async binary() {
    this.installInfo = await installation(this.config, this.autoDirectory);
    this.broadcast();
    return this.installInfo;
  }
  async start(id, custom) {
    if (this.disposed) throw new Error('EZLlama is shutting down.');
    if (!vscode.workspace.isTrusted)
      throw new Error('Trust this workspace before launching a process.');
    const check = validateConfig(this.config);
    if (Object.keys(check.errors).length) {
      this.errors = check.errors;
      this.broadcast();
      throw new Error('Fix the highlighted settings before starting.');
    }
    const model = this.config.models.find((m) => m.id === id);
    if (!model || model.source !== 'local')
      throw new Error('Choose a downloaded, valid local model in Settings.');
    if (this.starting) throw new Error('A server start is already pending.');
    this.starting = true;
    this.stopRequested = false;
    this.cancelStart = false;
    this.selected = id;
    this.broadcast();
    try {
      const binary = await this.binary();
      if (this.cancelStart) throw new Error('Start cancelled.');
      await this.server.start(
        this.config,
        model,
        { ...binary, apiKey: await this.context.secrets.get('apiKey') },
        custom
      );
    } finally {
      this.starting = false;
      this.broadcast();
    }
  }
  async job(key, fn) {
    if (this.jobs.has(key)) throw new Error('This operation is already running.');
    const controller = new AbortController();
    this.jobs.set(key, controller);
    this.broadcast();
    try {
      return await fn({
        signal: controller.signal,
        onProgress: (progress) => this.post({ type: 'jobProgress', key, progress })
      });
    } catch (e) {
      this.post({
        type: 'jobProgress',
        key,
        progress: { stage: this.log.redact(e.message), failed: true }
      });
      throw e;
    } finally {
      this.jobs.delete(key);
      this.broadcast();
    }
  }
  async attach(selection = false) {
    if (!this.config.allowWorkspace) throw new Error('Workspace context is disabled in Settings.');
    if (this.chat.busy) throw new Error('Wait for generation before adding context.');
    let items = [];
    if (selection) {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) throw new Error('Select text in an editor first.');
      items = [
        {
          uri: editor.document.uri,
          content: editor.document.getText(editor.selection),
          suffix: `:${editor.selection.start.line + 1}-${editor.selection.end.line + 1}`
        }
      ];
    } else {
      const files = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: 'Attach files',
        defaultUri: vscode.workspace.workspaceFolders?.[0]?.uri
      });
      items = (files || []).map((uri) => ({ uri }));
    }
    for (const item of items) {
      if (item.uri.scheme !== 'file')
        throw new Error('Only local workspace files can be attached.');
      const real = await fs.realpath(item.uri.fsPath);
      let within = false;
      for (const folder of vscode.workspace.workspaceFolders || []) {
        const root = await fs.realpath(folder.uri.fsPath);
        const relative = path.relative(root, real);
        if (
          !relative.startsWith('..' + path.sep) &&
          relative !== '..' &&
          !path.isAbsolute(relative)
        )
          within = true;
      }
      if (!within) throw new Error('Choose a file inside an open workspace folder.');
      if (
        /(^|[\\/])(?:\.env(?:\.[^\\/]*)?|id_rsa|id_ed25519|credentials)(?:$|[\\/])|\.(?:pem|key|p12)$/i.test(
          real
        )
      )
        throw new Error('Sensitive credential files cannot be attached.');
      const stat = await fs.stat(real);
      if (!stat.isFile() || (!selection && stat.size > this.config.maxFileKB * 1024))
        throw new Error(`File exceeds the ${this.config.maxFileKB} KB limit.`);
      const content = item.content ?? (await fs.readFile(real, 'utf8'));
      if (Buffer.byteLength(content) > this.config.maxFileKB * 1024 || content.includes('\0'))
        throw new Error('Selection is too large or contains binary data.');
      this.attachments.push({
        id: crypto.randomUUID(),
        name: vscode.workspace.asRelativePath(item.uri) + (item.suffix || ''),
        path: real,
        content: this.log.redact(content)
      });
    }
    this.broadcast();
  }
  async exportFile(content, name) {
    const target = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(require('node:os').homedir(), name))
    });
    if (target) await vscode.workspace.fs.writeFile(target, Buffer.from(this.log.redact(content)));
  }
  async handle(m) {
    if (!m || typeof m.type !== 'string') return;
    switch (m.type) {
      case 'ready':
        this.webviewReady = true;
        this.broadcast();
        this.post({ type: 'logs', rows: this.log.lines });
        break;
      case 'save':
        await this.save(m.config);
        break;
      case 'selectModel':
        if (this.server.state !== 'stopped' || this.chat.busy)
          throw new Error('Stop the model before changing it.');
        if (!this.config.models.some((x) => x.id === m.id)) throw new Error('Unknown model.');
        this.selected = m.id;
        this.broadcast();
        break;
      case 'start':
        if (this.chat.busy) throw new Error('Wait for the current generation or compaction.');
        await this.start(this.selected);
        break;
      case 'stop':
        clearTimeout(this.restartTimer);
        this.stopRequested = true;
        this.cancelStart = true;
        this.chat.stop();
        await this.server.stop();
        break;
      case 'send': {
        const attachments = this.attachments;
        this.attachments = [];
        try {
          this.activeChatTask = this.chat.send(m.text, attachments);
          await this.activeChatTask;
        } catch (e) {
          this.attachments = attachments;
          this.post({ type: 'restoreDraft', text: m.text });
          throw e;
        }
        break;
      }
      case 'stopGeneration':
        this.chat.stop();
        break;
      case 'toolReply':
        if (typeof m.id !== 'string') throw new Error('Unknown prompt.');
        this.chat.reply(m.id, m.value);
        break;
      case 'resetApprovals':
        this.chat.sessionAllow.clear();
        this.log.add('agent', 'info', 'Session tool approvals were reset.');
        this.post({ type: 'progress', text: 'Session tool approvals reset.' });
        this.broadcast();
        break;
      case 'newChat':
        this.chat.newChat();
        break;
      case 'selectChat':
        this.chat.select(m.id);
        break;
      case 'renameChat': {
        const title = await vscode.window.showInputBox({
          title: 'Chat title',
          value: this.chat.active.title
        });
        if (title?.trim()) {
          this.chat.active.title = title.trim().slice(0, 120);
          this.chat.changed();
        }
        break;
      }
      case 'clearChat':
        if (this.chat.busy) throw new Error('Stop generation first.');
        if (
          (await vscode.window.showWarningMessage(
            'Clear this conversation?',
            'Clear',
            'Cancel'
          )) === 'Clear'
        ) {
          Object.assign(this.chat.active, {
            messages: [],
            summary: '',
            contextStart: 0,
            compactions: []
          });
          this.chat.changed();
        }
        break;
      case 'deleteChats':
        if (this.chat.busy) throw new Error('Stop generation first.');
        if (
          (await vscode.window.showWarningMessage(
            'Delete all local conversations?',
            'Delete all',
            'Cancel'
          )) === 'Delete all'
        ) {
          this.chat.chats = [];
          this.chat.newChat();
        }
        break;
      case 'exportChat':
        await this.exportFile(JSON.stringify(this.chat.active, null, 2), 'ezllama-chat.json');
        break;
      case 'compact':
        this.activeChatTask = this.chat.compact();
        await this.activeChatTask;
        break;
      case 'summary': {
        const doc = await vscode.workspace.openTextDocument({
          content: this.chat.active.summary || 'No compaction summary yet.',
          language: 'markdown'
        });
        await vscode.window.showTextDocument(doc, { preview: true });
        break;
      }
      case 'attach':
        await this.attach();
        break;
      case 'selection':
        await this.attach(true);
        break;
      case 'removeAttachment':
        this.attachments = this.attachments.filter((a) => a.id !== m.id);
        this.broadcast();
        break;
      case 'copy':
        if (typeof m.text === 'string') await vscode.env.clipboard.writeText(m.text);
        break;
      case 'openLink': {
        if (typeof m.href !== 'string') break;
        if (/^https?:\/\//i.test(m.href)) {
          await vscode.env.openExternal(vscode.Uri.parse(m.href));
          break;
        }
        if (!this.config.allowWorkspace) throw new Error('Workspace context is disabled.');
        let requested = decodeURIComponent(m.href).replace(/^file:\/\//, '');
        const match = requested.match(/(?::|#L)(\d+)$/);
        let line = match ? Number(match[1]) : 1;
        if (match) requested = requested.slice(0, match.index);
        const folder = vscode.workspace.workspaceFolders?.[0];
        if (!folder) throw new Error('Open a workspace to follow file references.');
        const target = await fs.realpath(path.resolve(folder.uri.fsPath, requested));
        const root = await fs.realpath(folder.uri.fsPath);
        const rel = path.relative(root, target);
        if (rel.startsWith('..') || path.isAbsolute(rel))
          throw new Error('File reference must stay inside the workspace.');
        await vscode.window.showTextDocument(vscode.Uri.file(target), {
          selection: new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0)
        });
        break;
      }
      case 'recheck':
        try {
          await this.binary();
          await this.validateModels();
        } catch (e) {
          this.installInfo = { error: e.message };
          this.broadcast();
          throw e;
        }
        break;
      case 'browse': {
        const chosen = await vscode.window.showOpenDialog({
          canSelectFolders: m.field !== 'model',
          canSelectFiles: m.field === 'model',
          canSelectMany: false,
          openLabel: 'Choose'
        });
        if (chosen?.[0])
          this.post({ type: 'browseResult', field: m.field, id: m.id, path: chosen[0].fsPath });
        break;
      }
      case 'preview':
      case 'recommend':
      case 'testCommand': {
        const check = validateConfig(m.config);
        this.errors = check.errors;
        if (Object.keys(check.errors).length) {
          this.broadcast();
          break;
        }
        const model = check.config.models.find((x) => x.id === m.id) || check.config.models[0];
        if (!model) throw new Error('Add a model before previewing a command.');
        let binary;
        try {
          binary = await installation(check.config, this.autoDirectory);
        } catch (e) {
          if (m.type !== 'recommend') throw e;
          binary = { executable: 'llama-server', capabilities: '', error: e.message };
        }
        if (m.type === 'recommend') {
          const result = await recommend(check.config, model, binary);
          if (binary.error) result.report.notes.unshift(binary.error);
          this.post({ type: 'recommendation', row: m.row, ...result });
        } else {
          const resolved = resolveCommand(check.config, model, binary.executable, m.command);
          this.post({
            type: 'preview',
            row: m.row,
            text: this.log.redact(JSON.stringify(resolved, null, 2))
          });
          if (m.type === 'testCommand') {
            if (this.chat.busy) throw new Error('Stop generation first.');
            if (this.starting) throw new Error('A start is already pending.');
            this.starting = true;
            this.stopRequested = false;
            try {
              await this.server.stop();
              if (this.stopRequested || this.disposed) throw new Error('Start cancelled.');
              await this.server.start(
                check.config,
                model,
                { ...binary, apiKey: await this.context.secrets.get('apiKey') },
                m.command
              );
              this.selected = model.id;
            } finally {
              this.starting = false;
              this.broadcast();
            }
          }
        }
        break;
      }
      case 'downloadModel': {
        const model = this.config.models.find((x) => x.id === m.id);
        if (!model || model.source === 'local')
          throw new Error('Save the remote model row before downloading.');
        await this.job(model.id, async (options) => {
          this.log.add('download', 'info', `Downloading ${model.label}`);
          const result = await downloadModel(model, this.config, {
            ...options,
            token: await this.context.secrets.get('hfToken')
          });
          const next = structuredClone(this.config);
          Object.assign(
            next.models.find((x) => x.id === model.id),
            {
              source: 'local',
              path: result.path,
              checksum: result.checksum || '',
              downloaded: true,
              originalSource: model.path
            }
          );
          await vscode.workspace
            .getConfiguration('ezllama')
            .update('config', next, vscode.ConfigurationTarget.Global);
          this.config = next;
          await this.validateModels();
          this.log.add('download', 'info', `Validated ${model.label}: ${result.details}`);
        });
        break;
      }
      case 'cancelJob':
        this.jobs.get(m.key)?.abort();
        break;
      case 'planInstall':
        this.plan = await releasePlan();
        this.post({
          type: 'installPlan',
          plan: { ...this.plan, destination: path.join(this.root, 'llama.cpp') }
        });
        break;
      case 'install':
        if (!this.plan) throw new Error('Review the download details first.');
        await this.job('installation', async (options) => {
          const installed = await installRelease(this.plan, path.join(this.root, 'llama.cpp'), {
            ...options,
            minFreeGB: this.config.minFreeGB
          });
          this.autoDirectory = installed;
          await this.context.globalState.update('autoDirectory', installed);
          this.log.add(
            'download',
            'info',
            `Installed llama.cpp ${this.plan.version} at ${installed}`
          );
          await this.binary();
        });
        break;
      case 'removeInstall': {
        if (this.server.state !== 'stopped' || this.starting || this.jobs.size)
          throw new Error('Stop the server and downloads before removing managed installations.');
        if (
          (await vscode.window.showWarningMessage(
            'Remove all EZLlama-managed llama.cpp copies?',
            'Remove',
            'Cancel'
          )) === 'Remove'
        ) {
          const root = path.resolve(this.root, 'llama.cpp');
          const rel = path.relative(path.resolve(this.root), root);
          if (rel !== 'llama.cpp') throw new Error('Invalid managed installation path.');
          await fs.rm(root, { recursive: true, force: true });
          await this.context.globalState.update('autoDirectory', undefined);
          this.autoDirectory = path.join(root, 'not-installed');
          this.installInfo = null;
          this.broadcast();
        }
        break;
      }
      case 'secret':
        if (!['apiKey', 'hfToken'].includes(m.key)) break;
        if (m.key === 'apiKey' && (this.server.state !== 'stopped' || this.starting))
          throw new Error('Stop the model before changing its API key.');
        {
          const value = await vscode.window.showInputBox({
            title: m.key === 'apiKey' ? 'Server API key' : 'Hugging Face token',
            password: true,
            prompt: 'Stored in VS Code Secret Storage. Leave empty to remove.'
          });
          if (value !== undefined) {
            if (value) await this.context.secrets.store(m.key, value);
            else await this.context.secrets.delete(m.key);
            await this.refreshSecrets();
            this.post({ type: 'progress', text: 'Secret storage updated.' });
          }
          break;
        }
      case 'exportLogs':
      case 'copyLogs':
      case 'clearLogs': {
        const ids = new Set(Array.isArray(m.ids) ? m.ids : []);
        const rows = this.log.lines.filter((x) => ids.has(x.id));
        const text = rows
          .map((x) => `${x.time} [${x.level}] [${x.source}] ${x.message}`)
          .join('\n');
        if (m.type === 'exportLogs') await this.exportFile(text, 'ezllama-logs.txt');
        else if (m.type === 'copyLogs') await vscode.env.clipboard.writeText(this.log.redact(text));
        else {
          this.log.lines = this.log.lines.filter((x) => !ids.has(x.id));
          this.post({ type: 'logs', rows: this.log.lines });
        }
        break;
      }
    }
  }
  async dispose() {
    this.disposed = true;
    this.stopRequested = true;
    clearTimeout(this.restartTimer);
    this.cancelStart = true;
    this.chat.stop();
    for (const controller of this.jobs.values()) controller.abort();
    await this.server.stop();
    await this.activeChatTask?.catch(() => {});
    await this.chat.persistQueue;
  }
}
async function activate(context) {
  instance = new Extension(context);
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('ezllama.chat', instance, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand('ezllama.open', () =>
      vscode.commands.executeCommand('ezllama.chat.focus')
    ),
    vscode.commands.registerCommand('ezllama.stop', () => instance.handle({ type: 'stop' })),
    vscode.commands.registerCommand('ezllama.attachSelection', async () => {
      await vscode.commands.executeCommand('ezllama.chat.focus');
      await instance.attach(true).catch((e) => instance.report(e));
    }),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('ezllama')) {
        const c = validateConfig(vscode.workspace.getConfiguration('ezllama').get('config'));
        instance.errors = c.errors;
        if (!Object.keys(c.errors).length) instance.config = c.config;
        instance.validateModels().catch((error) => instance.report(error));
      }
    })
  );
  await instance.init();
  return { getState: () => instance.state(), isViewReady: () => !!instance.webviewReady, handle: (m) => instance.handle(m) };
}
async function deactivate() {
  await instance?.dispose();
}
module.exports = { activate, deactivate };
