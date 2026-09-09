# Third-party notices

The webview uses local, vendored browser distributions. It does not load scripts from a CDN at runtime.

| Component | Version | Source | License file |
| --- | --- | --- | --- |
| marked | 15.0.12 | https://github.com/markedjs/marked | `media/vendor/marked.LICENSE` (MIT) |
| DOMPurify | 3.4.15 | https://github.com/cure53/DOMPurify | `media/vendor/purify.LICENSE` (Apache-2.0 or MPL-2.0) |
| highlight.js | 11.11.1 | https://github.com/highlightjs/highlight.js | `media/vendor/highlight.LICENSE` (BSD-3-Clause) |

Preset model files are not bundled. Their publishers' model cards and licenses apply when downloaded. The versioned presets link to Qwen's official conversions or the indicated community GGUF repository. llama.cpp is downloaded only through an explicit Settings action; its upstream license remains with its release files.

Implementation references: [VS Code Webview API](https://code.visualstudio.com/api/extension-guides/webview), [llama.cpp server API](https://github.com/ggml-org/llama.cpp/blob/master/tools/server/README.md), and [llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases).
