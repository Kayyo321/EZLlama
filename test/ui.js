'use strict';
// Optional browser integration checks: npm install --no-save playwright && npx playwright install chromium.
const { chromium } = require(process.env.EZLLAMA_PLAYWRIGHT || 'playwright');
const path = require('node:path');
const fs = require('node:fs/promises');
const assert = require('node:assert/strict');
const { configuration } = require('../src/config');
async function main() {
  const root = path.resolve(__dirname, '..');
  const server = require('node:http').createServer((req, res) =>
    res.end('<!doctype html><html><head></head><body><div id="app"></div></body></html>')
  );
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.addStyleTag({
      content:
        ':root{--vscode-foreground:#d4d4d4;--vscode-sideBar-background:#181818;--vscode-font-family:system-ui;--vscode-descriptionForeground:#999;--vscode-button-secondaryBackground:#303030;--vscode-button-secondaryForeground:#ddd;--vscode-input-background:#252526;--vscode-input-foreground:#ddd;--vscode-panel-border:#303030;--vscode-focusBorder:#75b6d9;--vscode-button-background:#2676aa;--vscode-button-foreground:#fff;--vscode-textBlockQuote-background:#242424;--vscode-textCodeBlock-background:#202020;--vscode-errorForeground:#f48771}'
    });
    await page.addStyleTag({ path: path.join(root, 'media/style.css') });
    await page.evaluate(() => {
      window.outbox = [];
      window.acquireVsCodeApi = () => ({
        postMessage: (m) => window.outbox.push(m),
        getState: () => ({}),
        setState: () => {}
      });
    });
    for (const file of ['vendor/marked.js', 'vendor/purify.js', 'vendor/highlight.js', 'app.js'])
      await page.addScriptTag({ path: path.join(root, 'media', file) });
    const state = {
      config: configuration(),
      errors: {},
      server: { state: 'stopped', error: '', context: 8192 },
      selected: '',
      validations: {},
      installation: null,
      active: { id: 'chat', title: 'New chat', messages: [], summary: '' },
      chats: [{ id: 'chat', title: 'New chat' }],
      busy: false,
      attachments: [],
      jobs: [],
      approvals: [],
      workspace: true,
      presets: require('../data/presets.json')
    };
    const update = () =>
      page.evaluate(
        (state) =>
          window.dispatchEvent(new MessageEvent('message', { data: { type: 'state', state } })),
        state
      );
    await update();
    assert.equal(await page.locator('[role=tab]').count(), 3);
    assert.ok(await page.locator('#send-message').isDisabled());
    assert.match(await page.locator('#context-meter').getAttribute('aria-label'), /Estimated context remaining/);
    await fs.mkdir(path.join(root, '.debug/screenshots'), { recursive: true });
    await page.screenshot({ path: path.join(root, '.debug/screenshots/chat-empty.png') });
    assert.equal(await page.locator('#approval-mode').textContent(), 'Manual');
    await page.evaluate(() =>
      window.dispatchEvent(
        new MessageEvent('message', { data: { type: 'progress', text: 'Overlay notice' } })
      )
    );
    assert.equal(
      await page.locator('#feedback').evaluate((e) => getComputedStyle(e).position),
      'absolute'
    );
    await page.locator('#tab-settings').click();
    assert.equal(await page.locator('#settings-nav [data-jump]').count(), 6);
    await page.locator('#settings-nav [data-jump=section-storage]').click();
    await page.waitForTimeout(600);
    assert.equal(
      await page.locator('#settings-nav .current').getAttribute('data-jump'),
      'section-storage'
    );
    assert.equal(await page.locator('[data-permission]').count(), 8);
    assert.ok(await page.locator('[data-action=save]').first().isDisabled());
    await page.locator('[data-action=addModel]').click();
    assert.ok(!(await page.locator('[data-action=save]').first().isDisabled()));
    assert.equal(await page.locator('[data-model]').count(), 1);
    assert.equal(
      await page.locator('[data-model-field=label]').evaluate((e) => document.activeElement === e),
      true
    );
    await page.locator('[data-action=removeModel]').click();
    await page.locator('[data-action=presets]').click();
    assert.equal(await page.locator('.preset').count(), 10);
    await page.locator('[data-action=choosePreset]').first().click();
    assert.equal(await page.locator('[data-model-field=source]').inputValue(), 'huggingface');
    assert.ok(
      !(await page.evaluate(() => window.outbox)).some(
        (m) => m.type === 'downloadModel' || m.type === 'install'
      )
    );
    await page.locator('[data-config=commandMode]').selectOption('perModel');
    await page.locator('[data-action=addOtherwise]').click();
    assert.ok(await page.locator('[data-action=addOtherwise]').isDisabled());
    assert.equal(await page.locator('.command-row').count(), 1);
    await page.screenshot({ path: path.join(root, '.debug/screenshots/settings.png') });
    await page.locator('[data-action=discard]').click();
    await page.locator('#tab-chat').click();
    state.server.state = 'running';
    state.active.messages = [
      { id: 'u', role: 'user', content: 'Show a safe example.' },
      {
        id: 'a',
        role: 'assistant',
        content:
          'Here is a small function:\n\n```javascript\nconst hello = () => "world";\n```\n\n```diff\n-old\n+new\n```\n<img src=x onerror="window.pwned=true"><script>window.pwned=true</script>'
      }
    ];
    await update();
    assert.equal(await page.locator('.copy-code').count(), 2);
    assert.equal(await page.locator('.message-body img,.message-body script').count(), 0);
    assert.ok((await page.locator('.hljs-keyword').count()) > 0);
    await page.locator('.copy-code').first().click();
    assert.ok(
      (await page.evaluate(() => window.outbox)).some(
        (m) => m.type === 'copy' && m.text.includes('hello')
      )
    );
    state.active.messages.push({
      id: 'compact',
      role: 'notice',
      kind: 'compaction',
      status: 'running',
      content: 'Compacting...'
    });
    await update();
    assert.equal(await page.locator('.compaction-line').count(), 2);
    assert.equal(await page.locator('.compaction-progress').count(), 1);
    state.active.messages.at(-1).status = 'complete';
    state.active.messages.at(-1).content = 'Chat Compacted, Context Reset';
    await update();
    assert.equal(await page.locator('.compaction-progress').count(), 0);
    assert.equal(await page.locator('.compaction-center').textContent(), 'Chat Compacted, Context Reset');
    state.active.messages.push({
      id: 'tool',
      role: 'tool',
      toolCallId: 'c1',
      name: 'run_command',
      arguments: '{"command":"npm test"}',
      summary: 'run: npm test',
      status: 'awaiting',
      prompt: { id: 'p1', kind: 'approval' }
    });
    await update();
    assert.equal(await page.locator('.tool-prompt [data-action=reply]').count(), 3);
    await page.locator('[data-value=always]').click();
    assert.deepEqual((await page.evaluate(() => window.outbox)).at(-1), {
      type: 'toolReply',
      id: 'p1',
      value: 'always'
    });
    state.active.messages.pop();
    await update();
    await page.locator('#prompt').fill('Hello');
    await page.locator('#prompt').press('Shift+Enter');
    await page.locator('#prompt').type('world');
    assert.equal(await page.locator('#prompt').inputValue(), 'Hello\nworld');
    await page.locator('#prompt').press('Enter');
    assert.ok(
      (await page.evaluate(() => window.outbox)).some(
        (m) => m.type === 'send' && m.text === 'Hello\nworld'
      )
    );
    await page.screenshot({ path: path.join(root, '.debug/screenshots/chat-messages.png') });
    await page.setViewportSize({ width: 260, height: 750 });
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({ path: path.join(root, '.debug/screenshots/chat-narrow.png') });
    await page.locator('#tab-console').click();
    await page.evaluate(() =>
      window.dispatchEvent(
        new MessageEvent('message', {
          data: {
            type: 'logs',
            rows: [
              {
                id: 1,
                time: '2026-09-09T17:00:00Z',
                source: 'server',
                level: 'info',
                message: 'ready'
              },
              {
                id: 2,
                time: '2026-09-09T17:00:01Z',
                source: 'request',
                level: 'error',
                message: 'failed'
              }
            ]
          }
        })
      )
    );
    await page.locator('#log-search').fill('failed');
    assert.equal(await page.locator('#logs>div').count(), 1);
    await page.locator('[data-action=clearLogs]').click();
    assert.deepEqual((await page.evaluate(() => window.outbox)).at(-1).ids, [2]);
    assert.deepEqual(errors, []);
    console.log(
      'Browser integration passed: tabs, model editor, presets, command fallback, safe Markdown/highlighting/copy, keyboard composer, 260px layout, and log filters.'
    );
  } finally {
    await browser.close();
    server.close();
  }
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
