# EZLlama

## Purpose

EZLlama is a minimal VS Code extension that makes `llama.cpp` practical for coding with local AI models. It provides a focused chat experience, simple model-server control, transparent logs, and a small settings surface for configuring models and launch commands.

The extension should feel quiet and polished: one primary workflow, clear status, no unnecessary panels or controls.

## Primary experience

The extension opens in a dedicated VS Code view with three evenly spaced icon tabs at the top:

`[ Chat ]                         [ Console ]                         [ Settings ]`

- **Chat** is the default view for working with an agent.
- **Console** exposes server logs and background activity.
- **Settings** contains command configuration and model management.

The active tab is visually distinct but understated. Tooltips and accessible labels are required for every icon-only control.

## Chat view

### Header

The chat header contains:

- A clear **Start / Stop model** toggle on the left. It shows whether the selected model server is stopped, starting, running, or stopping. Starting and stopping must be cancellable where the underlying process permits it.
- A **model selector** on the right. It lists only valid models configured in Settings, identifies unavailable models, and opens Settings when no model has been configured.

The current server state, selected model, and useful errors must remain understandable without opening the Console.

### Conversation

The conversation should borrow the qualities of the Codex chat interface: clean hierarchy, generous whitespace, compact but readable messages, streaming assistant output, Markdown and code-block rendering, copy controls, and restrained use of borders and color.

Expected chat behavior:

- A scrollable transcript with clear user and assistant message grouping.
- Streaming tokens with an obvious generating state.
- Syntax-highlighted code blocks with copy actions.
- Support for Markdown, diffs where useful, file references, and error/result messages.
- A chat title/history mechanism, with **New chat**, clear-chat confirmation, and a way to revisit prior local conversations.
- Sending is disabled when no server is ready, while the reason and next action are visible.

### Agent tools

The selected model can act inside the open workspace through function calling: read, list, and search files; create, edit, and delete files; run shell commands; and ask the user questions. Each tool call is shown inline in the transcript with its arguments, status, and result, and tool output takes part in context accounting and compaction.

Protected actions are gated by a per-tool **allow / ask / deny** permission. When a tool asks, the composer's **Manual / Auto** approval mode decides who answers:

- **Manual** shows an inline prompt with **Yes**, **Yes, don't ask again**, and **No**.
- **Auto** sends the same question to a reviewer model, which must answer with one of those three verdicts. The reviewer runs the same model in a fresh context by default or a separately configured model.

"Don't ask again" lasts for the current VS Code session and can be reset. Tools require a trusted workspace, never leave it, and never touch credential files. Settings expose the tool switch, approval mode, reviewer strategy and model, per-tool permissions, command timeout, output cap, and round limit.

### Composer toolbar

Place the standard coding-chat controls directly above the chat input. Keep them compact and hide less common controls in an overflow menu on narrow widths.

- New chat / clear chat
- Attach or reference workspace files
- Include current editor selection
- Model or agent mode indicator
- Temperature and max-output controls (or a compact settings popover)
- Stop generation
- Send message
- **Compact chat** button
- **Auto compact at context limit** toggle, immediately to the right of Compact

The composer supports multiline input, Enter to send, Shift+Enter for a newline, and clear keyboard focus behavior.

### Context compaction

Manual compaction creates a concise working summary of the current conversation and begins a new internal context from that summary. The UI continues to present this as one continuous chat, with an unobtrusive marker showing when compaction occurred.

When **Auto compact at context limit** is enabled, EZLlama must:

1. Detect when the current request would exceed, or has reached, the active model context limit.
2. Pause the current turn safely and preserve the transcript.
3. Compact the conversation using either the same model in a fresh context or a separately configured compaction model.
4. Start a fresh context using the original model, seed it with the compacted summary and any needed active task state, then continue the interrupted work where possible.
5. Keep the user in the same visible conversation and report meaningful progress or failures inline.

Settings must let users choose the compaction strategy, define a reserved context buffer, select an optional compaction model, inspect the generated summary, retry failed compactions, and turn the feature off. The feature must never silently discard transcript content.

## Console view

The Console is a read-only, searchable log viewer for the `llama.cpp` server and extension activity. It should make background behavior understandable without becoming a terminal emulator.

Include:

- Timestamped, levelled log lines (info, warning, error, debug).
- Filters for source and level, plus text search.
- Copy, clear-visible-log, and export-log actions.
- Automatic scrolling with a pause-follow control.
- Clear lifecycle events: resolved command, server start/stop, selected model, download/validation status, request failures, context-compaction events, and diagnostics.
- Redaction of secrets and user-configured sensitive command arguments before display or export.

## Settings view

Settings are grouped in a simple vertical layout. Changes should validate before use, persist in VS Code settings or extension storage as appropriate, and provide inline errors rather than modal interruptions.

The **Save changes** control stays pinned at the top of the view while the sections scroll beneath it. A narrow bar on the right lists the section titles; clicking one jumps to that section, and the title of the section currently in view is highlighted while scrolling. Transient notifications overlay the top of the view rather than reflowing the content below them.

### Command Config

This section appears first.

Users can choose one of two ways to configure the `llama.cpp` server launch command:

1. **Manual command** — an editable start-command field, with argument validation, a preview of the resolved executable and arguments, and a test/start action.
2. **Generate optimal command** — a button that detects relevant local hardware and generates a recommended command tailored to the machine. Recommendations should consider OS, CPU, available RAM, GPU availability and VRAM, backend support, model metadata, context length, thread count, batch settings, GPU-layer offload, and the installed `llama.cpp` binary capabilities.

Generated commands are always reviewable and editable before they are saved or run. Detection failures must fall back to a safe CPU-oriented recommendation and explain what could not be determined.

The command configuration also has a **One Command / Per Model** mode selector:

- **One Command** is the default and shows one editable server command and argument set used for every model.
- **Per Model** replaces the single command editor with a table of model-specific command configurations. Each row selects one already-added model and provides its custom server command and flags. A model can appear only once, and rows remain linked to the model configuration if its label or path changes.
- Per Model mode includes an **Add model command** control that only offers models from the Models table that do not already have a row.
- Per Model mode also provides an **Add Otherwise** control. The user may add exactly one **Otherwise** row, which serves as the default command configuration for any configured model not listed in the table. Once present, the Add Otherwise control is unavailable; the fallback row can be edited or removed.

Every row provides validation, resolved-command preview, test/start action, and removal. When Per Model is active, a model-specific row wins over Otherwise; if neither exists, the model is shown as having no usable command configuration rather than silently using an unrelated command.

### llama.cpp installation

Add a **llama.cpp installation** section near Command Config. It controls where EZLlama obtains the server binary and offers three mutually exclusive choices:

1. **Auto-install llama.cpp** — selected by default for new installations. This preference does **not** download or install anything when the extension is installed, opened, or updated. The user must explicitly press a separate **Download llama.cpp** button in Settings before EZLlama fetches a compatible release. The button explains the target version, platform, download location, and estimated size before the download begins, then shows progress, verification, and the installed version.
2. **Use llama.cpp on PATH** — detects an existing `llama.cpp` executable available through the user’s environment `PATH`, displays the resolved path and version, and provides a recheck action. It must report a clear validation error when no compatible executable is found.
3. **Use a custom llama.cpp directory** — lets the user provide a directory containing their own `llama.cpp` executable. Validate the directory, resolve the executable, show its version and capabilities, and provide a browse and recheck action.

The selected source becomes the executable used for command validation and server launches. Users can change it at any time, but EZLlama must not replace, modify, or delete a user-managed PATH/custom installation. An auto-installed copy can be updated or removed only through explicit Settings actions.

Also include controls for working directory, environment variables, server port/host, API compatibility options, launch-on-open, automatic restart behavior, and diagnostics verbosity.

### Models

Models are managed in a table. Show an **Add model** (`+`) control directly below the final row, or at the top when the table is empty. Selecting Add immediately inserts a new editable row and focuses it.

Provide an **Add from recommended** button next to Add model. It opens a small preset picker containing ten curated, beginner-friendly local coding-model configurations spanning low-end to high-end hardware. Order the presets by increasing expected hardware requirement and clearly show the model family, parameter size/quantization, expected disk use, recommended RAM/VRAM, intended use, source, and any practical limitations. Choosing a preset adds an editable model row populated with its remote source and sensible default `llama.cpp` settings; it does not begin a download until the user explicitly presses Download. Presets should be maintained as versioned extension data and can be refreshed when the extension updates.

Each row includes:

- Model name / display label
- **Model path or model identifier** field
- Source dropdown immediately to the right of that field, including at least **Local**, **Hugging Face**, and extensible remote-source options
- Relevant model parameters such as context length, chat template, and optional overrides
- Edit and remove actions
- A right-aligned status/action area

For a remote source, the right-side action is **Download**. It downloads to a configured local model directory, reports progress and errors, validates the completed artifact, and converts the row to a usable local model reference. For a valid local model or successfully validated download, replace Download with a checkmark. The checkmark must have an accessible label and expose validation details on hover or selection.

Removing a model requires confirmation only if it will delete a locally downloaded artifact; removing the configuration alone should be reversible through normal VS Code settings/history behavior where available.

### Additional settings

Provide sensible, minimal controls for:

- Default model and default chat/system prompt
- Local models/download directory and disk-space safeguards
- Model validation and checksum behavior
- Request timeout, retries, streaming, and concurrency limits
- Chat storage, retention, export, and delete-all-conversations actions
- Context window defaults, token counting, compaction policy, and compaction model
- Editor/workspace context permissions and file-size limits
- Privacy controls, telemetry/logging choice, and redaction rules
- Accessibility preferences, including font size and reduced motion

## System behavior

- Run `llama.cpp` as a managed local process and surface its lifecycle accurately.
- Never block VS Code while launching, downloading, validating, generating, or compacting.
- Keep process output available in Console and emit actionable failure messages in Chat.
- Validate the selected llama.cpp source, executable paths, model paths, ports, download destinations, and server readiness before presenting a model as available. Never download llama.cpp automatically; an auto-install preference only enables the user-initiated download flow in Settings.
- Store configuration using VS Code’s configuration APIs; store chat history and ephemeral operational state in extension storage. Do not place secrets in logs or chat exports.
- Degrade gracefully when no GPU is present, no model exists, `llama.cpp` is unavailable, a remote source is offline, or a download fails.

## Design principles

- Minimal by default; advanced options remain available without crowding the main workflow.
- Fast feedback: every long-running action shows state, progress, and a useful outcome.
- Local-first and transparent: users can see the exact command, model source, logs, and current server state.
- Preserve user work: never lose a transcript because a model stops, a request fails, or context is compacted.
- Match VS Code’s theme, keyboard conventions, and accessibility expectations.

## Initial acceptance criteria

1. A user can add a valid local model, choose it in Chat, start its `llama.cpp` server, and exchange streaming messages.
2. A user can inspect server and extension activity in a searchable Console view.
3. A user can choose auto-install (the default), PATH, or a custom llama.cpp directory. Selecting auto-install alone performs no download; the user must explicitly use the Download llama.cpp button. PATH and custom-directory choices show a validated executable path and version.
4. A user can either edit the server launch command or generate, review, edit, and save a hardware-aware recommendation.
5. A user can add a remote model, download it with progress feedback, validate it, and see a checkmark when it is ready.
6. A user can select from ten ordered recommended model presets, add one as an editable configuration, and confirm no download occurs until Download is explicitly pressed.
7. A user can use one shared server command or switch to per-model commands, configure an individual added model, and optionally set exactly one Otherwise fallback for every unlisted model.
8. A user can compact a conversation manually. With auto compact enabled, the extension preserves the visible conversation, summarizes prior context, and continues in a fresh model context when the context limit is reached.
9. The interface retains the three top-level icon tabs and remains clean at common VS Code sidebar widths.
