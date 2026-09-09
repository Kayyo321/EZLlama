'use strict';
const assert = require('node:assert/strict');
const vscode = require('vscode');
async function run() {
  const extension = vscode.extensions.getExtension('Kayyo321.ezllama');
  assert.ok(extension, 'Extension discovered');
  const api = await extension.activate();
  assert.equal(api.getState().config.installation, 'auto');
  assert.equal(api.getState().server.state, 'stopped');
  assert.deepEqual(api.getState().jobs, []);
  await vscode.commands.executeCommand('ezllama.open');
  const deadline = Date.now() + 15000;
  while (!api.isViewReady() && Date.now() < deadline) await new Promise(r => setTimeout(r, 100));
  assert.ok(api.isViewReady(), 'Webview scripts loaded and completed the host handshake');
  const initial = structuredClone(api.getState().config);
  await api.handle({type:'save',config:{...initial,port:70000}});
  assert.ok(api.getState().errors.port, 'Invalid settings stay inline');
  assert.equal(api.getState().config.port, initial.port, 'Invalid settings do not persist');
  await api.handle({type:'save',config:initial});
  await api.handle({ type: 'newChat' });
  assert.ok(api.getState().active.id);
  assert.equal(api.getState().presets.models.length, 10);
  console.log('EZLlama Extension Host smoke tests passed.');
}
module.exports = { run };
