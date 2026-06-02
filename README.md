# Comparo

> MCP server that orchestrates Claude Code, Codex CLI, and Gemini CLI for cross-validation.

[![CI](https://github.com/stouffer-labs/Comparo/actions/workflows/ci-typescript.yml/badge.svg)](https://github.com/stouffer-labs/Comparo/actions/workflows/ci-typescript.yml)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

Comparo runs independent AI CLI reviewers (Claude, Codex, Gemini) as background jobs to
cross-validate code and designs, then consolidates their findings. It exposes this as MCP
tools so any MCP-capable CLI can request a second opinion.

## Install

### macOS / Linux (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/stouffer-labs/Comparo/main/scripts/install.sh | bash
```

Installs Comparo to `~/.local/share/comparo`, links `comparo` into `~/.local/bin`, and
registers the MCP server in any detected CLIs (Claude, Codex, Gemini).

### Windows

```bash
npm install -g comparo
comparo mcp setup
```

(Comparo's Codex adapter automatically uses stdin on Windows to avoid the `cmd.exe` shim's
command-length cap and metacharacter mangling.)

## Quick Start

```bash
# Register the MCP server in your CLIs (idempotent)
comparo mcp setup

# Check provider health
comparo doctor
```

Once registered, call the `comparo_deep_review` / `comparo_check` MCP tools from your CLI.

## How it works

- `src/providers/` — one adapter per CLI (claude, codex, gemini)
- `src/engines/` — review orchestration (parallel reviews, race, consolidate)
- `src/mcp/` — MCP server + tool handlers
- Reviews are fire-and-forget background jobs; callers poll with `comparo_check`.
- Session artifacts are written to `<cwd>/.comparo/` of the project being reviewed.

## Development

```bash
npm ci
npm run build
npm test
npm run lint
```

## Documentation

Full documentation: [stouffer-labs.github.io](https://stouffer-labs.github.io).

## Contributing

See the org [Contributing Guide](https://github.com/stouffer-labs/.github/blob/main/CONTRIBUTING.md).

## License

Apache-2.0 — see [LICENSE](LICENSE).
