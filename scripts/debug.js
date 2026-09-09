'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
async function main() {
  const root = path.resolve(__dirname, '..'),
    test = process.argv.includes('--test');
  const candidates = [
    process.env.VSCODE_EXECUTABLE,
    ...(process.platform === 'win32'
      ? [
          path.join(process.env.LOCALAPPDATA || '', 'Programs/Microsoft VS Code/Code.exe'),
          path.join(process.env.ProgramFiles || 'C:/Program Files', 'Microsoft VS Code/Code.exe')
        ]
      : process.platform === 'darwin'
        ? ['/Applications/Visual Studio Code.app/Contents/MacOS/Electron']
        : ['/usr/share/code/code', '/usr/bin/code'])
  ].filter(Boolean);
  let executable;
  for (const candidate of candidates)
    try {
      await fs.access(candidate);
      executable = candidate;
      break;
    } catch {}
  if (!executable)
    throw new Error(
      'VS Code was not found. Set VSCODE_EXECUTABLE to the absolute path of Code.exe (or the VS Code executable).'
    );
  const debugRoot = path.join(root, '.debug', test ? 'test' : 'development');
  await fs.mkdir(debugRoot, { recursive: true });
  const profile = path.join(debugRoot, 'user-data');
  await fs.mkdir(path.join(profile, 'User'), { recursive: true });
  const settingsFile = path.join(profile, 'User', 'settings.json');
  try {
    await fs.access(settingsFile);
  } catch {
    await fs.writeFile(
      settingsFile,
      JSON.stringify(
        {
          'workbench.startupEditor': 'none',
          'security.workspace.trust.enabled': false,
          'extensions.autoUpdate': false,
          'update.mode': 'none',
          'telemetry.telemetryLevel': 'off'
        },
        null,
        2
      )
    );
  }
  const args = [
    '--new-window',
    `--extensionDevelopmentPath=${root}`,
    `--user-data-dir=${profile}`,
    `--extensions-dir=${path.join(debugRoot, 'extensions')}`,
    '--skip-welcome',
    '--skip-release-notes',
    ...(test ? [`--extensionTestsPath=${path.join(root, 'test', 'host.js')}`] : []),
    root
  ];
  console.log(
    `Launching ${test ? 'automated tests' : 'EZLlama'} in an isolated VS Code Extension Development Host.\nProfile: ${profile}\nExtension: ${root}\nUse the llama icon in the Activity Bar or run “EZLlama: Open Chat”.`
  );
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, args, {
    stdio: test ? 'inherit' : 'ignore',
    env,
    detached: !test,
    windowsHide: true
  });
  child.on('error', (e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
  if (test)
    child.on('exit', (code) => {
      process.exitCode = code ?? 1;
    });
  else child.unref();
}
main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
