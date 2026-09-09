'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
// Files that tools may never touch, matching the attachment rules in extension.js.
const SENSITIVE =
  /(^|[\\/])(?:\.env(?:\.[^\\/]*)?|id_rsa|id_ed25519|credentials)(?:$|[\\/])|\.(?:pem|key|p12)$/i;
const IGNORED_DIRECTORIES = new Set(['.git', 'node_modules', '.debug']);
const definitions = [
  {
    name: 'read_file',
    description:
      'Read a UTF-8 text file inside the workspace. Returns numbered lines. Use offset and limit to page through large files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        offset: { type: 'integer', description: 'First line to return (1-based). Default 1.' },
        limit: { type: 'integer', description: 'Maximum lines to return. Default 500.' }
      },
      required: ['path']
    }
  },
  {
    name: 'list_files',
    description:
      'List files and directories inside a workspace directory. Directories end with "/". Hidden VCS and dependency folders are skipped.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the workspace root. Default ".".' },
        depth: { type: 'integer', description: 'Recursion depth, 1–6. Default 2.' }
      }
    }
  },
  {
    name: 'search_files',
    description:
      'Search workspace text files for a literal string (or a regular expression when regex is true). Returns "path:line: text" matches.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'Text or regular expression to find.' },
        path: { type: 'string', description: 'Directory to search. Default ".".' },
        regex: { type: 'boolean', description: 'Interpret pattern as a regular expression.' },
        max_results: { type: 'integer', description: 'Maximum matches, 1–200. Default 50.' }
      },
      required: ['pattern']
    }
  },
  {
    name: 'write_file',
    description:
      'Create or overwrite a text file inside the workspace with the full content. Parent directories are created. Prefer edit_file for small changes to existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        content: { type: 'string', description: 'Complete file content.' }
      },
      required: ['path', 'content']
    }
  },
  {
    name: 'edit_file',
    description:
      'Replace exactly one occurrence of old_text with new_text in a workspace file. old_text must match the file exactly once, so include enough surrounding lines to be unique.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Path relative to the workspace root.' },
        old_text: { type: 'string', description: 'Exact existing text to replace.' },
        new_text: { type: 'string', description: 'Replacement text.' }
      },
      required: ['path', 'old_text', 'new_text']
    }
  },
  {
    name: 'delete_file',
    description: 'Delete a file or an empty directory inside the workspace.',
    parameters: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Path relative to the workspace root.' } },
      required: ['path']
    }
  },
  {
    name: 'run_command',
    description:
      'Run a shell command in the workspace and return its exit code and combined output. Commands cannot be interactive and are killed at the timeout.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The command line to run.' },
        cwd: { type: 'string', description: 'Working directory relative to the workspace root.' },
        timeout_seconds: { type: 'integer', description: 'Override the configured timeout.' }
      },
      required: ['command']
    }
  },
  {
    name: 'ask_user',
    description:
      'Ask the user a question and wait for the answer. Use it when the request is ambiguous or when a decision belongs to the user.',
    parameters: {
      type: 'object',
      properties: {
        question: { type: 'string', description: 'The question to ask.' },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional short answer choices shown as buttons.'
        }
      },
      required: ['question']
    }
  }
];
const READ_ONLY = new Set(['read_file', 'list_files', 'search_files']);
const toolSchemas = () => definitions.map((d) => ({ type: 'function', function: d }));
const systemPrompt = (root) =>
  `\n\nYou can act inside the user's workspace at ${root} with tools: read_file, list_files, search_files, write_file, edit_file, delete_file, run_command, and ask_user. Use paths relative to the workspace root. Inspect files before changing them, prefer edit_file for targeted changes, run commands to verify work, and use ask_user when a decision is the user's to make. Some actions require approval; a denied action returns a message, so adapt rather than repeating it. Report what you changed when you finish.`;
const clamp = (value, min, max, fallback) =>
  Number.isInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
const text = (value, name) => {
  if (typeof value !== 'string') throw new Error(`${name} must be a string.`);
  return value;
};
function summarize(name, args = {}) {
  const p = typeof args.path === 'string' ? args.path : '.';
  switch (name) {
    case 'read_file':
      return `read ${p}`;
    case 'list_files':
      return `list ${p}`;
    case 'search_files':
      return `search for "${String(args.pattern ?? '').slice(0, 80)}"`;
    case 'write_file':
      return `write ${p} (${Buffer.byteLength(String(args.content ?? ''))} bytes)`;
    case 'edit_file':
      return `edit ${p}`;
    case 'delete_file':
      return `delete ${p}`;
    case 'run_command':
      return `run: ${String(args.command ?? '').slice(0, 160)}`;
    case 'ask_user':
      return `ask: ${String(args.question ?? '').slice(0, 120)}`;
    default:
      return name;
  }
}
async function safePath(root, relative, mustExist = false) {
  if (typeof relative !== 'string' || !relative.trim()) throw new Error('A path is required.');
  const realRoot = await fs.realpath(root);
  const inside = (candidate) => {
    const rel = path.relative(realRoot, candidate);
    return rel === '' || (!rel.startsWith('..' + path.sep) && rel !== '..' && !path.isAbsolute(rel));
  };
  const target = path.resolve(realRoot, relative);
  if (!inside(target)) throw new Error(`Path is outside the workspace: ${relative}`);
  if (SENSITIVE.test(target)) throw new Error('Credential files cannot be accessed by tools.');
  // Resolve symbolic links on the deepest existing ancestor so links cannot escape the workspace.
  let existing = target;
  const missing = [];
  for (;;) {
    try {
      existing = await fs.realpath(existing);
      break;
    } catch (e) {
      if (e.code !== 'ENOENT') throw e;
      if (mustExist) throw new Error(`Not found: ${relative}`);
      const parent = path.dirname(existing);
      if (parent === existing) throw e;
      missing.unshift(path.basename(existing));
      existing = parent;
    }
  }
  const file = path.join(existing, ...missing);
  if (!inside(file)) throw new Error('Path resolves outside the workspace through a link.');
  if (SENSITIVE.test(file)) throw new Error('Credential files cannot be accessed by tools.');
  return { file, rel: path.relative(realRoot, file) || '.' };
}
async function readFile(root, args) {
  const { file, rel } = await safePath(root, args.path, true);
  const stat = await fs.stat(file);
  if (!stat.isFile()) throw new Error('Not a file. Use list_files for directories.');
  if (stat.size > 8 * 2 ** 20) throw new Error('File is larger than 8 MiB.');
  const content = await fs.readFile(file, 'utf8');
  if (content.includes('\0')) throw new Error('Binary files cannot be read as text.');
  const lines = content.split(/\r?\n/);
  const offset = clamp(args.offset, 1, Math.max(1, lines.length), 1);
  const limit = clamp(args.limit, 1, 5000, 500);
  const slice = lines.slice(offset - 1, offset - 1 + limit);
  const last = offset + slice.length - 1;
  return (
    `${rel} · ${lines.length} lines · showing ${offset}-${last}${last < lines.length ? ` (more available with offset ${last + 1})` : ''}\n` +
    slice.map((line, i) => `${offset + i}: ${line}`).join('\n')
  );
}
async function listFiles(root, args) {
  const { file, rel } = await safePath(root, args.path || '.', true);
  const depth = clamp(args.depth, 1, 6, 2);
  const rows = [];
  const walk = async (dir, prefix, level) => {
    const entries = (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    );
    for (const entry of entries) {
      if (rows.length >= 500) return;
      if (entry.isDirectory()) {
        rows.push(`${prefix}${entry.name}/`);
        if (level < depth && !IGNORED_DIRECTORIES.has(entry.name))
          await walk(path.join(dir, entry.name), `${prefix}${entry.name}/`, level + 1);
      } else rows.push(`${prefix}${entry.name}`);
    }
  };
  if (!(await fs.stat(file)).isDirectory()) throw new Error('Not a directory.');
  await walk(file, '', 1);
  return `${rel}\n${rows.join('\n')}${rows.length >= 500 ? '\n[listing truncated at 500 entries]' : ''}`;
}
async function searchFiles(root, args) {
  const { file, rel } = await safePath(root, args.path || '.', true);
  const pattern = text(args.pattern, 'pattern');
  if (!pattern) throw new Error('pattern is required.');
  const max = clamp(args.max_results, 1, 200, 50);
  let matcher;
  if (args.regex) {
    try {
      matcher = new RegExp(pattern, 'i');
    } catch (e) {
      throw new Error(`Invalid regular expression: ${e.message}`);
    }
  } else {
    const needle = pattern.toLowerCase();
    matcher = { test: (line) => line.toLowerCase().includes(needle) };
  }
  const results = [];
  const realRoot = await fs.realpath(root);
  let scanned = 0;
  const walk = async (dir) => {
    for (const entry of (await fs.readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name)
    )) {
      if (results.length >= max || scanned > 5000) return;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name)) await walk(full);
        continue;
      }
      if (!entry.isFile() || SENSITIVE.test(full)) continue;
      scanned++;
      if ((await fs.stat(full)).size > 2 ** 20) continue;
      const content = await fs.readFile(full, 'utf8');
      if (content.slice(0, 8192).includes('\0')) continue;
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < max; i++)
        if (matcher.test(lines[i].slice(0, 2000)))
          results.push(`${path.relative(realRoot, full)}:${i + 1}: ${lines[i].slice(0, 300)}`);
    }
  };
  const stat = await fs.stat(file);
  if (stat.isDirectory()) await walk(file);
  else {
    const lines = (await fs.readFile(file, 'utf8')).split(/\r?\n/);
    for (let i = 0; i < lines.length && results.length < max; i++)
      if (matcher.test(lines[i].slice(0, 2000))) results.push(`${rel}:${i + 1}: ${lines[i].slice(0, 300)}`);
  }
  return results.length
    ? `${results.join('\n')}${results.length >= max ? `\n[stopped at ${max} matches]` : ''}`
    : 'No matches.';
}
async function writeFile(root, args) {
  const { file, rel } = await safePath(root, args.path);
  const content = text(args.content, 'content');
  await fs.mkdir(path.dirname(file), { recursive: true });
  let existed = true;
  try {
    if ((await fs.stat(file)).isDirectory()) throw new Error('Path is a directory.');
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    existed = false;
  }
  await fs.writeFile(file, content);
  return `${existed ? 'Overwrote' : 'Created'} ${rel} (${Buffer.byteLength(content)} bytes).`;
}
const count = (haystack, needle) => {
  let n = 0;
  for (let i = haystack.indexOf(needle); i >= 0; i = haystack.indexOf(needle, i + needle.length)) n++;
  return n;
};
async function editFile(root, args) {
  const { file, rel } = await safePath(root, args.path, true);
  let oldText = text(args.old_text, 'old_text'),
    newText = text(args.new_text, 'new_text');
  if (!oldText) throw new Error('old_text is required. Use write_file to create a file.');
  const original = await fs.readFile(file, 'utf8');
  if (original.includes('\0')) throw new Error('Binary files cannot be edited.');
  let haystack = original,
    matches = count(haystack, oldText),
    crlf = false;
  if (!matches && original.includes('\r\n')) {
    // Models usually reproduce LF; match against normalized text and restore CRLF afterwards.
    haystack = original.replace(/\r\n/g, '\n');
    oldText = oldText.replace(/\r\n/g, '\n');
    newText = newText.replace(/\r\n/g, '\n');
    matches = count(haystack, oldText);
    crlf = true;
  }
  if (!matches)
    throw new Error('old_text was not found. Read the file again and copy the exact text.');
  if (matches > 1)
    throw new Error(`old_text matches ${matches} times. Include more surrounding context.`);
  const at = haystack.indexOf(oldText);
  let result = haystack.slice(0, at) + newText + haystack.slice(at + oldText.length);
  if (crlf) result = result.replace(/\n/g, '\r\n');
  await fs.writeFile(file, result);
  const lines = (value) => value.split('\n').length;
  return `Edited ${rel}: replaced ${lines(oldText)} line(s) with ${lines(newText)} line(s).`;
}
async function deleteFile(root, args) {
  const { file, rel } = await safePath(root, args.path, true);
  const stat = await fs.lstat(file);
  if (stat.isDirectory()) {
    if ((await fs.readdir(file)).length) throw new Error('Directory is not empty.');
    await fs.rmdir(file);
    return `Deleted directory ${rel}.`;
  }
  await fs.unlink(file);
  return `Deleted ${rel}.`;
}
async function runCommand(root, args, ctx) {
  const command = text(args.command, 'command');
  if (!command.trim()) throw new Error('command is required.');
  const cwd = args.cwd ? (await safePath(root, args.cwd, true)).file : root;
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error('cwd is not a directory.');
  const timeout =
    clamp(args.timeout_seconds, 1, 3600, ctx.config.commandTimeoutSeconds || 120) * 1000;
  const cap = (ctx.config.maxToolOutputKB || 64) * 1024;
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      env: process.env,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let output = '',
      truncated = false,
      timedOut = false,
      aborted = false;
    const push = (chunk) => {
      if (output.length >= cap) {
        truncated = true;
        return;
      }
      output += chunk;
      if (output.length > cap) {
        output = output.slice(0, cap);
        truncated = true;
      }
    };
    for (const stream of [child.stdout, child.stderr]) stream.setEncoding('utf8').on('data', push);
    const kill = () => {
      if (process.platform === 'win32')
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }).on(
          'error',
          () => {}
        );
      else
        try {
          process.kill(-child.pid, 'SIGKILL');
        } catch {
          child.kill('SIGKILL');
        }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeout);
    const onAbort = () => {
      aborted = true;
      kill();
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });
    const cleanup = () => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
    };
    child.on('error', (e) => {
      cleanup();
      reject(e);
    });
    child.on('close', (code, signal) => {
      cleanup();
      if (aborted) return reject(new Error('Cancelled.'));
      resolve(
        `Exit code: ${code ?? signal}${timedOut ? ` (killed after ${timeout / 1000}s timeout)` : ''}\n${output.trimEnd()}${truncated ? '\n[output truncated]' : ''}`
      );
    });
  });
}
async function execute(name, args, ctx) {
  const handlers = {
    read_file: readFile,
    list_files: listFiles,
    search_files: searchFiles,
    write_file: writeFile,
    edit_file: editFile,
    delete_file: deleteFile,
    run_command: runCommand
  };
  const handler = handlers[name];
  if (!handler) throw new Error(`Unknown tool: ${name}`);
  if (!ctx.root) throw new Error('Open a workspace folder to use tools.');
  return handler(ctx.root, args || {}, ctx);
}
module.exports = { definitions, READ_ONLY, toolSchemas, systemPrompt, summarize, safePath, execute };
