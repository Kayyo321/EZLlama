# EZLlama

A local-first VS Code coding chat for `llama.cpp`, implemented from [PROJECT.md](PROJECT.md).

## Try the extension

Requirements: VS Code 1.95 or newer and Node.js 20 or newer for the debug launcher. There is no build step and no runtime package installation.

From this folder in PowerShell:

```powershell
.\debug.ps1
```

Alternatively, double-click `debug.cmd`, run `node scripts/debug.js`, or press **F5** with the **Debug EZLlama** launch configuration selected.

The script opens a separate VS Code **Extension Development Host** with this folder loaded as a temporary extension. Its profile and installed extensions are isolated under `.debug/development`; your regular VS Code profile is unaffected. The development profile trusts this project so the local process controls work. The extension is not installed globally. Close that VS Code window to end the session; the managed model process is stopped on extension shutdown. Relaunch the script after host-side code changes, or run **Developer: Reload Window** in the development host.

If VS Code is installed in a nonstandard location:

```powershell
$env:VSCODE_EXECUTABLE = 'D:\Apps\VSCode\Code.exe'
.\debug.ps1
```

Select the llama icon in the Activity Bar, or run **EZLlama: Open Chat** from the Command Palette.

1. Open **Settings → llama.cpp installation**. Choose Auto-install, PATH, or a custom directory, then **Save changes**. Auto-install alone does not download anything. **Download llama.cpp…** first shows the exact release, platform, size, destination, and verification policy; its second button starts the download. The automatic Windows release is a conservative CPU build. For CUDA, Vulkan, ROCm, or another backend, select a compatible custom build.
2. Under **Models**, add a local `.gguf`, or choose one of the ten recommended configurations, save, and explicitly press **Download**. Hugging Face identifiers use `owner/repository/path/to/file.gguf`. HTTPS URLs are also supported. A ready checkmark indicates GGUF header validation; its tooltip explains checksum coverage. llama.cpp performs the full model load and tensor compatibility check on startup.
3. Review the command. The default works with a local model. **Generate optimal command** detects CPU, memory, installed backend/device support, available NVIDIA VRAM when accessible, and bounded GGUF metadata. It edits the draft only; review it before saving or running it.
4. Choose the model in **Chat**, press **Start model**, and send a message once the server reports ready.

## Features

- Three accessible, theme-aware Chat, Console, and Settings tabs that fit a narrow sidebar.
- Streaming Markdown, highlighted code and diffs, copy controls, local file links, chat titles/history, exports, and confirmed destructive history actions.
- Explicit workspace-file and selection attachments, size limits, credential-file exclusions, and a workspace-context permission switch.
- Agent tools: the model can read, list, search, create, edit, and delete workspace files, run shell commands, and ask you questions through llama.cpp function calling (`--jinja` is added automatically when the binary supports it). Every call appears in the transcript with its arguments and result. Reads are allowed by default; writes, edits, deletes, and commands ask first. The **Manual / Auto** toggle above the composer chooses who answers: you (Yes / Yes, don't ask again / No) or a reviewer model that returns the same verdicts in a fresh context, optionally on a separately configured model. Per-tool allow/ask/deny, timeouts, output caps, and round limits live under **Settings → Agent tools**. Tools require an open, trusted workspace and never leave it or touch credential files.
- Managed server startup, cancellation, readiness polling, stop, occupied-port checks, optional bounded restart, and loopback-only connections.
- Shared command or per-model command rows keyed by stable model IDs, with exactly one optional Otherwise fallback. Installation source determines the executable. Shell pipelines/operators are not executed. Host, port, model, context, and one server slot are managed consistently.
- Explicit model downloads with byte progress, cancellation, disk reserves, temporary files, GGUF validation, and optional/required SHA-256 checks. Existing files are never overwritten. Removing a model row removes only its configuration and retains its file; **Discard edits** reverses an unsaved removal, and saved configuration is available in VS Code user settings/history.
- Explicit, checksum-verified GitHub release installation, updates through the same reviewed download flow, and confirmed removal limited to EZLlama-managed copies. PATH/custom installations are never modified.
- Manual and automatic context compaction with chunked fresh-context summaries, an optional separate compaction model, summary inspection, retry, and automatic restoration of the original model. Compaction commits only when the whole summary succeeds; the full visible transcript remains intact. If the current request alone cannot fit, the error asks you to shorten it or increase context.
- Timestamped, searchable, source/level-filtered logs, follow/pause, copying, clearing visible rows, and export. API keys and Hugging Face tokens use VS Code Secret Storage. No extension telemetry and no CDN requests from the webview.

## Configuration and storage

The Settings tab validates and writes the `ezllama.config` object using VS Code's configuration API at user/machine scope. Executable lookup and model readiness are checked before launch. Generation, timeout/retry, storage/retention, downloads/checksums, compaction, accessibility, and redaction options are exposed in the advanced sections.

Chats are stored atomically in `chats.json` under the extension's VS Code global-storage directory, separate from this repository. Streaming partial output is periodically checkpointed and saved on completion/cancellation. The retention setting caps conversations persisted to disk. Saving with history disabled clears persisted history while retaining the current in-memory session. **Delete all conversations** clears the session and persisted history. Corrupt history is backed up before recovery. Diagnostic logs stay in memory and are capped at 5,000 lines.

Redaction covers configured secrets, common credential patterns, environment variable secrets, user-named sensitive flags, and user-supplied **literal strings**. It is applied before logging and exports. User-authored chat content remains local in chat storage; do not paste sensitive material you do not want stored there. API secrets belong in the dedicated Secret Storage controls, rather than ordinary settings or command text.

Token accounting uses `/tokenize` with a chat-template margin and a conservative UTF-8 byte fallback. Server context-overflow responses trigger the same safe compaction path. Actual template overhead can vary, so keep a reserved buffer. Hardware recommendations are conservative estimates, not performance benchmarks. Only single-file GGUF models and one simultaneous generation are currently supported; sharded GGUF downloads and automatic code execution are outside this interface.

## Development and verification

```powershell
node scripts/check.js
node --test test/*.test.js
.\debug.ps1 -Test
```

The test suite covers command precedence and quoting, configuration validation, secret redaction, malformed/cancelled downloads, checksum failures, GGUF checks, SSE boundaries and broken streams, context compaction and recovery, plus real child-process readiness, cancellation, shutdown, and occupied ports. The Extension Host test uses your installed VS Code in `.debug/test` and confirms activation, commands, and initial no-download behavior.

Optional browser integration tests need Playwright:

```powershell
npm install --no-save playwright
npx playwright install chromium
node test/ui.js
```

They exercise the model/preset editor, command fallback, tabs, Markdown sanitization/highlighting/copy, keyboard composer, log filters, and a 260px sidebar. Screenshots are saved to `.debug/screenshots`. `EZLLAMA_PLAYWRIGHT` can point at an existing Playwright package directory.

The automated server tests use a small local fixture rather than downloading a model. Real model inference must be tested with your chosen GGUF and llama.cpp build. No models or llama.cpp binaries are downloaded during activation or tests.

## Repository

The local `main` branch tracks the existing GitHub branch `origin` at `https://github.com/Kayyo321/EZLlama.git`. This is the remote's existing branch name, not a second remote. No push is needed to run the extension locally.

Runtime implementation lives in `src/`; the webview and vendored rendering libraries are in `media/`; ordered preset data is in `data/presets.json`. Vendor licenses and exact versions are recorded in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
