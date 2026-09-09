/* global acquireVsCodeApi, marked, DOMPurify, hljs */
'use strict';
const vscode = acquireVsCodeApi();
const send = (type, data = {}) => vscode.postMessage({ type, ...data });
const $ = (selector) => document.querySelector(selector);
const esc = (value) =>
  String(value ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
const icons = {
  chat: '<path d="M4 4h16v12H9l-5 4z"/>',
  console: '<path d="m5 6 5 6-5 6m8 0h6"/>',
  settings: '<path d="M4 7h16M4 17h16M8 4v6m8 4v6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  send: '<path d="m4 4 17 8-17 8 3-8zm3 8h14"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="1"/>',
  clip: '<path d="m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9m3 7-7 7"/>',
  selection: '<path d="M8 4H4v4m12-4h4v4M4 16v4h4m12-4v4h-4M8 12h8"/>',
  context: '<path d="M4 19a9 9 0 1 1 16 0"/><path d="M12 12l4-4M5 19h14"/>',
  compact: '<path d="M4 4h16M4 20h16m-8-14v5m-3-2 3 3 3-3m-3 9v-5m-3 2 3-3 3 3"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  copy: '<rect x="8" y="8" width="12" height="12" rx="1"/><path d="M15 8V4H4v11h4"/>',
  trash: '<path d="M4 6h16M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7"/>'
};
const icon = (name) =>
  `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">${icons[name] || icons.plus}</svg>`;
const button = (action, label, name, extra = '') =>
  `<button type="button" class="icon" data-action="${action}" title="${esc(label)}" aria-label="${esc(label)}" ${extra}>${icon(name)}</button>`;
let state,
  draft,
  dirty = false,
  logs = [],
  tab = vscode.getState()?.tab || 'chat',
  follow = true,
  settingsOpen = false;
const app = $('#app');
app.innerHTML = `<div class="top"><nav class="tabs" role="tablist" aria-label="EZLlama views">${['chat', 'console', 'settings'].map((name) => `<button id="tab-${name}" role="tab" aria-controls="panel-${name}" data-tab="${name}" title="${name[0].toUpperCase() + name.slice(1)}" aria-label="${name}">${icon(name)}<span>${name[0].toUpperCase() + name.slice(1)}</span></button>`).join('')}</nav><div id="feedback" role="status" aria-live="polite" hidden></div></div>
<section id="panel-chat" role="tabpanel" aria-labelledby="tab-chat">
 <header class="chat-header"><button id="server-toggle" data-action="start">Start model</button><select id="model-select" aria-label="Model"></select></header>
 <div id="server-status" class="muted" role="status"></div>
 <div class="history-row"><select id="history" aria-label="Chat history"></select>${button('renameChat', 'Rename chat', 'settings')}${button('newChat', 'New chat', 'plus')}</div>
 <div id="transcript" tabindex="0" aria-label="Conversation"></div>
 <div id="composer"><div id="attachments"></div><div class="toolbar">
 ${button('newChat', 'New chat', 'plus')}${button('attach', 'Attach workspace files', 'clip')}${button('selection', 'Include editor selection', 'selection')}
 <button type="button" id="approval-mode" class="mode" data-action="toggleApproval" title="Tool approval mode">Manual</button>
 <span id="context-meter" class="context-meter" role="status" title="Context remaining" aria-label="Context remaining">${icon('context')}<span></span></span>
 <span class="compact-group">${button('compact', 'Compact chat', 'compact')}<label class="auto" title="Automatically summarize at the context limit"><input id="auto-compact" type="checkbox">Auto</label></span>
 <details class="overflow"><summary title="More chat controls" aria-label="More chat controls">${icon('more')}</summary><div class="popover"><button data-action="clearChat">Clear chat…</button><button data-action="exportChat">Export chat</button><button data-action="summary">Inspect summary</button><button data-action="resetApprovals">Reset tool approvals</button><label>Temperature<input id="temperature" type="number" min="0" max="2" step="0.1"></label><label>Max output<input id="max-output" type="number" min="16" max="131072"></label><button data-action="saveGeneration">Save generation settings</button></div></details>
 ${button('stopGeneration', 'Stop generation', 'stop', 'id="stop-generation"')}
 </div><div class="input-box"><textarea id="prompt" rows="3" placeholder="Ask about your code…" aria-label="Message"></textarea>${button('send', 'Send message (Enter)', 'send', 'id="send-message"')}</div><div id="send-reason" class="muted"></div></div>
</section>
<section id="panel-console" role="tabpanel" aria-labelledby="tab-console" hidden><div class="console-controls"><input id="log-search" placeholder="Search logs" aria-label="Search logs"><select id="log-level" aria-label="Log level"><option value="">All levels</option>${['debug', 'info', 'warning', 'error'].map((x) => `<option>${x}</option>`).join('')}</select><select id="log-source" aria-label="Log source"><option value="">All sources</option>${['extension', 'server', 'request', 'download', 'compaction', 'agent'].map((x) => `<option>${x}</option>`).join('')}</select></div><div class="actions"><button data-action="copyLogs">Copy</button><button data-action="clearLogs">Clear visible</button><button data-action="exportLogs">Export</button><label><input id="follow" type="checkbox" checked>Follow</label></div><pre id="logs" tabindex="0" aria-label="Server and extension logs"></pre></section>
<section id="panel-settings" role="tabpanel" aria-labelledby="tab-settings" hidden><div class="settings-heading"><h2>Settings</h2><span id="unsaved" class="muted"></span><button data-action="discard">Discard</button><button class="primary" data-action="save">Save changes</button></div><div class="settings-body"><div id="settings-scroll"><div id="settings-content"></div></div><nav id="settings-nav" aria-label="Settings sections"></nav></div></section>`;
function changeTab(value) {
  tab = value;
  for (const name of ['chat', 'console', 'settings']) {
    $(`#panel-${name}`).hidden = name !== value;
    $(`#tab-${name}`).setAttribute('aria-selected', String(name === value));
    $(`#tab-${name}`).tabIndex = name === value ? 0 : -1;
  }
  vscode.setState({ tab, prompt: $('#prompt').value });
  if (value === 'settings' && !settingsOpen && draft) {
    renderSettings();
    settingsOpen = true;
  }
  if (value === 'console') renderLogs();
}
function markdown(content) {
  const rendered = DOMPurify.sanitize(marked.parse(content || '', { gfm: true, breaks: true }), {
    FORBID_TAGS: ['img', 'style', 'input', 'form', 'iframe', 'svg', 'math'],
    FORBID_ATTR: ['style'],
    ALLOW_DATA_ATTR: false
  });
  const container = document.createElement('div');
  container.innerHTML = rendered;
  for (const code of container.querySelectorAll('pre code')) {
    try {
      hljs.highlightElement(code);
    } catch {}
    const copy = document.createElement('button');
    copy.className = 'copy-code';
    copy.textContent = 'Copy';
    copy.title = 'Copy code block';
    copy.setAttribute('aria-label', 'Copy code block');
    copy.addEventListener('click', () => send('copy', { text: code.textContent }));
    code.parentElement.prepend(copy);
  }
  for (const anchor of container.querySelectorAll('a'))
    anchor.addEventListener('click', (event) => {
      event.preventDefault();
      send('openLink', { href: anchor.getAttribute('href') });
    });
  return container;
}
function prettyArguments(raw) {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2);
  } catch {
    return raw || '';
  }
}
let lastPromptId = '';
function toolRow(message) {
  const article = document.createElement('article');
  article.className = `message tool tool-${message.status || 'done'}`;
  article.dataset.messageId = message.id;
  const prompt = message.status === 'awaiting' ? message.prompt : null;
  const status =
    {
      pending: 'Pending',
      awaiting: prompt?.kind === 'question' ? 'Waiting for your answer' : 'Needs approval',
      reviewing: 'Reviewer deciding…',
      running: 'Running…',
      done: 'Done',
      denied: 'Not run',
      failed: 'Failed',
      cancelled: 'Cancelled'
    }[message.status] || message.status;
  let html = `<div class="tool-head"><span class="tool-name">${esc(message.summary || message.name)}</span><span class="tool-status">${esc(status)}</span></div>`;
  if (prompt?.kind === 'approval')
    html += `<div class="tool-prompt" role="group" aria-label="Approval"><p>Allow the model to ${esc(message.summary)}?</p><div class="actions"><button class="primary" data-action="reply" data-id="${esc(prompt.id)}" data-value="yes">Yes</button><button data-action="reply" data-id="${esc(prompt.id)}" data-value="always">Yes, don’t ask again</button><button data-action="reply" data-id="${esc(prompt.id)}" data-value="no">No</button></div></div>`;
  else if (prompt?.kind === 'question')
    html += `<div class="tool-prompt" role="group" aria-label="Question from the model"><p>${esc(prompt.question)}</p><div class="actions">${(prompt.options || []).map((o) => `<button data-action="reply" data-id="${esc(prompt.id)}" data-value="${esc(o)}">${esc(o)}</button>`).join('')}</div><div class="reply-row"><input id="reply-input" data-prompt="${esc(prompt.id)}" placeholder="Type an answer…" aria-label="Your answer"><button class="primary" data-action="replyText" data-id="${esc(prompt.id)}">Reply</button></div></div>`;
  if (message.review) html += `<div class="muted tool-review">Reviewer: ${esc(message.review)}</div>`;
  const detail = [
    message.arguments ? `Arguments:\n${prettyArguments(message.arguments).slice(0, 4000)}` : '',
    message.content && !prompt ? `Result:\n${message.content.slice(0, 20000)}` : ''
  ]
    .filter(Boolean)
    .join('\n\n');
  if (detail)
    html += `<details><summary>Details</summary><pre class="tool-output">${esc(detail)}</pre></details>`;
  article.innerHTML = html;
  return article;
}
function renderTranscript() {
  const root = $('#transcript');
  const atBottom = root.scrollTop + root.clientHeight >= root.scrollHeight - 90;
  const previousReply = $('#reply-input');
  const replyDraft = previousReply ? { id: previousReply.dataset.prompt, value: previousReply.value } : null;
  root.replaceChildren();
  if (!state.active?.messages.length) {
    root.innerHTML = `<div class="empty"><div class="eyebrow">LOCAL FIRST</div><h1>A quiet place<br>to work with your code.</h1><p>Add a model in Settings, start its server,<br>and begin a conversation.</p><button data-action="settings">Configure a model</button></div>`;
    return;
  }
  for (const message of state.active.messages) {
    if (message.role === 'tool') {
      root.append(toolRow(message));
      continue;
    }
    // A tool-only assistant turn is represented by its tool rows.
    if (message.role === 'assistant' && !message.content && message.toolCalls?.length) continue;
    const article = document.createElement('article');
    article.className = `message ${message.role} ${message.kind || ''}`;
    article.dataset.messageId = message.id;
    if (message.role === 'notice' && message.kind === 'compaction') {
      article.classList.add(`compaction-${message.status || 'complete'}`);
      article.setAttribute('role', 'status');
      article.setAttribute('aria-live', 'polite');
      article.innerHTML = `<div class="compaction-line" aria-hidden="true"></div><div class="compaction-center">${message.status === 'running' ? '<div class="compaction-progress"><div></div></div>' : ''}<span>${esc(message.content)}</span></div><div class="compaction-line" aria-hidden="true"></div>`;
      root.append(article);
      continue;
    }
    const header = document.createElement('div');
    header.className = 'message-heading';
    header.innerHTML = `<span>${message.role === 'user' ? 'You' : message.role === 'assistant' ? 'EZLlama' : message.kind === 'compaction' ? 'Context compacted' : 'Activity'}${message.partial ? ' · partial' : ''}</span>`;
    if (message.role !== 'notice') {
      const copy = document.createElement('button');
      copy.className = 'icon';
      copy.title = 'Copy message';
      copy.setAttribute('aria-label', 'Copy message');
      copy.innerHTML = icon('copy');
      copy.onclick = () => send('copy', { text: message.content });
      header.append(copy);
    }
    article.append(header);
    const body = markdown(message.content);
    body.className = 'message-body';
    article.append(body);
    if (message.attachments?.length) {
      const files = document.createElement('div');
      files.className = 'file-chips';
      for (const a of message.attachments) {
        const ref = document.createElement('button');
        ref.textContent = a.name;
        ref.onclick = () => send('openLink', { href: a.path });
        files.append(ref);
      }
      article.append(files);
    }
    root.append(article);
  }
  const reply = $('#reply-input');
  if (reply) {
    if (replyDraft?.id === reply.dataset.prompt) reply.value = replyDraft.value;
    if (reply.dataset.prompt !== lastPromptId) {
      lastPromptId = reply.dataset.prompt;
      reply.focus();
    }
  }
  if (atBottom) root.scrollTop = root.scrollHeight;
}
function renderChat() {
  const status = state.server.state,
    server = $('#server-toggle');
  server.textContent = {
    stopped: 'Start model',
    starting: 'Cancel start',
    running: 'Stop model',
    stopping: 'Stopping…'
  }[status];
  server.dataset.action = status === 'stopped' ? 'start' : 'stop';
  server.disabled = status === 'stopping';
  $('#model-select').innerHTML = state.config.models.length
    ? state.config.models
        .map(
          (m) =>
            `<option value="${esc(m.id)}" ${m.id === state.selected ? 'selected' : ''} ${!state.validations[m.id]?.valid ? 'disabled' : ''}>${esc(m.label)}${state.validations[m.id]?.valid ? '' : ' · unavailable'}</option>`
        )
        .join('')
    : '<option value="">Add a model in Settings…</option>';
  if (state.selected) $('#model-select').value = state.selected;
  else $('#model-select').value = '';
  $('#model-select').disabled = status !== 'stopped' || state.busy;
  $('#server-status').textContent =
    state.server.error ||
    `${status[0].toUpperCase() + status.slice(1)}${status === 'running' ? ` · ${state.server.context.toLocaleString()} token context` : ''}`;
  $('#server-status').classList.toggle('error-text', !!state.server.error);
  $('#history').innerHTML = state.chats
    .map(
      (c) =>
        `<option value="${esc(c.id)}" ${c.id === state.active?.id ? 'selected' : ''}>${esc(c.title)}</option>`
    )
    .join('');
  $('#history').disabled = state.busy;
  $('#stop-generation').disabled = !state.busy;
  $('#send-message').disabled = status !== 'running' || state.busy;
  $('#send-reason').textContent = state.busy
    ? 'Generating… Stop preserves partial output.'
    : status === 'running'
      ? 'Enter to send · Shift+Enter for a newline'
      : !state.config.models.length
        ? 'Add a model in Settings to get started.'
        : !state.selected
          ? 'Choose an available model, or validate models in Settings.'
          : 'Start the model to send a message.';
  $('#auto-compact').checked = state.config.autoCompact;
  const mode = $('#approval-mode');
  const toolsOn = state.config.agentTools && state.workspace !== false;
  mode.textContent = !state.config.agentTools
    ? 'Tools off'
    : state.workspace === false
      ? 'No workspace'
      : state.config.approvalMode === 'auto'
        ? 'Auto'
        : 'Manual';
  mode.classList.toggle('auto', toolsOn && state.config.approvalMode === 'auto');
  mode.disabled = !toolsOn || state.busy;
  mode.title = !state.config.agentTools
    ? 'Agent tools are disabled in Settings.'
    : state.workspace === false
      ? 'Open a trusted workspace folder to use tools.'
      : state.config.approvalMode === 'auto'
        ? 'Auto: a reviewer model approves protected actions. Click for Manual.'
        : 'Manual: you approve protected actions. Click for Auto.';
  mode.setAttribute('aria-label', `Tool approval mode: ${mode.textContent}`);
  $('#temperature').value = state.config.temperature;
  $('#max-output').value = state.config.maxOutput;
  $('#attachments').innerHTML = state.attachments
    .map(
      (a) =>
        `<button data-action="removeAttachment" data-id="${esc(a.id)}" title="Remove ${esc(a.name)}">${esc(a.name)} ×</button>`
    )
    .join('');
  renderContextMeter();
  for (const b of document.querySelectorAll(
    '[data-action="compact"],[data-action="newChat"],[data-action="clearChat"]'
  ))
    b.disabled = state.busy;
  renderTranscript();
}
function contextEstimate() {
  const chat = state.active;
  const limit = state.server.context || state.config.models.find((m) => m.id === state.selected)?.context || state.config.context;
  const inputLimit = Math.max(0, limit - state.config.maxOutput - state.config.reservedBuffer);
  const messages = [state.config.systemPrompt, chat?.summary || ''].concat(
    (chat?.messages || [])
      .slice(chat?.contextStart || 0)
      .filter((m) => ['user', 'assistant', 'tool'].includes(m.role))
      .map(
        (m) =>
          (m.contextContent || m.content || '') +
          (m.toolCalls || []).map((t) => t.name + (t.arguments || '')).join('')
      )
  );
  if (state.config.agentTools && state.workspace !== false) messages.push('x'.repeat(3500));
  // This stays available while the server is stopped. It is deliberately conservative for code-heavy chats.
  const used = Math.ceil(messages.join('\n\n').length / 3.5);
  return { limit: inputLimit, used, remaining: Math.max(0, inputLimit - used) };
}
function renderContextMeter() {
  const meter = $('#context-meter');
  const { limit, remaining } = contextEstimate();
  const percent = limit ? Math.round((remaining / limit) * 100) : 0;
  const text = limit ? `≈ ${remaining.toLocaleString()} left` : 'Context unavailable';
  const label = limit
    ? `Estimated context remaining: ${remaining.toLocaleString()} of ${limit.toLocaleString()} usable input tokens (${percent}%).`
    : 'Context remaining is unavailable until a model context is configured.';
  meter.classList.toggle('low', percent < 20);
  meter.title = label;
  meter.setAttribute('aria-label', label);
  meter.querySelector('span').textContent = text;
}
function opts(values, current) {
  return values
    .map((value) => {
      const [v, label] = Array.isArray(value) ? value : [value, value];
      return `<option value="${esc(v)}" ${v === current ? 'selected' : ''}>${esc(label)}</option>`;
    })
    .join('');
}
function field(key, label, type = 'text', help = '') {
  let input;
  if (Array.isArray(type))
    input = `<select data-config="${key}">${opts(type, draft[key])}</select>`;
  else if (type === 'checkbox')
    input = `<input type="checkbox" data-config="${key}" ${draft[key] ? 'checked' : ''}>`;
  else if (type === 'textarea' || type === 'json')
    input = `<textarea rows="3" data-config="${key}" ${type === 'json' ? 'data-json="true"' : ''}>${esc(type === 'json' ? JSON.stringify(draft[key], null, 2) : draft[key])}</textarea>`;
  else
    input = `<input type="${type}" data-config="${key}" value="${esc(draft[key])}" ${type === 'number' ? 'step="any"' : ''}>`;
  return `<label class="field ${type === 'checkbox' ? 'check-field' : ''}"><span>${esc(label)}</span>${input}${help ? `<small>${esc(help)}</small>` : ''}<small class="error-text" data-error="${key}">${esc(state.errors[key] || '')}</small></label>`;
}
function commandEditor(row, command, modelId) {
  return `<div class="command-editor" data-row="${esc(row)}"><textarea aria-label="Server command" rows="3" data-command="${esc(row)}">${esc(command)}</textarea><small>Placeholders: {executable}, {model}, {host}, {port}, {context}. Managed model, host, port, context and one slot are enforced.</small><div class="actions"><button data-action="preview" data-row="${esc(row)}" data-id="${esc(modelId || '')}">Preview</button><button data-action="recommend" data-row="${esc(row)}" data-id="${esc(modelId || '')}">Generate optimal command</button><button data-action="testCommand" data-row="${esc(row)}" data-id="${esc(modelId || '')}">Test / start</button>${row !== 'one' ? `<button data-action="removeCommand" data-id="${esc(row)}">Remove</button>` : ''}</div><small class="error-text" data-error="${row === 'one' ? 'command' : 'command.' + row}"></small><pre class="command-result" data-result="${esc(row)}" hidden></pre></div>`;
}
const TOOL_LABELS = [
  ['read_file', 'Read files'],
  ['list_files', 'List files'],
  ['search_files', 'Search files'],
  ['write_file', 'Create or overwrite files'],
  ['edit_file', 'Edit files'],
  ['delete_file', 'Delete files'],
  ['run_command', 'Run commands'],
  ['ask_user', 'Ask you questions']
];
function renderSettings() {
  const modelOptions = [['', 'Choose model'], ...draft.models.map((m) => [m.id, m.label])];
  $('#settings-content').innerHTML =
    `<section class="settings-group" id="section-command" data-title="Command Config"><h3>Command Config</h3>${field('commandMode', 'Command mode', [
      ['one', 'One Command'],
      ['perModel', 'Per Model']
    ])}
  ${
    draft.commandMode === 'one'
      ? commandEditor('one', draft.command, state.selected)
      : `<div class="command-table">${draft.modelCommands.map((r) => `<div class="command-row"><strong>${esc(r.modelId === '*' ? 'Otherwise' : draft.models.find((m) => m.id === r.modelId)?.label || 'Unknown model')}</strong>${commandEditor(r.modelId, r.command, r.modelId === '*' ? state.selected : r.modelId)}</div>`).join('')}</div><div class="actions"><select id="new-command-model" aria-label="Model for new command">${opts(
          draft.models
            .filter((m) => !draft.modelCommands.some((r) => r.modelId === m.id))
            .map((m) => [m.id, m.label]),
          ''
        )}</select><button data-action="addCommand" ${draft.models.every((m) => draft.modelCommands.some((r) => r.modelId === m.id)) ? 'disabled' : ''}>Add model command</button><button data-action="addOtherwise" ${draft.modelCommands.some((r) => r.modelId === '*') ? 'disabled' : ''}>Add Otherwise</button></div>`
  }
  </section><section class="settings-group" id="section-installation" data-title="llama.cpp installation"><h3>llama.cpp installation</h3>${field(
    'installation',
    'Server binary',
    [
      ['auto', 'Auto-install llama.cpp'],
      ['path', 'Use llama.cpp on PATH'],
      ['custom', 'Use a custom llama.cpp directory']
    ]
  )}
  ${draft.installation === 'custom' ? field('customDirectory', 'Custom directory') + '<button data-action="browse" data-field="customDirectory">Browse directory</button>' : ''}
  <div id="installation-info" class="muted"></div><div class="actions"><button data-action="recheck">Recheck saved source</button>${draft.installation === 'auto' ? '<button data-action="planInstall">Download llama.cpp…</button><button data-action="removeInstall">Remove managed copies…</button>' : ''}</div><p class="muted">Auto-install is a preference only. Nothing downloads until you review the release and press Download. Updates also require this action.</p><div id="install-plan"></div><div id="job-installation" role="status"></div>
  <details><summary>Server options</summary>${field('cwd', 'Working directory', 'text', 'Blank uses the executable directory.')}${field(
    'host',
    'Host',
    [
      ['127.0.0.1', '127.0.0.1'],
      ['localhost', 'localhost'],
      ['::1', '::1']
    ]
  )}${field('port', 'Port', 'number')}${field('env', 'Environment variables', 'json', 'JSON object. Use API key/token controls below for secrets.')}${field('apiPath', 'Chat completions API path')}${field('extraBody', 'Additional API request fields', 'json')}${field('launchOnOpen', 'Launch default model on open', 'checkbox')}${field('autoRestart', 'Restart after unexpected exit (maximum 3)', 'checkbox')}${field('startupTimeoutSeconds', 'Startup timeout (seconds)', 'number')}<div class="actions"><button data-action="apiKey">Set server API key</button><button data-action="hfToken">Set Hugging Face token</button></div></details></section>
  <section class="settings-group" id="section-models" data-title="Models"><h3>Models</h3><div id="models" role="table" aria-label="Configured models">${draft.models.map(modelRow).join('')}</div><div class="actions"><button data-action="addModel">+ Add model</button><button data-action="presets">Add from recommended</button></div><div id="preset-picker" hidden></div><small class="error-text" data-error="models"></small></section>
  <section class="settings-group" id="section-agent" data-title="Agent tools"><h3>Agent tools</h3>${field('agentTools', 'Let the model read, edit, create and delete workspace files, run commands, and ask you questions', 'checkbox', 'Needs an open, trusted workspace folder. Tool calls require llama-server --jinja, which is added automatically when the binary supports it.')}${field(
    'approvalMode',
    'Approval mode',
    [
      ['manual', 'Manual: ask me before protected actions'],
      ['auto', 'Auto: a reviewer model answers yes / yes, don’t ask again / no']
    ]
  )}${field(
    'reviewStrategy',
    'Reviewer',
    [
      ['same', 'Same model in a fresh context'],
      ['separate', 'Separate model; temporarily switch servers']
    ]
  )}${field('reviewModel', 'Reviewer model', modelOptions)}<div class="field"><span>Tool permissions</span><div class="permission-table">${TOOL_LABELS.map(([name, label]) => `<label class="permission-row"><span>${esc(label)}</span><select data-permission="${name}" aria-label="${esc(label)} permission">${opts(
    [
      ['allow', 'Allow'],
      ['ask', 'Ask'],
      ['deny', 'Deny']
    ],
    draft.toolPermissions?.[name] || 'ask'
  )}</select></label>`).join('')}</div><small>Ask follows the approval mode above. “Yes, don’t ask again” lasts for this VS Code session.</small><small class="error-text" data-error="toolPermissions"></small></div>${field('commandTimeoutSeconds', 'Command timeout (seconds)', 'number')}${field('maxToolOutputKB', 'Maximum tool output (KB)', 'number')}${field('maxToolRounds', 'Maximum tool rounds per message', 'number')}<div class="actions"><button data-action="resetApprovals">Reset session approvals${state.approvals?.length ? ` (${state.approvals.length})` : ''}</button></div></section>
  <section class="settings-group" id="section-conversation" data-title="Conversation"><h3>Conversation</h3>${field('defaultModel', 'Default model', modelOptions)}${field('systemPrompt', 'System prompt', 'textarea')}<details><summary>Generation and context</summary>${field('temperature', 'Temperature', 'number')}${field('maxOutput', 'Maximum output tokens', 'number')}${field('context', 'Default context tokens', 'number')}${field('streaming', 'Stream responses', 'checkbox')}${field('timeoutSeconds', 'Request timeout (seconds)', 'number')}${field('retries', 'Retries before any output (0–5)', 'number')}${field('concurrency', 'Concurrent requests (one active turn)', 'number')}${field('autoCompact', 'Auto compact at context limit', 'checkbox')}${field(
    'compactionStrategy',
    'Compaction strategy',
    [
      ['same', 'Same model in fresh context'],
      ['separate', 'Separate model; temporarily switch servers']
    ]
  )}${field('compactionModel', 'Compaction model', modelOptions)}${field('reservedBuffer', 'Reserved context tokens', 'number')}${field(
    'tokenCounting',
    'Token counting',
    [
      ['auto', 'Server tokenizer, conservative fallback'],
      ['conservative', 'Conservative UTF-8 byte estimate']
    ]
  )}<div class="actions"><button data-action="summary">Inspect summary</button><button data-action="compact">Compact / retry</button></div></details></section>
  <section class="settings-group" id="section-storage" data-title="Storage and privacy"><h3>Storage and privacy</h3>${field('modelDirectory', 'Model download directory')}<button data-action="browse" data-field="modelDirectory">Browse directory</button>${field('minFreeGB', 'Keep free disk space (GiB)', 'number')}${field(
    'checksum',
    'Download checksum policy',
    [
      ['when-available', 'Verify publisher checksum when available'],
      ['required', 'Require SHA-256']
    ]
  )}<details><summary>History, workspace and accessibility</summary>${field('saveChats', 'Save local chat history', 'checkbox')}${field('retention', 'Conversations retained on disk', 'number')}<div class="actions"><button data-action="exportChat">Export current chat</button><button data-action="deleteChats">Delete all conversations…</button></div>${field('allowWorkspace', 'Allow explicitly attached workspace context', 'checkbox')}${field('maxFileKB', 'Maximum attached file size (KB)', 'number')}${field('logging', 'Keep diagnostic logs in memory', 'checkbox')}${field('verbosity', 'Diagnostic verbosity', ['debug', 'info', 'warning', 'error'])}${field('sensitiveArguments', 'Sensitive command arguments', 'json')}${field('redactionPatterns', 'Literal strings to redact', 'json')}${field('fontSize', 'Chat font size (10–24)', 'number')}${field('reducedMotion', 'Reduce motion', 'checkbox')}<p class="muted">No telemetry. Chat requests go to your managed loopback server. File context is only read when explicitly attached. Downloads contact GitHub or your chosen model source.</p></details></section>`;
  renderSettingsNav();
  renderSettingState();
}
function settingsSections() {
  return [...document.querySelectorAll('#settings-content .settings-group[id]')];
}
function renderSettingsNav() {
  $('#settings-nav').innerHTML = settingsSections()
    .map(
      (section) =>
        `<button type="button" data-jump="${section.id}" title="${esc(section.dataset.title)}">${esc(section.dataset.title)}</button>`
    )
    .join('');
  updateSettingsNav();
}
// Highlights the section under the top of the settings scroller.
function updateSettingsNav() {
  const scroller = $('#settings-scroll');
  const sections = settingsSections();
  if (!sections.length) return;
  let current = sections[0];
  if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2)
    current = sections.at(-1);
  else for (const section of sections) if (section.offsetTop - scroller.scrollTop <= 48) current = section;
  for (const link of $('#settings-nav').querySelectorAll('[data-jump]')) {
    const active = link.dataset.jump === current.id;
    link.classList.toggle('current', active);
    if (active) link.setAttribute('aria-current', 'true');
    else link.removeAttribute('aria-current');
  }
}
let navFrame = 0;
$('#settings-scroll').addEventListener('scroll', () => {
  if (navFrame) return;
  navFrame = requestAnimationFrame(() => {
    navFrame = 0;
    updateSettingsNav();
  });
});
function jumpToSection(sectionId) {
  const section = document.getElementById(sectionId);
  if (!section) return;
  $('#settings-scroll').scrollTo({
    top: Math.max(0, section.offsetTop - 6),
    behavior: document.body.classList.contains('reduced-motion') ? 'auto' : 'smooth'
  });
}
function modelRow(m) {
  const v = state.validations[m.id];
  return `<div class="model-row" role="row" data-model="${esc(m.id)}"><label>Display label<input data-model-field="label" value="${esc(m.label)}" aria-label="Model display label"></label><div class="path-source"><label>Path or identifier<input data-model-field="path" value="${esc(m.path)}" aria-label="Model path or identifier" placeholder="C:\\Models\\model.gguf or owner/repo/file.gguf"></label><label>Source<select data-model-field="source">${opts(
    [
      ['local', 'Local'],
      ['huggingface', 'Hugging Face'],
      ['url', 'HTTPS URL']
    ],
    m.source
  )}</select></label></div><details><summary>Parameters</summary><label>Context tokens<input type="number" data-model-field="context" value="${m.context}"></label><label>Chat template (optional)<input data-model-field="chatTemplate" value="${esc(m.chatTemplate || '')}"></label><label>Extra arguments<input data-model-field="extraArgs" value="${esc(m.extraArgs || '')}"></label><label>SHA-256 (optional)<input data-model-field="checksum" value="${esc(m.checksum || '')}"></label><small>Header validation runs on save. Tensor compatibility is checked by llama.cpp when loading.</small></details><small class="error-text" data-error="model.${esc(m.id)}"></small><div class="model-bottom"><div class="actions"><button data-action="browse" data-field="model" data-id="${esc(m.id)}">Browse</button><button data-action="removeModel" data-id="${esc(m.id)}">Remove row</button></div><span class="model-status" data-status="${esc(m.id)}">${m.source !== 'local' ? `<button data-action="downloadModel" data-id="${esc(m.id)}">Download</button>` : v?.valid ? `<span class="valid" role="img" aria-label="Validated model" title="${esc(v.details)}">✓ Ready</span>` : `<span title="${esc(v?.details || 'Save to validate')}">Unavailable</span>`}</span></div><small class="muted">${esc(m.source === 'local' ? v?.details || 'Save to validate.' : 'Save this row before downloading. No download happens when adding a preset.')}</small><div id="job-${esc(m.id)}" role="status"></div></div>`;
}
function renderSettingState() {
  $('#unsaved').textContent = dirty ? 'Unsaved changes' : 'Changes saved';
  for (const button of document.querySelectorAll('[data-action="save"]')) button.disabled = !dirty;
  const info = $('#installation-info');
  if (info)
    info.textContent =
      state.installation?.error ||
      [state.installation?.executable, state.installation?.version].filter(Boolean).join('\n') ||
      'Save your source, then recheck to resolve its executable and version.';
  for (const error of document.querySelectorAll('[data-error]'))
    error.textContent = state.errors[error.dataset.error] || '';
  if (!dirty)
    for (const row of document.querySelectorAll('[data-status]')) {
      const m = state.config.models.find((m) => m.id === row.dataset.status),
        v = state.validations[row.dataset.status];
      if (m?.source === 'local')
        row.innerHTML = v?.valid
          ? `<span class="valid" role="img" aria-label="Validated model" title="${esc(v.details)}">✓ Ready</span>`
          : `<span title="${esc(v?.details || 'Save to validate')}">Unavailable</span>`;
    }
  for (const key of state.jobs) {
    const row = document.getElementById('job-' + key);
    if (row && !row.textContent)
      row.innerHTML = `Working… <button data-action="cancelJob" data-id="${esc(key)}">Cancel</button>`;
  }
}
function markDirty() {
  dirty = true;
  renderSettingState();
}
function logRows() {
  const query = $('#log-search').value.toLowerCase(),
    level = $('#log-level').value,
    source = $('#log-source').value;
  return logs.filter(
    (row) =>
      (!level || row.level === level) &&
      (!source || row.source === source) &&
      (!query || row.message.toLowerCase().includes(query))
  );
}
function renderLogs() {
  const root = $('#logs');
  root.replaceChildren();
  for (const row of logRows()) {
    const line = document.createElement('div');
    line.className = 'log-' + row.level;
    line.textContent = `${row.time.slice(11, 23)} [${row.level}] [${row.source}] ${row.message}`;
    root.append(line);
  }
  if (follow) root.scrollTop = root.scrollHeight;
}
let feedbackTimer;
function feedback(text, error = false) {
  const element = $('#feedback');
  clearTimeout(feedbackTimer);
  element.hidden = !text;
  element.textContent = text;
  element.classList.toggle('error-text', error);
  if (text)
    feedbackTimer = setTimeout(() => {
      element.hidden = true;
      element.textContent = '';
    }, 3000);
}
function postConfigPatch(values) {
  if (dirty) {
    feedback('Save or discard Settings edits before changing generation controls.', true);
    return;
  }
  send('save', { config: { ...state.config, ...values } });
}
document.addEventListener('input', (event) => {
  const el = event.target;
  if (el.dataset.config) {
    try {
      draft[el.dataset.config] = el.dataset.json
        ? JSON.parse(el.value)
        : el.type === 'checkbox'
          ? el.checked
          : el.type === 'number'
            ? Number(el.value)
            : el.value;
      el.setCustomValidity('');
      markDirty();
    } catch {
      el.setCustomValidity('Enter valid JSON.');
      feedback('Invalid JSON in ' + el.dataset.config, true);
    }
  }
  if (el.dataset.modelField) {
    const model = draft.models.find((m) => m.id === el.closest('[data-model]').dataset.model);
    model[el.dataset.modelField] = el.type === 'number' ? Number(el.value) : el.value;
    markDirty();
  }
  if (el.dataset.command) {
    if (el.dataset.command === 'one') draft.command = el.value;
    else draft.modelCommands.find((r) => r.modelId === el.dataset.command).command = el.value;
    markDirty();
  }
  if (el.dataset.permission) {
    draft.toolPermissions = { ...(draft.toolPermissions || {}), [el.dataset.permission]: el.value };
    markDirty();
  }
  if (el.id === 'log-search') renderLogs();
  if (el.id === 'prompt') vscode.setState({ tab, prompt: el.value });
});
document.addEventListener('change', (event) => {
  const el = event.target;
  if (['commandMode', 'installation'].includes(el.dataset.config)) renderSettings();
  if (el.dataset.modelField === 'source') renderSettings();
  if (el.id === 'model-select') send('selectModel', { id: el.value });
  if (el.id === 'history') send('selectChat', { id: el.value });
  if (el.id === 'auto-compact') postConfigPatch({ autoCompact: el.checked });
  if (['log-level', 'log-source'].includes(el.id)) renderLogs();
  if (el.id === 'follow') {
    follow = el.checked;
    renderLogs();
  }
});
$('#prompt').value = vscode.getState()?.prompt || '';
$('#prompt').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault();
    submit();
  }
});
function replyText(promptId) {
  const input = $('#reply-input');
  if (!input || input.dataset.prompt !== promptId) return;
  const value = input.value.trim();
  if (!value) {
    feedback('Type an answer first.', true);
    return;
  }
  send('toolReply', { id: promptId, value });
}
document.addEventListener('keydown', (event) => {
  if (event.target.id === 'reply-input' && event.key === 'Enter' && !event.isComposing) {
    event.preventDefault();
    replyText(event.target.dataset.prompt);
  }
});
$('.tabs').addEventListener('keydown', (event) => {
  if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) {
    event.preventDefault();
    const names = ['chat', 'console', 'settings'];
    const index =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? 2
          : (names.indexOf(tab) + (event.key === 'ArrowRight' ? 1 : 2)) % 3;
    changeTab(names[index]);
    $(`#tab-${names[index]}`).focus();
  }
});
function submit() {
  if (!state || state.busy || state.server.state !== 'running' || !$('#prompt').value.trim())
    return;
  const text = $('#prompt').value;
  $('#prompt').value = '';
  vscode.setState({ tab, prompt: '' });
  send('send', { text });
}
document.addEventListener('click', (event) => {
  const nav = event.target.closest('[data-tab]');
  if (nav) {
    changeTab(nav.dataset.tab);
    return;
  }
  const jump = event.target.closest('[data-jump]');
  if (jump) {
    jumpToSection(jump.dataset.jump);
    return;
  }
  const el = event.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action,
    id = el.dataset.id;
  switch (action) {
    case 'settings':
      changeTab('settings');
      break;
    case 'send':
      submit();
      break;
    case 'save':
      if (!dirty) break;
      if (document.querySelector(':invalid')) {
        feedback('Fix invalid fields before saving.', true);
        break;
      }
      send('save', { config: draft });
      break;
    case 'discard':
      draft = structuredClone(state.config);
      dirty = false;
      renderSettings();
      break;
    case 'saveGeneration':
      postConfigPatch({
        temperature: Number($('#temperature').value),
        maxOutput: Number($('#max-output').value)
      });
      break;
    case 'toggleApproval':
      postConfigPatch({ approvalMode: state.config.approvalMode === 'auto' ? 'manual' : 'auto' });
      break;
    case 'reply':
      send('toolReply', { id, value: el.dataset.value });
      break;
    case 'replyText':
      replyText(id);
      break;
    case 'renameChat':
      send(action);
      break;
    case 'addModel':
      draft.models.push({
        id: crypto.randomUUID(),
        label: 'New model',
        path: '',
        source: 'local',
        context: draft.context,
        chatTemplate: '',
        extraArgs: '',
        checksum: ''
      });
      markDirty();
      renderSettings();
      document.querySelector('[data-model]:last-child input').focus();
      break;
    case 'removeModel':
      draft.models = draft.models.filter((m) => m.id !== id);
      draft.modelCommands = draft.modelCommands.filter((r) => r.modelId !== id);
      if (draft.defaultModel === id) draft.defaultModel = '';
      if (draft.compactionModel === id) draft.compactionModel = '';
      markDirty();
      renderSettings();
      break;
    case 'addCommand':
    case 'addOtherwise': {
      const modelId = action === 'addOtherwise' ? '*' : $('#new-command-model').value;
      if (modelId && !draft.modelCommands.some((r) => r.modelId === modelId))
        draft.modelCommands.push({ modelId, command: draft.command });
      markDirty();
      renderSettings();
      break;
    }
    case 'removeCommand':
      draft.modelCommands = draft.modelCommands.filter((r) => r.modelId !== id);
      markDirty();
      renderSettings();
      break;
    case 'preview':
    case 'recommend':
    case 'testCommand':
      send(action, {
        config: draft,
        id: id || state.selected,
        row: el.dataset.row,
        command:
          el.dataset.row === 'one'
            ? draft.command
            : draft.modelCommands.find((r) => r.modelId === el.dataset.row)?.command
      });
      feedback(
        action === 'recommend'
          ? 'Detecting hardware and binary capabilities…'
          : 'Validating command…'
      );
      break;
    case 'presets': {
      const picker = $('#preset-picker');
      picker.hidden = !picker.hidden;
      picker.innerHTML = `<p>${esc(state.presets.note)}</p>${state.presets.models.map((p, index) => `<article class="preset"><strong>${esc(p.label)}</strong><p>${esc(p.quant)} · ${esc(p.disk)} disk<br>${esc(p.memory)}</p><p>${esc(p.use)}<br><small>${esc(p.limitation)}</small></p><a href="https://huggingface.co/${esc(p.path.split('/').slice(0, 2).join('/'))}" data-source="true">Hugging Face source</a> <button data-action="choosePreset" data-id="${index}">Add configuration</button></article>`).join('')}`;
      picker.querySelectorAll('a').forEach(
        (a) =>
          (a.onclick = (e) => {
            e.preventDefault();
            send('openLink', { href: a.href });
          })
      );
      break;
    }
    case 'choosePreset': {
      const p = state.presets.models[Number(id)];
      draft.models.push({
        id: crypto.randomUUID(),
        label: p.label,
        path: p.path,
        source: 'huggingface',
        context: p.context,
        chatTemplate: '',
        extraArgs: '',
        checksum: ''
      });
      markDirty();
      renderSettings();
      break;
    }
    case 'browse':
      send(action, { field: el.dataset.field, id });
      break;
    case 'apiKey':
    case 'hfToken':
      send('secret', { key: action });
      break;
    case 'copyLogs':
    case 'clearLogs':
    case 'exportLogs':
      send(action, { ids: logRows().map((r) => r.id) });
      break;
    case 'cancelJob':
      send(action, { key: id });
      break;
    case 'downloadModel':
      if (dirty) {
        feedback('Save changes before downloading this model.', true);
        break;
      }
      send(action, { id });
      break;
    default:
      if (['recheck', 'planInstall', 'start', 'install'].includes(action))
        feedback(
          {
            recheck: 'Checking executable, version, and models…',
            planInstall: 'Looking up a compatible llama.cpp release…',
            start: 'Validating and starting the selected model…',
            install: 'Downloading and verifying llama.cpp…'
          }[action]
        );
      send(action, { id });
  }
});
$('#model-select').addEventListener('click', () => {
  if (!state.config.models.length) changeTab('settings');
});
window.addEventListener('message', (event) => {
  const m = event.data;
  if (m.type === 'state') {
    const previous = state;
    state = m.state;
    if (!draft || !dirty) {
      draft = structuredClone(state.config);
      dirty = false;
    } else if (JSON.stringify(state.config) === JSON.stringify(draft)) {
      dirty = false;
      feedback('Settings saved.');
    }
    document.body.className = `font-${state.config.fontSize}${state.config.reducedMotion ? ' reduced-motion' : ''}`;
    renderChat();
    if (
      tab === 'settings' &&
      (!settingsOpen ||
        (!dirty && JSON.stringify(previous?.config) !== JSON.stringify(state.config)))
    ) {
      renderSettings();
      settingsOpen = true;
    } else if (settingsOpen) renderSettingState();
    changeTab(tab);
  } else if (m.type === 'token') {
    if (state?.active?.id === m.chatId) {
      const message = state.active.messages.find((x) => x.id === m.messageId);
      if (message) {
        message.content += m.token;
        const root = $('#transcript'),
          follow = root.scrollTop + root.clientHeight >= root.scrollHeight - 90;
        const article = [...root.querySelectorAll('[data-message-id]')].find(
          (x) => x.dataset.messageId === m.messageId
        );
        if (article) {
          const content = markdown(message.content);
          content.className = 'message-body';
          article.querySelector('.message-body').replaceWith(content);
        }
        if (follow) root.scrollTop = root.scrollHeight;
      }
    }
  } else if (m.type === 'log') {
    logs.push(m.row);
    if (logs.length > 5000) logs.shift();
    if (tab === 'console') renderLogs();
  } else if (m.type === 'logs') {
    logs = m.rows;
    renderLogs();
  } else if (m.type === 'error' || m.type === 'progress') feedback(m.text, m.type === 'error');
  else if (m.type === 'restoreDraft') {
    $('#prompt').value = m.text;
    vscode.setState({ tab, prompt: m.text });
  } else if (m.type === 'browseResult') {
    if (m.field === 'model') {
      const model = draft.models.find((x) => x.id === m.id);
      if (model) {
        model.path = m.path;
        model.source = 'local';
      }
    } else draft[m.field] = m.path;
    markDirty();
    renderSettings();
  } else if (m.type === 'preview' || m.type === 'recommendation') {
    const result = [...document.querySelectorAll('[data-result]')].find(
      (x) => x.dataset.result === m.row
    );
    if (result) {
      result.hidden = false;
      result.textContent = m.type === 'preview' ? m.text : JSON.stringify(m.report, null, 2);
    }
    if (m.type === 'recommendation') {
      if (m.row === 'one') draft.command = m.command;
      else {
        const row = draft.modelCommands.find((r) => r.modelId === m.row);
        if (row) row.command = m.command;
      }
      const editor = [...document.querySelectorAll('[data-command]')].find(
        (x) => x.dataset.command === m.row
      );
      if (editor) editor.value = m.command;
      markDirty();
    }
    feedback('Review the resolved command and recommendation details.');
  } else if (m.type === 'installPlan') {
    const p = m.plan;
    $('#install-plan').innerHTML =
      `<div class="install-review"><strong>${esc(p.version)} · ${esc(p.platform)}</strong><p>${esc(p.name)}<br>${(p.size / 2 ** 20).toFixed(1)} MiB<br>${esc(p.destination)}</p><small>SHA-256 verified against GitHub release metadata. This CPU build is a safe default; choose a custom GPU build for acceleration.</small><button class="primary" data-action="install">Download and install this release</button></div>`;
  } else if (m.type === 'jobProgress') {
    const row = document.getElementById('job-' + m.key);
    if (row) {
      row.innerHTML = `${esc(m.progress.stage || (m.progress.done ? 'Download complete. Validating…' : `${(m.progress.received / 2 ** 20).toFixed(1)} / ${m.progress.total ? (m.progress.total / 2 ** 20).toFixed(1) : '?'} MiB`))} ${m.progress.failed ? '' : `<button data-action="cancelJob" data-id="${esc(m.key)}">Cancel</button>`}`;
    }
  }
});
changeTab(tab);
send('ready');
